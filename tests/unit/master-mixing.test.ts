import { expect, test } from "bun:test";

import { registerAudioResource, SongRenderer } from "../../src/audio";
import { createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";
import type { Song } from "../../src/model";

const sampleRate = 8000;
const fixture = (): Song => {
  const samples = Float32Array.from({ length: 512 }, (_, index) =>
    Math.sin((index * Math.PI) / 16),
  );
  registerAudioResource(
    "master-mixing-sample",
    samples,
    samples.map((value) => value * 0.5),
    sampleRate,
  );
  const song = createSong();
  song.volume = 63;
  song.channels = song.channels.slice(0, 2);
  const unused = required(song.channels[0]);
  unused.cells.fill(0);
  unused.instruments = [createInstrument("SoundFont")];
  const audible = required(song.channels[1]);
  audible.cells.fill(1);
  audible.instruments = [createInstrument("chip wave")];
  required(audible.instruments[0]).resourceId = "master-mixing-sample";
  required(audible.patterns[1]).notes = [createNote(0, song.beatsPerBar, 48)];
  return song;
};
const render = (renderer: SongRenderer): [Float32Array, Float32Array] => {
  const left = new Float32Array(2048);
  const right = new Float32Array(left.length);
  renderer.process(left, right);
  expect(left.every(Number.isFinite)).toBe(true);
  expect(right.every(Number.isFinite)).toBe(true);
  expect(left.some((value) => Math.abs(value) > 0.001)).toBe(true);
  return [left, right];
};

test("an unused native track leaves sample playback unchanged", () => {
  const song = fixture();
  const expected = render(new SongRenderer(song, sampleRate));
  for (const type of [
    "chip wave",
    "FM (n-op)",
    "basic noise",
    "spectrum",
    "drumset",
    "harmonics",
    "pulse width",
    "picked string",
    "supersaw",
  ]) {
    const changed = structuredClone(song);
    required(changed.channels[0]).instruments = [createInstrument(type)];
    expect(render(new SongRenderer(changed, sampleRate))).toEqual(expected);
  }
});

test("muting an unused native track leaves the mix unchanged", () => {
  const song = fixture();
  required(song.channels[0]).instruments = [createInstrument("FM (n-op)")];
  const control = new SongRenderer(song, sampleRate);
  const muted = new SongRenderer(song, sampleRate);
  expect(render(muted)).toEqual(render(control));
  muted.muted = new Set([required(song.channels[0]).id]);
  expect(render(muted)).toEqual(render(control));
  muted.muted = new Set();
  expect(render(muted)).toEqual(render(control));
});

test("a zero-volume native track leaves sample playback unchanged", () => {
  const song = fixture();
  const expected = render(new SongRenderer(song, sampleRate));
  const silent = required(song.channels[0]);
  silent.cells.fill(1);
  required(silent.patterns[1]).notes = [createNote(0, song.beatsPerBar, 48)];
  silent.instruments = [createInstrument("chip wave")];
  required(silent.instruments[0]).volume = 0;
  expect(render(new SongRenderer(song, sampleRate))).toEqual(expected);
});

test("changing an unused instrument leaves the mix unchanged", () => {
  const song = fixture();
  const control = new SongRenderer(song, sampleRate);
  const edited = new SongRenderer(song, sampleRate);
  expect(render(edited)).toEqual(render(control));
  for (const type of ["chip wave", "SoundFont", "FM (n-op)", "SoundFont"]) {
    edited.song = structuredClone(edited.song);
    required(edited.song.channels[0]).instruments = [createInstrument(type)];
    expect(render(edited)).toEqual(render(control));
  }
});

test("song volume automation scales the mixed signal linearly in scalar and planned renders", () => {
  const song = createSong();
  song.tempo = 120;
  const automation = createChannel("automation", song.barCount, song.patternCount);
  automation.cells.fill(1);
  required(automation.patterns[1]).lanes = [
    {
      id: "volume",
      enabled: true,
      target: "volume",
      interpolation: "linear",
      points: [
        { time: 0, value: 100 },
        { time: 1, value: 0 },
      ],
    },
  ];
  song.channels = [automation];
  const scalar = new SongRenderer(song, 8);
  const blocked = new SongRenderer(song, 8);
  const expected = [2, 1.5, 1, 0.5, 0];
  const left = new Float32Array(expected.length).fill(2);
  const right = new Float32Array(expected.length).fill(-1);
  const plan = blocked.preparePlan(left.length);
  blocked.processMix(left, right, plan);
  for (const [frame, level] of expected.entries()) {
    const pair: [number, number] = [level, level * -0.5];
    expect(scalar.sample([2, -1])).toEqual(pair);
    expect([left[frame], right[frame]]).toEqual(pair);
  }
});
