import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import {
  createEffect,
  createEnvelope,
  createInstrument,
  validateInstrument,
} from "../../src/instruments";
import type { FMOperator, Instrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";

// Exercise the public renderer, including stereo, note expression and release.
const carrierPatch = (): Instrument => {
  const instrument = createInstrument("FM (n-op)");
  instrument.connections = [];
  instrument.operators = instrument.operators.slice(0, 3);
  instrument.operators.forEach((operator) => {
    operator.carrier = true;
    operator.amplitude = 0;
    operator.ratio = 1;
  });
  required(instrument.operators[0]).amplitude = 1;
  return instrument;
};

const render = (
  instrument: Instrument,
  sampleRate: number,
  pitches: number[] = [48],
  live = false,
): [Float32Array, Float32Array] => {
  const song = createSong();
  song.tempo = 240;
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  channel.instruments = [instrument];
  channel.cells.fill(1);
  const first = createNote(0, 0.5, pitches);
  first.pins = [
    { time: 0, interval: 0, volume: 0.8 },
    { time: 0.5, interval: 0.3, volume: 0.4 },
  ];
  required(channel.patterns[1]).notes = [first, createNote(0.75, 1.5, pitches)];
  const { random } = Math;
  let seed = 12_345;
  try {
    Math.random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    const renderer = new SongRenderer(song, sampleRate);
    if (live) {
      renderer.playing = false;
      for (const pitch of pitches) {
        renderer.audition(channel, pitch);
      }
    }
    const left = new Float32Array(Math.round(sampleRate * 0.45));
    const right = new Float32Array(left.length);
    renderer.process(left, right);
    expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true);
    return [left, right];
  } finally {
    Math.random = random;
  }
};

const expectSameAudio = (
  first: Instrument,
  second: Instrument,
  sampleRate = 24_000,
  pitches = [48],
): void => {
  expect(validateInstrument(first)).toBe(true);
  expect(validateInstrument(second)).toBe(true);
  const expected = render(first, sampleRate, pitches);
  const actual = render(second, sampleRate, pitches);
  let error = 0;
  for (let channel = 0; channel < 2; channel++) {
    const reference = required(expected[channel]);
    const output = required(actual[channel]);
    for (let frame = 0; frame < reference.length; frame++) {
      error = Math.max(error, Math.abs(required(output[frame]) - required(reference[frame])));
    }
  }
  expect(error, "maximum absolute stereo sample error").toBeLessThan(1e-7);
};

for (const wave of [
  "sine",
  "triangle",
  "sawtooth",
  "square",
  "pulse width",
  "Custom",
  "white noise",
]) {
  test(`FM ${wave} coarse tuning equals its frequency ratio across notes and sample rates`, () => {
    const instrument = carrierPatch();
    const operator = required(instrument.operators[0]);
    operator.wave = wave;
    operator.coarse = 12;
    operator.pulseWidth = 0.237;
    operator.customWave = Array.from({ length: 64 }, (_, i) =>
      Math.max(-24, Math.min(24, 5 + 14 * Math.sin(i / 10) + 4 * Math.cos(i / 3))),
    );
    const reference = structuredClone(instrument);
    required(reference.operators[0]).coarse = 0;
    required(reference.operators[0]).ratio = 2;
    for (const sampleRate of [8000, 44_100]) {
      for (const pitch of [24, 72]) {
        expectSameAudio(instrument, reference, sampleRate, [pitch]);
      }
    }
  });
}

const layeredPatch = (): Instrument => {
  const instrument = carrierPatch();
  instrument.operators.forEach((operator, index) => {
    Object.assign(operator, {
      wave: ["sawtooth", "pulse width", "Custom"][index],
      amplitude: [0.4, 0.7, 0.2][index],
      coarse: [-12, 7, 24][index],
      fine: [-45, 32, 100][index],
      phase: [37, 250, 96][index],
      stereoPhase: [-93, 71, 180][index],
      stereoDetune: [24, -37, 100][index],
      pan: [-0.7, 0.3, 1][index],
      invert: index === 1,
      pulseWidth: 0.317,
    });
  });
  return instrument;
};

test("independent stereo carriers retain their sound when reordered", () => {
  const instrument = layeredPatch();
  const reordered = structuredClone(instrument);
  reordered.operators.reverse();
  expectSameAudio(instrument, reordered, 44_100, [36, 43, 48]);
});

test("FM operator envelopes match equivalent saved amplitude, tuning and stereo values", () => {
  const instrument = layeredPatch();
  const reference = structuredClone(instrument);
  const targets: Array<
    keyof Pick<FMOperator, "amplitude" | "coarse" | "fine" | "pan" | "pulseWidth" | "stereoDetune">
  > = ["amplitude", "coarse", "fine", "pan", "stereoDetune", "pulseWidth"];
  for (const [index, operator] of instrument.operators.entries()) {
    for (const target of targets) {
      instrument.envelopes.push({
        ...createEnvelope(),
        target: `operator:${operator.id}:${target}`,
        type: "None",
        a: 0.5,
      });
      required(reference.operators[index])[target] *= 0.5;
    }
  }
  expectSameAudio(instrument, reference, 8000, [36, 48]);
});

test("FM bindings retain disabled envelopes when their enabled flag changes during playback", () => {
  const instrument = carrierPatch();
  const operator = required(instrument.operators[0]);
  instrument.envelopes = [
    {
      ...createEnvelope(),
      target: `operator:${operator.id}:amplitude`,
      type: "None",
      a: 0.25,
      enabled: false,
    },
  ];
  const reference = structuredClone(instrument);
  reference.envelopes = [];
  const songFor = (patch: Instrument): ReturnType<typeof createSong> => {
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    required(song.channels[0]).instruments = [patch];
    required(required(song.channels[0]).patterns[1]).notes = [createNote(0, 4, [48])];
    return song;
  };
  const renderer = new SongRenderer(songFor(instrument), 8000);
  const expected = new SongRenderer(songFor(reference), 8000);
  for (let frame = 0; frame < 512; frame++) {
    if (frame === 128 || frame === 384) {
      required(instrument.envelopes[0]).enabled = true;
      required(reference.operators[0]).amplitude = 0.25;
    } else if (frame === 256) {
      required(instrument.envelopes[0]).enabled = false;
      required(reference.operators[0]).amplitude = 1;
    }
    expect(renderer.sample()).toEqual(expected.sample());
  }
});

test("FM phase cancellation remains silent through note expression and release", () => {
  const instrument = carrierPatch();
  required(instrument.operators[1]).amplitude = 1;
  required(instrument.operators[1]).invert = true;
  expect(render(instrument, 24_000)[0].every((value) => value === 0)).toBe(true);
});

test("FM randomized live voices are reproducible with seeded randomness and retain stereo", () => {
  const instrument = layeredPatch();
  instrument.phaseRandomness = 0.65;
  const first = render(instrument, 24_000, [48, 55], true);
  expect(first).toEqual(render(structuredClone(instrument), 24_000, [48, 55], true));
  expect(first[0]).not.toEqual(first[1]);
  const fixed = { ...instrument, phaseRandomness: 0 };
  expect(first).not.toEqual(render(fixed, 24_000, [48, 55], true));
});

for (const chords of ["simultaneous", "arpeggio", "strum"]) {
  test(`FM ${chords} chords retain stereo and audible shared effects`, () => {
    const instrument = layeredPatch();
    instrument.chords = chords;
    const dry = render(instrument, 24_000, [36, 43, 48]);
    instrument.effects = [createEffect("Pan"), createEffect("Echo")];
    instrument.envelopes = [{ ...createEnvelope(), target: "volume", type: "Decay", speed: 2 }];
    const wet = render(instrument, 24_000, [36, 43, 48]);
    expect(wet).not.toEqual(dry);
    expect(wet[0].some((sample) => Math.abs(sample) > 1e-5)).toBe(true);
    expect(wet[0]).not.toEqual(wet[1]);
  });
}
