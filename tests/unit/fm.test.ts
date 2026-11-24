import { expect, test } from "bun:test";

import { createFMOperator, createInstrument } from "../../src/instruments";
import type { FMConnection, Instrument } from "../../src/instruments";
import { required } from "../../src/model";
import { createFMVoice, fmAmplitudeCurve, sampleFM } from "../../src/synth/fm";
import { waveSample } from "../../src/synth/waves";
import fixtures from "../fixtures/ultrabox-fm.json";

const singleCarrier = (): Instrument => {
  const instrument = createInstrument("FM (n-op)");
  instrument.operators = [required(instrument.operators[0])];
  instrument.connections = [];
  return instrument;
};

test("all thirteen algorithms, six-op graphs, and feedback routes produce finite stereo audio", () => {
  for (const fixture of fixtures) {
    const instrument = createInstrument("FM (n-op)");
    const template = required(instrument.operators[0]);
    instrument.operators = fixture.amplitudes.map((amplitude, index) => ({
      ...template,
      id: `op-${index}`,
      amplitude,
      ratio: required(fixture.ratios[index]),
      carrier: index < fixture.carrierCount,
      wave: required(fixture.waves[index]),
    }));
    const routes = (edges: number[][]): FMConnection[] =>
      edges.flatMap((sources, to) =>
        sources.map((from) => ({
          from: required(instrument.operators[from - 1]).id,
          to: required(instrument.operators[to]).id,
        })),
      );
    instrument.connections = routes(fixture.connections);
    instrument.feedback = routes(fixture.feedback);
    instrument.feedbackVolume = fixture.feedbackVolume;
    const state = createFMVoice();
    let energy = 0;
    for (let i = 0; i < 512; i++) {
      const sample = sampleFM(instrument, state, fixture.frequency, fixture.sampleRate);
      expect(sample.every(Number.isFinite), fixture.algorithm).toBe(true);
      expect(sample[0], fixture.algorithm).toBe(sample[1]);
      energy += sample[0] ** 2;
    }
    expect(energy, fixture.algorithm).toBeGreaterThan(0);
  }
});

test("carrier gain is linear and independent of pitch, other carriers, and feedback amount", () => {
  const instrument = singleCarrier();
  const carrier = required(instrument.operators[0]);
  carrier.amplitude = 0.5;
  carrier.phase = 90;
  for (const frequency of [110, 440, 1760]) {
    for (const feedbackVolume of [0, 0.5, 1]) {
      instrument.feedbackVolume = feedbackVolume;
      expect(sampleFM(instrument, createFMVoice(), frequency, 44_100)).toEqual([1 / 6, 1 / 6]);
    }
  }
});

test("FM modulation retains its amplitude curve", () => {
  expect(fmAmplitudeCurve(0)).toBe(0);
  expect(fmAmplitudeCurve(1)).toBe(1);
  expect(fmAmplitudeCurve(0.5)).toBe(0.2);
});

test("routing uses the source phase depth even when the source is also a carrier", () => {
  const instrument = createInstrument("FM (n-op)");
  instrument.operators = instrument.operators.slice(0, 2);
  const carrier = required(instrument.operators[0]);
  const source = required(instrument.operators[1]);
  carrier.phase = 10;
  source.phase = 30;
  source.amplitude = 0.5;
  instrument.connections = [{ from: source.id, to: carrier.id }];
  const sourceRaw = Math.sin(Math.PI / 6);
  const expected = Math.sin(2 * Math.PI * (10 / 360 + sourceRaw * 0.2 * 1.5)) / 3;
  expect(sampleFM(instrument, createFMVoice(), 220, 44_100)[0]).toBeCloseTo(expected, 12);
  source.carrier = true;
  expect(sampleFM(instrument, createFMVoice(), 220, 44_100)[0]).toBeCloseTo(
    expected + sourceRaw / 6,
    12,
  );
});

test("feedback uses raw output even when the source amplitude is zero", () => {
  const instrument = createInstrument("FM (n-op)");
  const carrier = required(instrument.operators[0]);
  const source = required(instrument.operators[1]);
  for (const op of instrument.operators) {
    if (!op.carrier) {
      op.amplitude = 0;
    }
  }
  instrument.connections = [];
  instrument.feedback = [{ from: source.id, to: carrier.id }];
  instrument.feedbackVolume = 0.5;
  const state = createFMVoice();
  const clean = createFMVoice();
  const reference = { ...instrument, feedbackVolume: 0 };
  const samples = Array.from({ length: 128 }, () => sampleFM(instrument, state, 220, 44_100));
  expect(samples).not.toEqual(samples.map(() => sampleFM(reference, clean, 220, 44_100)));
});

test("self feedback reads the previous raw sample", () => {
  const instrument = singleCarrier();
  const carrier = required(instrument.operators[0]);
  carrier.phase = 90;
  instrument.feedback = [{ from: carrier.id, to: carrier.id }];
  instrument.feedbackVolume = 0.5;
  const state = createFMVoice();
  expect(sampleFM(instrument, state, 220, 44_100)[0]).toBeCloseTo(1 / 3, 12);
  expect(sampleFM(instrument, state, 220, 44_100)[0]).toBeCloseTo(
    Math.sin(2 * Math.PI * (0.25 + 220 / 44_100 + 0.15)) / 3,
    12,
  );
});

test("feedback taps the waveform before source polarity and amplitude", () => {
  const instrument = createInstrument("FM (n-op)");
  const carrier = required(instrument.operators[0]);
  const source = required(instrument.operators[1]);
  source.amplitude = 0;
  instrument.connections = [];
  instrument.feedback = [{ from: source.id, to: carrier.id }];
  instrument.feedbackVolume = 0.5;
  const inverted = structuredClone(instrument);
  required(inverted.operators[1]).invert = true;
  const normalVoice = createFMVoice();
  const invertedVoice = createFMVoice();
  for (let i = 0; i < 256; i++) {
    expect(sampleFM(inverted, invertedVoice, 220, 44_100)).toEqual(
      sampleFM(instrument, normalVoice, 220, 44_100),
    );
  }
});

test("reordered graphs compute dependencies and preserve operator phases by identity", () => {
  const instrument = createInstrument("FM (n-op)");
  const carrier = required(instrument.operators[0]);
  const modulator = required(instrument.operators[1]);
  instrument.connections = [{ from: modulator.id, to: carrier.id }];
  const first = createFMVoice();
  const second = createFMVoice();
  for (let i = 0; i < 128; i++) {
    const reordered = { ...instrument, operators: [...instrument.operators].reverse() };
    expect(sampleFM(reordered, second, 220, 44_100)).toEqual(
      sampleFM(instrument, first, 220, 44_100),
    );
  }
});

test("editing operators preserves their phase seeds and gives new identities independent randomness", () => {
  const instrument = createInstrument("FM (n-op)");
  instrument.operators = instrument.operators.slice(0, 2);
  instrument.connections = [];
  instrument.phaseRandomness = 1;
  const state = createFMVoice([0.1, 0.2]);
  sampleFM(instrument, state, 220, 44_100);
  expect(state.random).toEqual([0.1, 0.2]);

  const { random } = Math;
  let seed = 0.7;
  try {
    Math.random = (): number => {
      seed += 0.1;
      return seed;
    };
    const inserted = createFMOperator();
    const next = { ...instrument, operators: [inserted, ...instrument.operators.toReversed()] };
    sampleFM(next, state, 220, 44_100);
    expect(state.random[0]).toBeCloseTo(0.8, 12);
    expect(state.random[1]).toBe(0.2);
    expect(state.random[2]).toBe(0.1);
    const replaced = {
      ...next,
      operators: [createFMOperator(), ...next.operators.slice(1).toReversed()],
    };
    sampleFM(replaced, state, 220, 44_100);
    expect(state.random[0]).toBeCloseTo(0.9, 12);
    expect(state.random[1]).toBe(0.1);
    expect(state.random[2]).toBe(0.2);
    expect(new Set(state.random).size).toBe(3);
  } finally {
    Math.random = random;
  }
});

test("operator envelopes control linear levels, offset, tuning, and stereo parameters", () => {
  const instrument = singleCarrier();
  const carrier = required(instrument.operators[0]);
  carrier.amplitude = 0.5;
  carrier.ratio = 4;
  carrier.offset = 20;
  carrier.coarse = 12;
  carrier.fine = 100;
  carrier.stereoDetune = 100;
  const values = new Map([
    [`operator:${carrier.id}:ratio`, 0.5],
    [`operator:${carrier.id}:offset`, 0],
    [`operator:${carrier.id}:coarse`, 0],
    [`operator:${carrier.id}:fine`, 0],
    [`operator:${carrier.id}:stereoDetune`, 0],
  ]);
  const state = createFMVoice();
  sampleFM(instrument, state, 220, 44_100, (target, base) => values.get(target) ?? base);
  expect(state.phases[0]).toEqual([440 / 44_100, 440 / 44_100]);
  carrier.phase = 90;
  expect(
    sampleFM(instrument, createFMVoice(), 220, 44_100, (target, base) =>
      target === `operator:${carrier.id}:amplitude` ? 0 : base,
    ),
  ).toEqual([0, 0]);
  expect(
    sampleFM(instrument, createFMVoice(), 220, 44_100, (target, base) =>
      target === `operator:${carrier.id}:pan` ? 1 : base,
    )[0],
  ).toBeCloseTo(0, 12);
});

test("cached FM controls follow envelopes, pitch changes, and operator edits", () => {
  const instrument = createInstrument("FM (n-op)");
  const carrier = required(instrument.operators[0]);
  const modulator = required(instrument.operators[1]);
  carrier.stereoPhase = 35;
  modulator.carrier = true;
  instrument.phaseRandomness = 0.3;
  instrument.feedback = [{ from: modulator.id, to: carrier.id }];
  const cached = createFMVoice([0.1, 0.2, 0.3, 0.4]);
  const reference = createFMVoice([0.1, 0.2, 0.3, 0.4]);
  for (let frame = 0; frame < 512; frame++) {
    const stage = Math.floor(frame / 32);
    if (frame % 64 === 0) {
      carrier.ratio = stage + 1;
      carrier.phase = stage * 15;
      carrier.invert = stage % 4 === 0;
      modulator.coarse = stage - 12;
      modulator.fine = stage * 3;
      modulator.offset = stage - 4;
      modulator.stereoDetune = stage * 2;
      modulator.amplitude = stage / 16;
      modulator.pan = stage / 8 - 1;
    }
    const values = new Map([
      ["feedbackVolume", stage / 16],
      [`operator:${carrier.id}:coarse`, stage - 4],
      [`operator:${carrier.id}:fine`, stage * 3],
      [`operator:${carrier.id}:ratio`, stage / 8],
      [`operator:${carrier.id}:offset`, stage - 8],
      [`operator:${carrier.id}:stereoDetune`, stage * 10 - 80],
      [`operator:${carrier.id}:amplitude`, (stage % 8) / 8],
      [`operator:${carrier.id}:pan`, stage / 8 - 1],
      [`operator:${modulator.id}:ratio`, 0.5 + frame / 512],
    ]);
    const parameter = (target: string, base: number): number => values.get(target) ?? base;
    const frequency = stage % 5 === 0 ? 0 : 110 + stage * 25;
    const sampleRate = stage % 2 === 0 ? 44_100 : 48_000;
    // Recompiling the reference every frame discards transformed controls while retaining oscillator state.
    expect(sampleFM(instrument, cached, frequency, sampleRate, parameter)).toEqual(
      sampleFM({ ...instrument }, reference, frequency, sampleRate, parameter),
    );
  }
});

test("FM bindings skip unmodulated controls while retaining edits and changing envelopes", () => {
  const instrument = singleCarrier();
  const carrier = required(instrument.operators[0]);
  carrier.wave = "pulse width";
  const amplitudeTarget = `operator:${carrier.id}:amplitude`;
  const widthTarget = `operator:${carrier.id}:pulseWidth`;
  const coarseTarget = `operator:${carrier.id}:coarse`;
  const bound = createFMVoice([0.2]);
  const reference = createFMVoice([0.2]);
  let targets = new Set([amplitudeTarget, widthTarget]);
  for (let frame = 0; frame < 256; frame++) {
    if (frame === 64) {
      targets = new Set([amplitudeTarget, coarseTarget]);
    }
    if (frame === 128) {
      targets = new Set();
    }
    carrier.coarse = Math.floor(frame / 32) - 4;
    carrier.pan = frame / 128 - 1;
    carrier.stereoDetune = frame / 4;
    carrier.ratio = 1 + Math.floor(frame / 64);
    const currentTargets = targets;
    const calls: string[] = [];
    const parameter = (target: string, base: number): number => {
      if (!currentTargets.has(target)) {
        return base;
      }
      return target === widthTarget ? 0.1 + frame / 512 : base * (0.4 + frame / 512);
    };
    const actual = sampleFM(
      instrument,
      bound,
      220,
      44_100,
      (target, base) => {
        calls.push(target);
        return parameter(target, base);
      },
      currentTargets,
    );
    expect(actual).toEqual(sampleFM(instrument, reference, 220, 44_100, parameter));
    expect(new Set(calls)).toEqual(currentTargets);
  }
});

test("polarity inversion is independent of frequency offset", () => {
  const instrument = singleCarrier();
  const carrier = required(instrument.operators[0]);
  carrier.offset = 1.5;
  const reference = structuredClone(instrument);
  required(reference.operators[0]).offset = 0;
  required(reference.operators[0]).ratio = 1 + 1.5 / 220;
  const first = createFMVoice();
  const second = createFMVoice();
  for (let i = 0; i < 128; i++) {
    expect(sampleFM(instrument, first, 220, 44_100)).toEqual(
      sampleFM(reference, second, 220, 44_100),
    );
  }
  carrier.invert = true;
  const inverted = createFMVoice();
  const normal = createFMVoice();
  for (let i = 0; i < 128; i++) {
    const a = sampleFM(instrument, inverted, 220, 44_100);
    const b = sampleFM(reference, normal, 220, 44_100);
    expect(a[0]).toBeCloseTo(-b[0], 12);
    expect(a[1]).toBeCloseTo(-b[1], 12);
  }
});

test("pulse-width envelopes affect waveform rendering on every sample", () => {
  const instrument = singleCarrier();
  const carrier = required(instrument.operators[0]);
  carrier.wave = "pulse width";
  carrier.phase = 90;
  const state = createFMVoice();
  let width = 0.1;
  expect(
    sampleFM(instrument, state, 220, 44_100, (target, base) =>
      target === `operator:${carrier.id}:pulseWidth` ? width : base,
    ),
  ).toEqual([-1 / 3, -1 / 3]);
  width = 0.8;
  expect(
    sampleFM(instrument, state, 220, 44_100, (target, base) =>
      target === `operator:${carrier.id}:pulseWidth` ? width : base,
    ),
  ).toEqual([1 / 3, 1 / 3]);
});

test("ten-operator graphs support custom waves with DC removal", () => {
  const instrument = createInstrument("FM (n-op)");
  const template = required(instrument.operators[0]);
  instrument.operators = Array.from({ length: 10 }, (_, index) => ({
    ...template,
    id: `op-${index}`,
    carrier: index === 0,
    amplitude: 0.4,
    ratio: index + 1,
  }));
  instrument.connections = instrument.operators.slice(1).map((operator, index) => ({
    from: operator.id,
    to: required(instrument.operators[index]).id,
  }));
  required(instrument.operators[9]).wave = "Custom";
  const state = createFMVoice();
  let energy = 0;
  for (let i = 0; i < 512; i++) {
    const sample = sampleFM(instrument, state, 220, 44_100);
    expect(sample.every(Number.isFinite)).toBe(true);
    energy += sample[0] ** 2;
  }
  expect(energy).toBeGreaterThan(0);
  expect(
    waveSample(
      "Custom",
      0.3,
      220,
      44_100,
      0.5,
      Array.from({ length: 64 }, () => 12),
    ),
  ).toBe(0);
});

test("periodic FM operators suppress frequencies above Nyquist", () => {
  const instrument = singleCarrier();
  required(instrument.operators[0]).ratio = 100;
  const state = createFMVoice();
  for (let i = 0; i < 32; i++) {
    expect(sampleFM(instrument, state, 1000, 44_100)).toEqual([0, 0]);
  }
});

test("periodic stereo histories remain independent after detune returns to zero", () => {
  const instrument = singleCarrier();
  const carrier = required(instrument.operators[0]);
  carrier.stereoDetune = 100;
  const state = createFMVoice([0]);
  for (let frame = 0; frame < 64; frame++) {
    sampleFM(instrument, state, 220, 44_100);
  }
  carrier.stereoDetune = 0;
  const phase = [...required(state.phases[0])];
  const sample = sampleFM(instrument, state, 220, 44_100);
  expect(sample[0]).toBe(waveSample("sine", required(phase[0]), 220, 44_100) / 3);
  expect(sample[1]).toBe(waveSample("sine", required(phase[1]), 220, 44_100) / 3);
  expect(sample[0]).not.toBe(sample[1]);
});

test("FM phase advancement retains signed zero, wraps and out-of-cycle phase values", () => {
  const instrument = singleCarrier();
  const state = createFMVoice([0]);
  sampleFM(instrument, state, 220, 48_000);
  const phases = required(state.phases[0]);
  for (const frequency of [0, 220, 144_000]) {
    for (const phase of [
      -1.5,
      -1,
      -0,
      0,
      Number.MIN_VALUE,
      0.5,
      1 - Number.EPSILON / 2,
      1,
      2,
      Number.MAX_SAFE_INTEGER,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ]) {
      phases[0] = phase;
      phases[1] = phase;
      sampleFM(instrument, state, frequency, 48_000);
      const expected = (phase + frequency / 48_000) % 1;
      expect(phases).toEqual([expected, expected]);
    }
  }
});

test("prebound FM routes retain history through graph insertion, reordering and removal", () => {
  let instrument = createInstrument("FM (n-op)");
  const edit = (changes: Partial<Instrument>): void => {
    instrument = { ...instrument, ...changes };
  };
  instrument.phaseRandomness = 0.5;
  const initial = [...instrument.operators];
  const first = required(initial[0]);
  const last = required(initial.at(-1));
  instrument.feedback = [{ from: first.id, to: last.id }];
  instrument.feedbackVolume = 0.4;
  const inserted = createFMOperator();
  const cached = createFMVoice([0.1, 0.2, 0.3, 0.4]);
  const reference = createFMVoice([0.1, 0.2, 0.3, 0.4]);
  const { random } = Math;
  try {
    Math.random = (): number => 0.37;
    for (let frame = 0; frame < 384; frame++) {
      if (frame === 64) {
        edit({
          operators: instrument.operators.toReversed(),
        });
      } else if (frame === 128) {
        edit({
          operators: [inserted, ...instrument.operators],
          connections: [...instrument.connections, { from: inserted.id, to: first.id }],
          feedback: [{ from: first.id, to: inserted.id }],
        });
      } else if (frame === 192) {
        edit({
          feedback: [
            { from: inserted.id, to: last.id },
            { from: last.id, to: first.id },
          ],
        });
      } else if (frame === 256) {
        edit({
          operators: instrument.operators.filter((operator) => operator.id !== inserted.id),
          connections: instrument.connections.filter((edge) => edge.from !== inserted.id),
          feedback: instrument.feedback.filter((edge) => edge.from !== inserted.id),
        });
      }
      expect(sampleFM(instrument, cached, 220, 44_100)).toEqual(
        sampleFM({ ...instrument }, reference, 220, 44_100),
      );
    }
  } finally {
    Math.random = random;
  }
});

test("prepared FM waveforms follow live shape, duty and custom drawing edits", () => {
  const instrument = singleCarrier();
  const carrier = required(instrument.operators[0]);
  carrier.stereoPhase = 35;
  const cached = createFMVoice([0.2]);
  const reference = createFMVoice([0.2]);
  const shapes = [
    "sine",
    "SINE",
    "pulse",
    "Square",
    "White Noise",
    "noise",
    "Custom",
    "trapezoid",
    "quasi-sine",
    "spiky",
    "sawtooth",
    "ramp",
    "sine",
  ];
  const { random } = Math;
  try {
    for (let frame = 0; frame < shapes.length * 16; frame++) {
      const stage = Math.floor(frame / 16);
      carrier.wave = required(shapes[stage]);
      carrier.pulseWidth = (frame % 9) / 8;
      carrier.customWave = Array.from({ length: 64 }, (_, i) => Math.sin(i / 10 + stage) * 20);
      let seed = frame + 12_345;
      Math.random = (): number => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 4_294_967_296;
      };
      const actual = sampleFM(instrument, cached, 220, 44_100);
      seed = frame + 12_345;
      expect(actual).toEqual(sampleFM({ ...instrument }, reference, 220, 44_100));
    }
  } finally {
    Math.random = random;
  }
});

test("identical noise oscillator inputs retain independent stereo draws", () => {
  const instrument = singleCarrier();
  required(instrument.operators[0]).wave = "White Noise";
  const state = createFMVoice([0]);
  const { random } = Math;
  let draws = 0;
  try {
    Math.random = (): number => (++draws === 1 ? 0.25 : 0.75);
    expect(sampleFM(instrument, state, 220, 44_100)).toEqual([-1 / 6, 1 / 6]);
    expect(draws).toBe(2);
  } finally {
    Math.random = random;
  }
});
