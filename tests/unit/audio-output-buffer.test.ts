import { expect, test } from "bun:test";

import { audioBlockFrames, AudioOutputBuffer, nextAudioBlock } from "../../src/audio-output-buffer";

test("audio queues preserve a scheduling margin across device sample rates and latencies", () => {
  for (const sampleRate of [44_100, 48_000, 96_000, 192_000]) {
    for (const baseLatency of [0, 0.01, 0.02, 0.04]) {
      const output = AudioOutputBuffer.create(sampleRate, baseLatency);
      const duration = (output.queuedBlocks * audioBlockFrames) / sampleRate;
      const minimum = Math.max(0.02, 2 * baseLatency);
      expect(duration).toBeGreaterThanOrEqual(minimum);
      expect(duration).toBeLessThan(minimum + audioBlockFrames / sampleRate);
      expect(new AudioOutputBuffer(output.buffer).queuedBlocks).toBe(output.queuedBlocks);
    }
  }
  const fallback = AudioOutputBuffer.create(48_000).queuedBlocks;
  for (const baseLatency of [Number.NaN, Infinity, -1]) {
    expect(AudioOutputBuffer.create(48_000, baseLatency).queuedBlocks).toBe(fallback);
  }
  const capped = AudioOutputBuffer.create(48_000, 1);
  expect((capped.queuedBlocks * audioBlockFrames) / 48_000).toBeLessThan(0.106);
});

test("sized shared buffers retain both transport generations and wrap without losing timestamps", () => {
  const writer = AudioOutputBuffer.create(96_000, 0.02);
  const reader = new AudioOutputBuffer(writer.buffer);
  const samples = new Float32Array(audioBlockFrames);
  const { capacity } = writer;
  expect(capacity).toBeGreaterThanOrEqual(2 * writer.queuedBlocks);
  for (let pass = 0; pass < 3; pass++) {
    const start = writer.writeIndex;
    for (let offset = 0; offset < capacity; offset++) {
      const id = start + offset;
      writer.generation = offset < writer.queuedBlocks ? 2 * pass : 2 * pass + 1;
      expect(writer.hasSpace(reader.readIndex)).toBe(true);
      writer.writeBlock(samples.fill(id), samples);
    }
    expect(writer.hasSpace(reader.readIndex)).toBe(false);
    for (let offset = 0; offset < capacity; offset++) {
      const id = start + offset;
      expect(reader.block(id).left.every((sample) => sample === id)).toBe(true);
      expect(reader.blockGeneration(id)).toBe(
        offset < writer.queuedBlocks ? 2 * pass : 2 * pass + 1,
      );
      reader.release(id, id / 100);
      expect(writer.consumedTime(id)).toBe(id / 100);
    }
  }
});

test("device-sized queues retain blocks across unsigned cursor rollover", () => {
  const output = AudioOutputBuffer.create(192_000);
  const control = new Int32Array(output.buffer, 0, 4);
  const start = 2 ** 32 - 8;
  Atomics.store(control, 0, start);
  Atomics.store(control, 1, start);
  const samples = new Float32Array(audioBlockFrames);
  for (let pass = 0; pass < 2; pass++) {
    const first = output.readIndex;
    for (let offset = 0; offset < output.capacity; offset++) {
      expect(output.hasSpace(output.readIndex)).toBe(true);
      output.generation = offset;
      output.writeBlock(samples.fill(offset + 1), samples);
    }
    expect(output.hasSpace(output.readIndex)).toBe(false);
    let index = first;
    for (let offset = 0; offset < output.capacity; offset++) {
      expect(output.block(index).left.every((value) => value === offset + 1)).toBe(true);
      expect(output.blockGeneration(index)).toBe(offset);
      output.release(index, offset / 100);
      expect(output.consumedTime(index)).toBe(offset / 100);
      index = nextAudioBlock(index);
    }
    expect(output.readIndex).toBe(output.writeIndex);
  }
});
