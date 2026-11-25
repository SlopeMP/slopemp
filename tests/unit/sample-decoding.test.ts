import { expect, test } from "bun:test";

import { loadAudioResource, removeAudioResource, snapshotAudioResources } from "../../src/audio";
import { required } from "../../src/model";

test("sample decoding preserves frame positions across playback device sample rates", async () => {
  const previous = new Map(
    ["AudioContext", "OfflineAudioContext"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const id = "device-independent-sample";
  const data = new Uint8Array([1, 2, 3, 4]).buffer;
  try {
    for (const deviceRate of [48_000, 44_100, 96_000, 192_000]) {
      let playbackContexts = 0;
      class FakeDecoder {
        public readonly sampleRate: number;
        public constructor(sampleRate: number) {
          this.sampleRate = sampleRate;
        }
        public async decodeAudioData(encoded: ArrayBuffer): Promise<{
          length: number;
          sampleRate: number;
          numberOfChannels: number;
          getChannelData: (channel: number) => Float32Array;
        }> {
          expect(encoded).toEqual(data);
          expect(encoded).not.toBe(data);
          await Promise.resolve();
          const length = this.sampleRate / 100;
          return {
            length,
            sampleRate: this.sampleRate,
            numberOfChannels: 2,
            getChannelData: (channel): Float32Array =>
              Float32Array.from({ length }, (_value, index) =>
                channel === 0 ? index / length : -index / length,
              ),
          };
        }
        public async close(): Promise<void> {
          await Promise.resolve();
        }
      }
      class FakeAudioContext extends FakeDecoder {
        public constructor() {
          super(deviceRate);
          playbackContexts++;
        }
      }
      class FakeOfflineAudioContext extends FakeDecoder {
        public constructor(_channels: number, _length: number, sampleRate: number) {
          super(sampleRate);
        }
      }
      Object.assign(globalThis, {
        AudioContext: FakeAudioContext,
        OfflineAudioContext: FakeOfflineAudioContext,
      });

      expect(await loadAudioResource(id, data)).toBe(441);
      const update = required(
        snapshotAudioResources(new Set([id])).find((resource) => resource.type === "sample"),
      );
      expect(update.resource.sampleRate).toBe(44_100);
      expect(update.resource.left.length).toBe(441);
      expect(update.resource.right.length).toBe(441);
      // A saved loop boundary addresses the same point in both channels.
      expect(update.resource.left[220]).toBeCloseTo(220 / 441, 7);
      expect(update.resource.right[220]).toBeCloseTo(-220 / 441, 7);
      expect(playbackContexts).toBe(0);
    }
  } finally {
    removeAudioResource(id);
    for (const [key, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
