import { applyAudioResourceUpdate, isDedicatedWorker, SongRenderer } from "./audio";
import type { AudioResourceUpdate } from "./audio";
import { AudioThreadPool } from "./audio-thread-pool";
import { required } from "./model";
import type { Song } from "./model";
import { usesUpstreamSynth } from "./synth/adapter";

export type ExportCommand = {
  song: Song;
  sampleRate: number;
  threadCount: number;
  sequence: number[];
  format: "mp3" | "wav";
  resources: AudioResourceUpdate[];
};
export type ExportResult = { buffer: ArrayBuffer; mime: "audio/mpeg" | "audio/wav" };
export type ExportReply =
  | { type: "error"; message: string }
  | { type: "progress"; progress: number }
  | (ExportResult & { type: "complete" });

type BlockEncoder = {
  append: (left: Float32Array, right: Float32Array) => void;
  finish: () => ArrayBuffer;
};
const pcmSample = (sample: number): number => {
  const value = Math.max(-1, Math.min(1, sample));
  return Math.round(value * (value < 0 ? 32_768 : 32_767));
};
const joinChunks = (chunks: readonly Uint8Array[], length: number): ArrayBuffer => {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output.buffer;
};
export const createWavEncoder = (sampleRate: number): BlockEncoder => {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  return {
    append: (left, right): void => {
      if (bytes + left.length * 4 > 4_294_967_295 - 36) {
        throw new Error("Audio export is too large for a WAV file.");
      }
      const chunk = new Uint8Array(left.length * 4);
      const view = new DataView(chunk.buffer);
      for (let frame = 0; frame < left.length; frame++) {
        view.setInt16(frame * 4, pcmSample(left[frame] ?? 0), true);
        view.setInt16(frame * 4 + 2, pcmSample(right[frame] ?? 0), true);
      }
      chunks.push(chunk);
      bytes += chunk.length;
    },
    finish: (): ArrayBuffer => {
      const header = new Uint8Array(44);
      const view = new DataView(header.buffer);
      const write = (offset: number, value: string): void => {
        for (let index = 0; index < value.length; index++) {
          view.setUint8(offset + index, required(value.codePointAt(index)));
        }
      };
      write(0, "RIFF");
      view.setUint32(4, 36 + bytes, true);
      write(8, "WAVE");
      write(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 2, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 4, true);
      view.setUint16(32, 4, true);
      view.setUint16(34, 16, true);
      write(36, "data");
      view.setUint32(40, bytes, true);
      return joinChunks([header, ...chunks], bytes + header.length);
    },
  };
};
export const createMp3Encoder = async (sampleRate: number): Promise<BlockEncoder> => {
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const encoder = new Mp3Encoder(2, sampleRate, 192);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const append = (chunk: Uint8Array): void => {
    if (chunk.length > 0) {
      chunks.push(Uint8Array.from(chunk));
      bytes += chunk.length;
    }
  };
  return {
    append: (left, right): void => {
      const pcmLeft = new Int16Array(left.length);
      const pcmRight = new Int16Array(right.length);
      for (let frame = 0; frame < left.length; frame++) {
        pcmLeft[frame] = pcmSample(left[frame] ?? 0);
        pcmRight[frame] = pcmSample(right[frame] ?? 0);
      }
      // LAME keeps its own MPEG frame buffering across arbitrary PCM blocks.
      append(encoder.encodeBuffer(pcmLeft, pcmRight));
    },
    finish: (): ArrayBuffer => {
      append(encoder.flush());
      return joinChunks(chunks, bytes);
    },
  };
};

// Large blocks amortize worker messages. No output clock or playback queue paces
// this loop: the same track/global/master synthesis runs as fast as workers finish.
const blockFrames = 8192;
const checkAbort = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw new DOMException("Audio export cancelled.", "AbortError");
  }
};
export const renderAudioExport = async (
  command: ExportCommand,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<ExportResult> => {
  checkAbort(signal);
  for (const update of command.resources) {
    applyAudioResourceUpdate(update);
  }
  const { song } = command;
  const renderer = new SongRenderer(song, command.sampleRate, 0, command.sequence, {
    channelIds: new Set(),
  });
  // A few plain native tracks now render faster locally than worker startup
  // and block messaging. The preference is a maximum, not a required pool size.
  const lightweight =
    song.channels.length > 0 &&
    song.channels.length <= 4 &&
    song.channels.every((channel) => {
      const [instrument] = channel.instruments;
      return (
        channel.kind === "track" &&
        channel.effects.length === 0 &&
        channel.instruments.length === 1 &&
        instrument !== undefined &&
        usesUpstreamSynth(instrument) &&
        instrument.effects.length === 0 &&
        instrument.envelopes.length === 0
      );
    });
  const pool = new AudioThreadPool(
    {
      song,
      sampleRate: command.sampleRate,
      threadCount: lightweight ? 1 : command.threadCount,
      sequence: command.sequence,
      bar: renderer.bar,
      beat: renderer.beat,
      clock: renderer.transportClock,
      playing: true,
      recording: false,
      muted: [],
    },
    command.resources,
  );
  try {
    onProgress(0);
    const encoder =
      command.format === "mp3"
        ? await createMp3Encoder(command.sampleRate)
        : createWavEncoder(command.sampleRate);
    const maxSamples =
      Math.ceil(command.sequence.length * song.beatsPerBar * 60 * command.sampleRate) +
      command.sampleRate;
    let total = 0;
    while (renderer.playing) {
      checkAbort(signal);
      const { left, right } = await pool.renderBlock(renderer, blockFrames, true);
      total += left.length;
      if (total > maxSamples || left.length === 0) {
        throw new Error("Audio export exceeded its finite sequence.");
      }
      encoder.append(left, right);
      const { sequenceIndex } = renderer.transportClock;
      const progress = (sequenceIndex + renderer.beat / song.beatsPerBar) / command.sequence.length;
      onProgress(Math.min(0.99, progress));
    }
    checkAbort(signal);
    const buffer = encoder.finish();
    checkAbort(signal);
    onProgress(1);
    return { buffer, mime: command.format === "mp3" ? "audio/mpeg" : "audio/wav" };
  } finally {
    pool.close();
    renderer.reset();
  }
};

export const handleAudioExport = async (
  command: ExportCommand,
  reply: (message: ExportReply) => void,
  signal?: AbortSignal,
): Promise<void> => {
  try {
    const result = await renderAudioExport(
      command,
      (progress) => {
        reply({ type: "progress", progress });
      },
      signal,
    );
    reply({ type: "complete", ...result });
  } catch (error) {
    reply({ type: "error", message: String(error) });
  }
};

declare const postMessage: (reply: ExportReply, transfer: Transferable[]) => void;

if (isDedicatedWorker()) {
  addEventListener("message", ({ data }: MessageEvent<ExportCommand>) => {
    void handleAudioExport(data, (reply) => {
      postMessage(reply, reply.type === "complete" ? [reply.buffer] : []);
    });
  });
}
