import { hasAudioResource, snapshotAudioResources } from "./audio";
import type { ExportCommand, ExportReply, ExportResult } from "./audio-export-worker";
import { exportSequence } from "./formats";
import type { ExportOptions } from "./formats";
import type { Song } from "./model";
import { normalizeAudioThreads, readPreferences } from "./preferences";

export type RenderOptions = ExportOptions & {
  muted?: ReadonlySet<string>;
  sampleRate?: number;
  threadCount?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
};

const cancelled = (): DOMException => new DOMException("Audio export cancelled.", "AbortError");
const checkCancellation = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) {
    throw cancelled();
  }
};
const renderInWorker = async (
  command: ExportCommand,
  options: RenderOptions,
): Promise<ExportResult> => {
  const worker = new Worker(new URL("./audio-export-worker.js", document.baseURI), {
    type: "module",
  });
  const listeners = new AbortController();
  const listen = { signal: listeners.signal };
  try {
    return await new Promise<ExportResult>((resolve, reject) => {
      worker.addEventListener(
        "error",
        (event) => {
          event.preventDefault();
          reject(new Error(event.message || "Audio export worker failed."));
        },
        listen,
      );
      worker.addEventListener(
        "messageerror",
        () => {
          reject(new Error("Could not receive the exported audio."));
        },
        listen,
      );
      worker.addEventListener(
        "message",
        ({ data }: MessageEvent<ExportReply>) => {
          switch (data.type) {
            case "complete": {
              resolve(data);
              break;
            }
            case "error": {
              reject(new Error(data.message));
              break;
            }
            case "progress": {
              options.onProgress?.(Math.min(0.99, data.progress));
              break;
            }
          }
        },
        listen,
      );
      options.signal?.addEventListener(
        "abort",
        () => {
          reject(cancelled());
        },
        listen,
      );
      checkCancellation(options.signal);
      worker.postMessage(command, []);
    });
  } finally {
    listeners.abort();
    worker.terminate();
  }
};

const renderAudio = async (
  song: Song,
  format: "mp3" | "wav",
  options: RenderOptions,
): Promise<Blob> => {
  checkCancellation(options.signal);
  // Muted channels stay out of the snapshot throughout the export.
  const snapshot = structuredClone({
    ...song,
    channels: song.channels.filter((channel) => options.muted?.has(channel.id) !== true),
  });
  const resources = new Set<string>();
  for (const channel of snapshot.channels) {
    if (channel.kind !== "track") {
      continue;
    }
    for (const instrument of channel.instruments) {
      if (
        (instrument.type === "SoundFont" ||
          (instrument.type === "chip wave" && instrument.resourceId)) &&
        !hasAudioResource(instrument.resourceId)
      ) {
        throw new Error(
          `Missing audio resource for ${instrument.name}. Relink it in Add Assets before exporting.`,
        );
      }
      resources.add(instrument.resourceId);
    }
  }
  const sampleRate = options.sampleRate ?? 44_100;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 384_000) {
    throw new Error("Audio export requires a valid sample rate.");
  }
  const threadCount = options.threadCount ?? (await readPreferences()).audioThreads;
  checkCancellation(options.signal);
  const command: ExportCommand = {
    song: snapshot,
    format,
    sampleRate,
    threadCount: normalizeAudioThreads(threadCount),
    sequence: exportSequence(snapshot, options),
    resources: snapshotAudioResources(resources),
  };
  const result = await renderInWorker(command, options);
  checkCancellation(options.signal);
  const blob = new Blob([result.buffer], { type: result.mime });
  options.onProgress?.(1);
  return blob;
};

export const renderWav = async (song: Song, options: RenderOptions = {}): Promise<Blob> =>
  await renderAudio(song, "wav", options);
export const renderMp3 = async (song: Song, options: RenderOptions = {}): Promise<Blob> =>
  await renderAudio(song, "mp3", options);
