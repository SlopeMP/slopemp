import { renderMp3 as exportMp3, renderWav as exportWav } from "../../src/audio-export";
import type { RenderOptions } from "../../src/audio-export";
import { handleAudioExport } from "../../src/audio-export-worker";
import type { ExportCommand } from "../../src/audio-export-worker";
import type { Song } from "../../src/model";

// Exercise the public worker protocol while running synthesis in the test process.
const render = async (
  exporter: typeof exportWav,
  song: Song,
  options: RenderOptions = {},
): Promise<Blob> => {
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  class ExportWorker extends EventTarget {
    private readonly controller = new AbortController();

    public postMessage(command: ExportCommand): void {
      void handleAudioExport(
        structuredClone(command),
        (data) => {
          this.dispatchEvent(new MessageEvent("message", { data }));
        },
        this.controller.signal,
      );
    }

    public terminate(): void {
      this.controller.abort();
    }
  }
  Object.assign(globalThis, { Worker: ExportWorker, document: { baseURI: "http://localhost/" } });
  try {
    return await exporter(song, { ...options, threadCount: 1 });
  } finally {
    for (const [name, descriptor] of [
      ["Worker", previousWorker],
      ["document", previousDocument],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  }
};

export const renderWav = async (song: Song, options?: RenderOptions): Promise<Blob> =>
  await render(exportWav, song, options);
export const renderMp3 = async (song: Song, options?: RenderOptions): Promise<Blob> =>
  await render(exportMp3, song, options);
