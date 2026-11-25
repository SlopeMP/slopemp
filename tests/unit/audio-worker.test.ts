import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import type { AudioReply } from "../../src/audio";
import { audioBlockFrames, AudioOutputBuffer } from "../../src/audio-output-buffer";
import { AudioWorkerSession } from "../../src/audio-worker";
import { createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";

const fixture = async (
  sampleRate = 8000,
  baseLatency = 0,
): Promise<{
  song: ReturnType<typeof createSong>;
  output: AudioOutputBuffer;
  replies: AudioReply[];
  session: AudioWorkerSession;
  whenWritten: (id: number) => Promise<void>;
}> => {
  const song = createSong();
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  channel.instruments = [createInstrument("Custom chip wave")];
  channel.cells.fill(1);
  required(channel.patterns[1]).notes = [createNote(0, song.beatsPerBar, 48)];
  const output = AudioOutputBuffer.create(sampleRate, baseLatency);
  const replies: AudioReply[] = [];
  const waiting = new Map<number, () => void>();
  const session = new AudioWorkerSession((reply) => {
    replies.push(reply);
    if (reply.type === "block") {
      waiting.get(reply.block.id)?.();
      waiting.delete(reply.block.id);
    }
  });
  await session.handle({
    type: "init",
    song,
    sampleRate,
    threadCount: 1,
    bar: 0,
    beat: 0,
    playing: true,
    recording: false,
    muted: [],
    volume: 1,
    output: output.buffer,
    generation: 0,
    time: 10,
  });
  return {
    song,
    output,
    replies,
    session,
    whenWritten: async (id): Promise<void> => {
      await new Promise<void>((resolve) => {
        waiting.set(id, resolve);
      });
    },
  };
};

test("the synthesis worker replenishes shared audio independently and retains audio through edits", async () => {
  const { song, output, replies, session, whenWritten } = await fixture();
  const queuedAudioBlocks = output.queuedBlocks;
  expect(output.writeIndex).toBe(queuedAudioBlocks);
  expect(replies.at(-1)).toEqual({ type: "ready" });
  const reference = new SongRenderer(song, 8000);
  const verifyBlock = (index: number): void => {
    const left = new Float32Array(audioBlockFrames);
    const right = new Float32Array(audioBlockFrames);
    reference.process(left, right);
    expect(output.block(index)).toEqual({ left, right });
  };
  for (let index = 0; index < queuedAudioBlocks; index++) {
    verifyBlock(index);
  }
  const edited = structuredClone(song);
  edited.loopStart = 1;
  await session.handle({ type: "song", song: edited });
  expect(output.writeIndex).toBe(queuedAudioBlocks);
  for (let index = 0; index < 12; index++) {
    const id = index + queuedAudioBlocks;
    const written = whenWritten(id);
    const time = 10 + (index + 1) * (audioBlockFrames / 8000);
    output.release(index, time);
    await written;
    expect(output.writeIndex).toBe(id + 1);
    verifyBlock(id);
    expect(replies.at(-2)).toEqual({ type: "consumed", generation: 0, id: index, time });
    expect(replies.at(-1)).toMatchObject({
      type: "block",
      generation: 0,
      block: { id, duration: audioBlockFrames / 8000 },
      time,
    });
  }
});

test("transport resets skip stale blocks and wait for space without blocking commands", async () => {
  const { song, output, replies, session, whenWritten } = await fixture(48_000, 0.02);
  const queuedAudioBlocks = output.queuedBlocks;
  await session.handle({ type: "seek", bar: 2, beat: 0.5, generation: 1 });
  expect(output.generation).toBe(1);
  expect(output.writeIndex).toBe(2 * queuedAudioBlocks);
  expect(replies.at(-queuedAudioBlocks)).toMatchObject({
    type: "block",
    generation: 1,
    block: { id: queuedAudioBlocks, start: 2 + 0.5 / song.beatsPerBar },
  });
  await session.handle({ type: "pause", bar: 2, generation: 2 });
  expect(output.generation).toBe(2);
  expect(output.writeIndex).toBe(2 * queuedAudioBlocks);
  const written = whenWritten(3 * queuedAudioBlocks - 1);
  for (let index = 0; index < 2 * queuedAudioBlocks; index++) {
    expect(output.blockGeneration(index)).toBe(index < queuedAudioBlocks ? 0 : 1);
    output.release(index);
  }
  await written;
  expect(output.writeIndex).toBe(3 * queuedAudioBlocks);
  expect(replies.some((reply) => reply.type === "consumed")).toBe(false);
  for (let index = 2 * queuedAudioBlocks; index < 3 * queuedAudioBlocks; index++) {
    expect(output.blockGeneration(index)).toBe(2);
    const { left, right } = output.block(index);
    expect(left.every((value) => value === 0)).toBe(true);
    expect(right.every((value) => value === 0)).toBe(true);
  }
});

test("the synthesis worker refills a device-sized queue after batched audio consumption", async () => {
  const sampleRate = 96_000;
  const { song, output, session, whenWritten } = await fixture(sampleRate, 0.02);
  const reference = new SongRenderer(song, sampleRate);
  const queued = output.queuedBlocks;
  expect((queued * audioBlockFrames) / sampleRate).toBeGreaterThanOrEqual(0.04);
  for (let pass = 0; pass < 3; pass++) {
    const start = output.readIndex;
    const written = whenWritten(output.writeIndex + queued - 1);
    for (let offset = 0; offset < queued; offset++) {
      const id = start + offset;
      const left = new Float32Array(audioBlockFrames);
      const right = new Float32Array(audioBlockFrames);
      reference.process(left, right);
      expect(output.block(id)).toEqual({ left, right });
      output.release(id, 10 + ((id + 1) * audioBlockFrames) / sampleRate);
    }
    await written;
    expect(output.writeIndex - output.readIndex).toBe(queued);
  }
  await session.handle({ type: "pause", bar: 0, generation: 1 });
});
