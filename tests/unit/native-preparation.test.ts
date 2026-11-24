import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import { AudioThreadPool } from "../../src/audio-thread-pool";
import { createEffect, createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { resetSynthNoiseTables } from "../../src/synth/runtime";

const seedRandom = (): void => {
  let state = 12_345;
  Math.random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};
for (const type of [
  "chip wave",
  "basic noise",
  "pulse width",
  "picked string",
  "harmonics",
  "spectrum",
  "drumset",
  "supersaw",
]) {
  test(`${type} planned blocks preserve scalar audio through silent intros, notes and loops`, async () => {
    const song = createSong();
    song.barCount = 3;
    song.loopStart = 1;
    song.loopEnd = 3;
    song.beatsPerBar = 1;
    song.tempo = 240;
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    channel.cells = [0, 1, 1];
    channel.instruments = [createInstrument(type)];
    required(channel.patterns[1]).notes = [createNote(0, 0.6, 48), createNote(0.75, 1, 55)];
    const { random } = Math;
    const expectedLeft = new Float32Array(16_384);
    const expectedRight = new Float32Array(expectedLeft.length);
    try {
      seedRandom();
      resetSynthNoiseTables();
      const reference = new SongRenderer(song, 8000);
      for (let frame = 0; frame < expectedLeft.length; frame++) {
        [expectedLeft[frame], expectedRight[frame]] = reference.sample();
      }
      reference.reset();
      seedRandom();
      resetSynthNoiseTables();
      const master = new SongRenderer(song, 8000, 0, undefined, { channelIds: new Set() });
      const pool = new AudioThreadPool({
        song,
        sampleRate: 8000,
        threadCount: 1,
        bar: 0,
        beat: 0,
        playing: true,
        recording: false,
        muted: [],
      });
      try {
        let offset = 0;
        let difference = 0;
        for (const frames of [512, 8192, 257, 7423]) {
          const { left, right } = await pool.renderBlock(master, frames);
          for (let frame = 0; frame < frames; frame++) {
            difference = Math.max(
              difference,
              Math.abs((left[frame] ?? 0) - (expectedLeft[offset + frame] ?? 0)),
              Math.abs((right[frame] ?? 0) - (expectedRight[offset + frame] ?? 0)),
            );
          }
          offset += frames;
        }
        expect(offset).toBe(expectedLeft.length);
        expect(difference).toBeLessThan(1e-6);
      } finally {
        pool.close();
        master.reset();
      }
    } finally {
      Math.random = random;
      resetSynthNoiseTables();
    }
  });
}

for (const effect of ["Chorus", "Vibrato"]) {
  test(`${effect} native planned output remains sample-exact`, async () => {
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    const instrument = createInstrument("chip wave");
    instrument.effects = [createEffect(effect)];
    channel.instruments = [instrument];
    required(channel.patterns[1]).notes = [createNote(0, 4, [48, 55])];
    const master = new SongRenderer(song, 8000, 0, undefined, { channelIds: new Set() });
    const reference = new SongRenderer(song, 8000);
    const pool = new AudioThreadPool({
      song,
      sampleRate: 8000,
      threadCount: 1,
      bar: 0,
      beat: 0,
      playing: true,
      recording: false,
      muted: [],
    });
    try {
      const actual = await pool.renderBlock(master, 8192);
      const left = new Float32Array(8192);
      const right = new Float32Array(8192);
      reference.process(left, right);
      expect(actual.left).toEqual(left);
      expect(actual.right).toEqual(right);
    } finally {
      pool.close();
      master.reset();
      reference.reset();
    }
  });
}
