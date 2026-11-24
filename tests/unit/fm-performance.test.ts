import { expect, test } from "bun:test";

import { createInstrument } from "../../src/instruments";
import type { Instrument } from "../../src/instruments";
import { required } from "../../src/model";
import { createFMVoice, sampleFM } from "../../src/synth/fm";

const fixture = (wave: string, stereo: boolean): Instrument => {
  const patch = createInstrument("FM (n-op)");
  patch.phaseRandomness = 0.2;
  patch.feedbackVolume = 0.3;
  patch.feedback = [{ from: required(patch.operators[2]).id, to: required(patch.operators[0]).id }];
  for (const [index, operator] of patch.operators.entries()) {
    operator.wave = wave;
    operator.phase = index * 17;
    operator.offset = index * 3;
    operator.pan = index % 2 ? 0.5 : -0.2;
    operator.carrier = index === 0 || index === 3;
    operator.stereoDetune = stereo ? index * 7 : 0;
    operator.stereoPhase = stereo ? index * 11 : 0;
  }
  return patch;
};

for (const wave of ["sine", "triangle", "sawtooth", "pulse width", "Custom", "white noise"]) {
  for (const stereo of [false, true]) {
    test(`prepared FM preserves every ${stereo ? "stereo" : "mono"} ${wave} sample, feedback and control edits`, () => {
      const patch = fixture(wave, stereo);
      const { random } = Math;
      const render = (
        prepared: boolean,
      ): { samples: Float64Array; phases: number[][]; raw: number[][] } => {
        const instrument = structuredClone(patch);
        const state = createFMVoice([0.1, 0.2, 0.3, 0.4]);
        const targets = new Set<string>();
        const samples = new Float64Array(4096);
        let seed = 1234;
        Math.random = (): number => {
          seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
          return seed / 4_294_967_296;
        };
        for (let frame = 0; frame < 2048; frame++) {
          if (frame > 0 && frame % 256 === 0) {
            for (const operator of instrument.operators) {
              operator.amplitude *= 0.9;
              operator.phase += 13;
              operator.invert = !operator.invert;
              operator.pan = -operator.pan;
              operator.ratio += 0.25;
              operator.pulseWidth = 0.1 + frame / 4096;
              operator.stereoDetune = frame >= 1024 ? 0 : operator.stereoDetune;
            }
            required(instrument.operators[3]).carrier = frame % 512 === 0;
          }
          const frequency = 220 + Math.floor(frame / 64) * 3;
          const pair = sampleFM(
            instrument,
            state,
            frequency,
            44_100,
            undefined,
            targets,
            prepared ? 1 + Math.floor(frame / 256) : 0,
          );
          [samples[frame * 2], samples[frame * 2 + 1]] = pair;
        }
        return { samples, phases: state.phases, raw: state.raw };
      };
      try {
        expect(render(true)).toEqual(render(false));
      } finally {
        Math.random = random;
      }
    });
  }
}

test("FM envelopes continue evaluating each sample while other envelope bindings allow fixed controls", () => {
  const instrument = fixture("sine", true);
  const operator = required(instrument.operators[0]);
  for (const targets of [
    new Set([`operator:${operator.id}:amplitude`, "feedbackVolume"]),
    new Set(["volume"]),
  ]) {
    const reference = createFMVoice([0.1, 0.2, 0.3, 0.4]);
    const prepared = createFMVoice([0.1, 0.2, 0.3, 0.4]);
    for (let frame = 0; frame < 1024; frame++) {
      const parameter = (_target: string, value: number): number => (value * (frame % 17)) / 17;
      expect(sampleFM(instrument, prepared, 440, 48_000, parameter, targets, 1)).toEqual(
        sampleFM(instrument, reference, 440, 48_000, parameter, targets),
      );
    }
    expect(prepared.preparedBlock).toBe(targets.has("feedbackVolume") ? 0 : 1);
  }
});

test("replacing FM graph settings invalidates a prepared block without losing phase history", () => {
  let instrument = fixture("sine", false);
  const reference = createFMVoice([0.1, 0.2, 0.3, 0.4]);
  const prepared = createFMVoice([0.1, 0.2, 0.3, 0.4]);
  const targets = new Set<string>();
  for (let frame = 0; frame < 1024; frame++) {
    if (frame === 256 || frame === 512) {
      instrument = structuredClone(instrument);
      instrument.operators.reverse();
      instrument.connections.reverse();
      instrument.feedbackVolume += 0.1;
    }
    expect(sampleFM(instrument, prepared, 220, 44_100, undefined, targets, 1)).toEqual(
      sampleFM(instrument, reference, 220, 44_100, undefined, targets),
    );
  }
});

test("continuous FM pitch bends retain the general path without rebuilding fixed controls", () => {
  const instrument = fixture("sine", false);
  const reference = createFMVoice([0.1, 0.2, 0.3, 0.4]);
  const prepared = createFMVoice([0.1, 0.2, 0.3, 0.4]);
  const targets = new Set<string>();
  for (let frame = 0; frame < 1024; frame++) {
    const frequency = 220 + frame / 8;
    expect(sampleFM(instrument, prepared, frequency, 44_100, undefined, targets, 1)).toEqual(
      sampleFM(instrument, reference, frequency, 44_100, undefined, targets),
    );
  }
  expect(prepared.preparedBlock).toBe(0);
  expect(prepared.preparedOperators).toHaveLength(0);
});

test("prepared oscillators follow waveform edits and independent stereo bandwidth limits", () => {
  const instrument = fixture("Custom", true);
  const carrier = required(instrument.operators[0]);
  instrument.operators = [carrier];
  instrument.connections = [];
  instrument.feedback = [];
  carrier.stereoDetune = 36;
  const reference = createFMVoice([0.25]);
  const prepared = createFMVoice([0.25]);
  const targets = new Set<string>();
  const sampleRate = 48_000;
  const stages = [
    { wave: "Custom", frequency: 220 },
    { wave: "Custom", frequency: 220 },
    { wave: "trapezoid", frequency: 1600 },
    { wave: "sine", frequency: sampleRate * 0.48 },
    { wave: "sine", frequency: sampleRate * 0.49 },
    { wave: "sine", frequency: 220 },
  ];
  for (const [index, { wave, frequency }] of stages.entries()) {
    carrier.wave = wave;
    carrier.customWave = carrier.customWave.map((value) => -value);
    const block = index + 1;
    for (let frame = 0; frame < 32; frame++) {
      expect(
        sampleFM(instrument, prepared, frequency, sampleRate, undefined, targets, block),
      ).toEqual(sampleFM(instrument, reference, frequency, sampleRate, undefined, targets));
    }
    expect(prepared.preparedBlock).toBe(block);
    expect(prepared.phases).toEqual(reference.phases);
    expect(prepared.raw).toEqual(reference.raw);
  }
});
