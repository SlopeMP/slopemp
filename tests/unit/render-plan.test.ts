import { expect, test } from "bun:test";

import { evaluateAutomation, SongRenderer } from "../../src/audio";
import { createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";

const fixture = (automated: boolean): SongRenderer => {
  const song = createSong();
  song.beatsPerBar = 1;
  song.loopStart = 1;
  song.loopEnd = 3;
  if (automated) {
    const automation = createChannel("automation", song.barCount, song.patternCount);
    automation.cells.fill(1);
    required(automation.patterns[1]).lanes = [
      {
        id: "tempo",
        target: "tempo",
        enabled: true,
        interpolation: "linear",
        points: [
          { time: 0, value: 300 },
          { time: 1, value: 123.456 },
        ],
      },
    ];
    song.channels.push(automation);
  }
  return new SongRenderer(song, 8000, 0, [0, 1, 2, 1, 2], { channelIds: new Set() });
};

test("ordinary render plans retain exact frame controls and worker clones", () => {
  const renderer = fixture(false);
  const reference = fixture(false);
  const plan = renderer.preparePlan(8192, true);
  const clone = structuredClone(plan);
  expect(clone).toEqual(plan);
  const first = required(plan.frames[0]);
  expect(first.globals).toEqual({
    tempo: renderer.song.tempo,
    volume: renderer.song.volume,
    detune: renderer.song.detune,
  });
  for (const frame of clone.frames) {
    expect(frame.bar).toBe(reference.bar);
    expect(frame.beat).toBe(reference.beat);
    expect(frame.seconds).toBe(reference.seconds);
    reference.sample();
  }
  expect(plan.end).toEqual({ ...reference.transportClock, sampleFrame: 0 });
});

test("render plans evaluate global automation for every sample", () => {
  const renderer = fixture(true);
  const plan = renderer.preparePlan(8192, true);
  const clone = structuredClone(plan);
  expect(clone).toEqual(plan);
  expect(new Set(plan.frames.map((frame) => frame.globals)).size).toBe(plan.frames.length);
  expect(new Set(plan.frames.map((frame) => frame.globals.tempo)).size).toBeGreaterThan(100);
  for (const frame of clone.frames) {
    expect(frame.globals).toEqual(evaluateAutomation(renderer.song, frame.bar, frame.beat));
  }
});

test("paused and completed plans retain default controls and exact final clocks", () => {
  const renderer = fixture(true);
  renderer.playing = false;
  const paused = renderer.preparePlan(512);
  const first = required(paused.frames[0]);
  expect(first.globals.tempo).toBe(renderer.song.tempo);
  expect(paused.frames.every((frame) => !frame.playing)).toBe(true);
  renderer.playing = true;
  const ending = renderer.preparePlan(100_000, true);
  expect(ending.playing).toBe(false);
  expect(structuredClone(ending)).toEqual(ending);
  const finished = renderer.preparePlan(512, true);
  expect(finished.frames).toHaveLength(0);
  expect(finished.end).toEqual(ending.end);
});

test("blocked note lookup preserves pattern order and overlapping release tails", () => {
  const song = createSong();
  const channel = required(song.channels[0]);
  song.channels = [channel];
  channel.cells.fill(1);
  const instrument = createInstrument("FM (n-op)");
  instrument.release = 0.3;
  channel.instruments = [instrument];
  // The later-starting note has priority as soon as its interval is reached.
  required(channel.patterns[1]).notes = [createNote(0.5, 0.75, [67]), createNote(0, 1, [48, 52])];
  const options = { master: false };
  const blocked = new SongRenderer(song, 8000, 0, undefined, options);
  const scalar = new SongRenderer(song, 8000, 0, undefined, options);
  for (const frames of [3651, 4096]) {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    blocked.process(left, right);
    const expected = new Float32Array(frames * 2);
    for (let frame = 0; frame < frames; frame++) {
      [expected[frame], expected[frames + frame]] = scalar.sample();
    }
    expect(left).toEqual(expected.subarray(0, frames));
    expect(right).toEqual(expected.subarray(frames));
  }
});
