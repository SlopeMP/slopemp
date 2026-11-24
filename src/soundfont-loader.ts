import { installSoundFont } from "./audio";
import { createSampleBuffer } from "./shared-samples";
import {
  compressedSampleFlag,
  decodePCMSoundFont,
  isCompressed,
  parseSoundFont,
  readPCM,
} from "./synth/soundfont-file";
import type { SFSample, SoundFont, SoundFontFile, SoundFontPreset } from "./synth/soundfont-file";

const oggSignature = 1_332_176_723; // "OggS" in big-endian bytes.
const oggSample = (data: DataView, start: number, end: number): Uint8Array => {
  // Writers use both inclusive and exclusive byte ends. Read through the Ogg end-of-stream page.
  const limit = Math.min(end + 1, data.byteLength);
  for (let offset = start; offset + 27 <= limit;) {
    if (data.getUint32(offset) !== oggSignature) {
      break;
    }
    const flags = data.getUint8(offset + 5);
    const segmentCount = data.getUint8(offset + 26);
    const segments = offset + 27;
    offset = segments + segmentCount;
    if (offset > limit) {
      break;
    }
    for (let index = segments; index < segments + segmentCount; index++) {
      offset += data.getUint8(index);
    }
    if (offset > limit) {
      break;
    }
    if ((flags & 4) !== 0 && offset >= end) {
      return new Uint8Array(data.buffer, data.byteOffset + start, offset - start);
    }
  }
  throw new Error("Invalid Ogg Vorbis sample data.");
};

export const decodeSoundFont = async (
  file: SoundFontFile,
  signal?: AbortSignal,
): Promise<SoundFont> => {
  signal?.throwIfAborted();
  const compressed = file.headers.filter(isCompressed);
  if (compressed.length === 0) {
    return decodePCMSoundFont(file);
  }

  const pcmBytes = compressed.reduce(
    (firstByte, header) => Math.min(firstByte, header.start),
    file.sampleData.byteLength,
  );
  const pcmFrames = pcmBytes / 2;
  if (
    !Number.isInteger(pcmFrames) ||
    file.headers.some((h) => !isCompressed(h) && h.end > pcmFrames)
  ) {
    throw new Error("Invalid SoundFont PCM sample data.");
  }
  // Bun otherwise drops the worker export but leaves its initialization in the bundle.
  const { OggVorbisDecoder } = { ...(await import("@wasm-audio-decoders/ogg-vorbis")) };
  const decoder = new OggVorbisDecoder();
  const decoded = new Map<string, { start: number; frames: Float32Array }>();
  const headers: SFSample[] = [];
  let sampleCount = pcmFrames;
  try {
    await decoder.ready;
    signal?.throwIfAborted();
    for (const header of file.headers) {
      signal?.throwIfAborted();
      if (!isCompressed(header)) {
        headers.push(header);
        continue;
      }
      const key = `${header.start}:${header.end}`;
      let sample = decoded.get(key);
      if (!sample) {
        const data = oggSample(file.sampleData, header.start, header.end);
        const { channelData, errors } = await decoder.decodeFile(data);
        signal?.throwIfAborted();
        const [frames] = channelData;
        if (errors.length > 0 || channelData.length !== 1 || !frames || frames.length === 0) {
          throw new Error("Invalid mono Vorbis sample data.");
        }
        sample = { start: sampleCount, frames };
        decoded.set(key, sample);
        // Keep neighboring samples out of interpolation at the end of this sample.
        sampleCount += frames.length + 46;
      }
      headers.push({
        ...header,
        start: sample.start,
        end: sample.start + sample.frames.length,
        loopStart: sample.start + Math.min(header.loopStart, sample.frames.length),
        loopEnd: sample.start + Math.min(header.loopEnd, sample.frames.length),
        type: header.type & ~compressedSampleFlag,
      });
    }
  } finally {
    decoder.free();
  }
  signal?.throwIfAborted();
  const samples = createSampleBuffer(sampleCount);
  readPCM(file, samples, pcmFrames);
  for (const { start, frames } of decoded.values()) {
    samples.set(frames, start);
  }
  return { samples, headers, presets: file.presets };
};

const waitingLoads: Array<() => void> = [];
let loading = false;
const releaseLoad = (): void => {
  const next = waitingLoads.shift();
  if (next) {
    next();
  } else {
    loading = false;
  }
};
const acquireLoad = async (signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  if (!loading) {
    loading = true;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const pending = {
      start: (): void => {
        signal?.removeEventListener("abort", pending.abort);
        resolve();
      },
      abort: (): void => {
        waitingLoads.splice(waitingLoads.indexOf(pending.start), 1);
        const reason: unknown = signal?.reason;
        reject(
          reason instanceof Error
            ? reason
            : new DOMException("SoundFont load cancelled.", "AbortError"),
        );
      },
    };
    waitingLoads.push(pending.start);
    signal?.addEventListener("abort", pending.abort, { once: true });
  });
};

export const loadSoundFont = async (
  id: string,
  source: ArrayBuffer | string,
  signal?: AbortSignal,
): Promise<SoundFontPreset[]> => {
  // Fetch inside the queue so many assets cannot hold compressed data and
  // temporary decoded samples in memory at the same time.
  await acquireLoad(signal);
  try {
    signal?.throwIfAborted();
    const data =
      typeof source === "string"
        ? await fetch(source, { signal: signal ?? null }).then(
            async (response): Promise<ArrayBuffer> => {
              if (!response.ok) {
                throw new Error(`Could not load SoundFont (${response.status}).`);
              }
              return await response.arrayBuffer();
            },
          )
        : source;
    signal?.throwIfAborted();
    const font = await decodeSoundFont(parseSoundFont(data), signal);
    signal?.throwIfAborted();
    return installSoundFont(id, font);
  } finally {
    releaseLoad();
  }
};
