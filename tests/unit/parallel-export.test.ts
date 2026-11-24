import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import type { RenderOptions } from "../../src/audio-export";
import { AudioThreadPool } from "../../src/audio-thread-pool";
import { exportSequence } from "../../src/formats";
import { createEffect, createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";
import type { Song } from "../../src/model";

const sampleRate = 8000;
const fixture = (): Song => {
  const song = createSong();
  song.barCount = 4;
  song.loopStart = 1;
  song.loopEnd = 3;
  song.beatsPerBar = 1;
  song.tempo = 240;
  song.volume = 69;
  song.channels = ["chip wave", "Custom chip wave", "FM (n-op)"].map((type, index) => {
    const channel = createChannel("track", song.barCount, song.patternCount);
    channel.cells = [1, 2, 3, 4];
    const instrument = createInstrument(type);
    instrument.attack = 0;
    instrument.volume = 0.3;
    instrument.release = 0.2;
    channel.instruments = [instrument];
    for (let pattern = 1; pattern <= 4; pattern++) {
      const note = createNote(0, 1, 48 + index * 3 + (pattern === 4 ? 7 : 0));
      note.continues = pattern === 3;
      required(channel.patterns[pattern]).notes = [note];
    }
    const echo = createEffect("Echo");
    echo.parameters["time"] = 0.03;
    channel.effects = [echo];
    return channel;
  });
  const global = createChannel("automation", song.barCount, song.patternCount);
  global.cells.fill(1);
  const gain = createEffect("Gain");
  global.effects = [gain];
  required(global.patterns[1]).lanes = [
    {
      id: "tempo",
      target: "tempo",
      enabled: true,
      interpolation: "linear",
      points: [
        { time: 0, value: 200 },
        { time: 1, value: 280 },
      ],
    },
    {
      id: "gain",
      target: "gain",
      effectId: gain.id,
      enabled: true,
      interpolation: "linear",
      points: [
        { time: 0, value: -3 },
        { time: 1, value: 3 },
      ],
    },
    {
      id: "volume",
      target: "volume",
      enabled: true,
      interpolation: "linear",
      points: [
        { time: 0, value: 69 },
        { time: 1, value: 85 },
      ],
    },
  ];
  const target = createChannel("automation", song.barCount, song.patternCount);
  target.cells.fill(1);
  target.target = { kind: "channel", channelId: required(song.channels[1]).id };
  const pan = createEffect("Pan");
  target.effects = [pan];
  required(target.patterns[1]).lanes = [
    {
      id: "pan",
      target: "position",
      effectId: pan.id,
      enabled: true,
      interpolation: "linear",
      points: [
        { time: 0, value: -60 },
        { time: 1, value: 60 },
      ],
    },
  ];
  song.channels.push(global, target);
  return song;
};

for (const options of [
  { intro: false, outro: false, loopCount: 2 },
  { intro: true, outro: true, loopCount: 1 },
]) {
  test(`accelerated blocks preserve finite sequences, ties, automation and master (${JSON.stringify(options)})`, async () => {
    const song = fixture();
    const sequence = exportSequence(song, options);
    const reference = new SongRenderer(song, sampleRate, 0, sequence);
    const muted = new Set([required(song.channels[2]).id]);
    reference.muted = muted;
    const expectedLeft: number[] = [];
    const expectedRight: number[] = [];
    while (reference.playing) {
      const [left, right] = reference.sample();
      expectedLeft.push(Math.fround(left));
      expectedRight.push(Math.fround(right));
    }
    const master = new SongRenderer(song, sampleRate, 0, sequence, { channelIds: new Set() });
    master.muted = muted;
    const pool = new AudioThreadPool({
      song,
      sequence,
      sampleRate,
      bar: master.bar,
      beat: master.beat,
      clock: master.transportClock,
      playing: true,
      recording: false,
      muted: [...muted],
      threadCount: 1,
    });
    try {
      const actualLeft: number[] = [];
      const actualRight: number[] = [];
      while (master.playing) {
        const block = await pool.renderBlock(master, 8192, true);
        expect(block.left.length).toBeGreaterThan(0);
        expect(block.left.length).toBeLessThanOrEqual(8192);
        actualLeft.push(...block.left);
        actualRight.push(...block.right);
      }
      expect(actualLeft).toHaveLength(expectedLeft.length);
      expect(actualRight).toHaveLength(expectedRight.length);
      let difference = 0;
      for (let frame = 0; frame < expectedLeft.length; frame++) {
        difference = Math.max(
          difference,
          Math.abs(required(actualLeft[frame]) - required(expectedLeft[frame])),
          Math.abs(required(actualRight[frame]) - required(expectedRight[frame])),
        );
      }
      expect(difference).toBeLessThan(1e-6);
      expect(master.transportClock).toEqual(reference.transportClock);
      const finished = await pool.renderBlock(master, 8192, true);
      expect(finished.left).toHaveLength(0);
      expect(finished.right).toHaveLength(0);
    } finally {
      pool.close();
    }
  });
}

test("finite plans end at the exact automation-triggered last frame", () => {
  const song = fixture();
  const global = required(
    song.channels.find(
      (channel) => channel.kind === "automation" && channel.target.kind === "song",
    ),
  );
  required(global.patterns[1]).lanes.push({
    id: "next-bar",
    target: "nextBar",
    enabled: true,
    interpolation: "hold",
    points: [{ time: 0.5, value: 1 }],
  });
  const sequence = exportSequence(song, { intro: true, outro: true, loopCount: 2 });
  const reference = new SongRenderer(song, sampleRate, 0, sequence);
  let samples = 0;
  while (reference.playing) {
    reference.sample();
    samples++;
  }
  const renderer = new SongRenderer(song, sampleRate, 0, sequence, { channelIds: new Set() });
  const plan = renderer.preparePlan(100_000, true);
  expect(plan.frames).toHaveLength(samples);
  expect(plan.playing).toBe(false);
  expect(plan.end.bar).toBe(reference.bar);
  expect(plan.end.beat).toBe(reference.beat);
  expect(plan.frames.every((frame) => frame.playing)).toBe(true);
  expect(required(plan.frames.at(-1)).beat).toBeLessThan(0.51);
  expect(required(plan.frames.at(-1)).beat).toBeGreaterThanOrEqual(0.5);
});

test("native finite playback starts at the selected loop bar instead of a sequence offset", () => {
  const song = createSong();
  song.barCount = 4;
  song.loopStart = 1;
  song.loopEnd = 3;
  song.beatsPerBar = 1;
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  channel.cells = [1, 2, 3, 4];
  channel.instruments = [createInstrument("chip wave")];
  for (let pattern = 1; pattern <= 4; pattern++) {
    required(channel.patterns[pattern]).notes = [createNote(0, 1, 36 + pattern * 7)];
  }
  const options: RenderOptions = { intro: false, outro: true };
  const sequence = exportSequence(song, options);
  expect(sequence).toEqual([1, 2, 3]);
  const playing = new SongRenderer(song, sampleRate, song.loopStart);
  const expectedLeft = new Float32Array(512);
  const expectedRight = new Float32Array(512);
  playing.process(expectedLeft, expectedRight);
  const finite = new SongRenderer(song, sampleRate, 0, sequence);
  const actualLeft = new Float32Array(512);
  const actualRight = new Float32Array(512);
  finite.process(actualLeft, actualRight);
  expect(actualLeft).toEqual(expectedLeft);
  expect(actualRight).toEqual(expectedRight);
});
