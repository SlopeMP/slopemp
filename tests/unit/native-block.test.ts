import { expect, test } from "bun:test";

import { envelopeValue } from "../../src/audio";
import { createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { createNativeSynth } from "../../src/synth/adapter";
import { resetSynthNoiseTables } from "../../src/synth/runtime";

const render = (type: string, blocked: boolean): Float64Array => {
  const { random } = Math;
  let seed = 12_345;
  Math.random = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  resetSynthNoiseTables();
  const song = createSong();
  song.channels = song.channels.slice(0, 1);
  song.loopEnd = 2;
  const channel = required(song.channels[0]);
  const instrument = createInstrument(type);
  instrument.attack = 0.05;
  channel.instruments = [instrument];
  channel.cells.fill(1);
  required(channel.patterns[1]).notes = [createNote(0, 0.25, [48, 52]), createNote(0.5, 1.5, 55)];
  const { runtime } = createNativeSynth(song, channel, instrument, 8000, envelopeValue);
  const samples: number[] = [];
  try {
    runtime.seek(0.03125);
    const pitches: number[] = [];
    for (const [index, frames] of [137, 511, 2048, 4096, 3001].entries()) {
      const tempo = required([150, 60, 300, 150, 150][index]);
      const detune = index === 3 ? 35 : 0;
      pitches.length = 0;
      if (index === 3) {
        pitches.push(60, 67);
      }
      const playing = index !== 3;
      if (blocked) {
        const left = new Float64Array(frames);
        const right = new Float64Array(frames);
        runtime.process(left, right, playing, pitches, tempo, detune);
        for (let frame = 0; frame < frames; frame++) {
          samples.push(required(left[frame]), required(right[frame]));
        }
      } else {
        for (let frame = 0; frame < frames; frame++) {
          samples.push(...runtime.sample(playing, pitches, tempo, detune));
        }
      }
    }
    return Float64Array.from(samples);
  } finally {
    Math.random = random;
  }
};

for (const type of [
  "chip wave",
  "basic noise",
  "spectrum",
  "drumset",
  "harmonics",
  "pulse width",
  "picked string",
  "supersaw",
]) {
  test(`${type} block synthesis preserves controls and transport across fractional ticks`, () => {
    const actual = render(type, true);
    const expected = render(type, false);
    expect(actual).toHaveLength(expected.length);
    let difference = 0;
    for (let frame = 0; frame < actual.length; frame++) {
      difference = Math.max(
        difference,
        Math.abs(required(actual[frame]) - required(expected[frame])),
      );
    }
    // Internal oscillator/filter rounding at bulk boundaries stays far below
    // one PCM16 quantization step; every note/control boundary is unchanged.
    expect(difference).toBeLessThan(1e-7);
    expect(actual.every(Number.isFinite)).toBe(true);
    expect(actual.some((value) => Math.abs(value) > 0.001)).toBe(true);
  });
}
