import { expect, spyOn, test } from "bun:test";

import {
  createMp3Encoder,
  createWavEncoder,
  renderAudioExport,
} from "../../src/audio-export-worker";
import { createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";
import { renderWav } from "./export-worker-fixture";

const fixture = (): ReturnType<typeof createSong> => {
  const song = createSong();
  song.resources = [];
  song.barCount = 1;
  song.loopEnd = 1;
  song.beatsPerBar = 1;
  song.tempo = 300;
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  channel.cells = [1];
  channel.instruments = [createInstrument("Custom chip wave")];
  required(channel.patterns[1]).notes = [createNote(0, 1, 48)];
  return song;
};

test("streaming WAV preserves signed PCM quantization and partial final blocks", () => {
  const encoder = createWavEncoder(8000);
  encoder.append(new Float32Array([-2, -0.5, 0]), new Float32Array([2, 0.5, 0]));
  encoder.append(new Float32Array([0.25]), new Float32Array([-0.25]));
  const buffer = encoder.finish();
  const view = new DataView(buffer);
  expect(buffer.byteLength).toBe(44 + 4 * 4);
  expect(view.getUint32(40, true)).toBe(16);
  expect(
    Array.from({ length: 8 }, (_unused, index) => view.getInt16(44 + index * 2, true)),
  ).toEqual([-32_768, 32_767, -16_384, 16_384, 0, 0, 8192, -8192]);
});

test("streaming MP3 is independent of accelerated synthesis block size", async () => {
  const left = Float32Array.from(
    { length: 18_547 },
    (_unused, index) => Math.sin(index * 0.05) * 0.2,
  );
  const right = Float32Array.from(left, (value) => -value * 0.5);
  const encode = async (frames: number): Promise<Uint8Array> => {
    const encoder = await createMp3Encoder(44_100);
    for (let start = 0; start < left.length; start += frames) {
      encoder.append(left.subarray(start, start + frames), right.subarray(start, start + frames));
    }
    return new Uint8Array(encoder.finish());
  };
  expect(await encode(8192)).toEqual(await encode(1152));
});

test("public export cancellation rejects with AbortError", async () => {
  const controller = new AbortController();
  const failure: unknown = await renderWav(fixture(), {
    sampleRate: 8000,
    signal: controller.signal,
    onProgress: () => {
      controller.abort();
    },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DOMException);
  expect(failure).toMatchObject({ name: "AbortError" });
});

test("invalid export sample rates fail before starting synthesis", async () => {
  for (const sampleRate of [0, -1, Number.NaN, Infinity, 1.5]) {
    expect(await renderWav(fixture(), { sampleRate }).catch(String)).toContain("valid sample rate");
  }
});

test("plain native export avoids worker overhead while respecting the configured maximum", async () => {
  const song = fixture();
  song.channels = Array.from({ length: 4 }, () => {
    const channel = createChannel("track", song.barCount, song.patternCount);
    channel.instruments = [createInstrument("chip wave")];
    required(channel.patterns[1]).notes = [createNote(0, 1, [48, 52, 55])];
    return channel;
  });
  using worker = spyOn(globalThis, "Worker");
  const result = await renderAudioExport(
    {
      song,
      sampleRate: 8000,
      threadCount: 3,
      sequence: [0],
      format: "wav",
      resources: [],
    },
    () => {
      // Progress is checked by the public export tests above.
    },
  );
  expect(worker).not.toHaveBeenCalled();
  expect(result.buffer.byteLength).toBe(44 + 1600 * 4);
});
