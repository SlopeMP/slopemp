import { expect, test } from "bun:test";

import { prepareEffectProcessor, processEffect, resetEffects } from "../../src/audio";
import { createEffect } from "../../src/instruments";
import { required } from "../../src/model";
import reference from "../fixtures/chorus-reference.json";

const inputSample = (frame: number, sampleRate: number): [number, number] => {
  if (frame === 0) {
    return [1, -0.6];
  }
  if (frame === 127) {
    return [0, 0.75];
  }
  if (frame < 1000 || frame >= Math.floor(sampleRate * 2.125)) {
    return [0, 0];
  }
  const seconds = frame / sampleRate;
  return [
    0.22 * Math.sin(2 * Math.PI * 220 * seconds) +
      0.11 * Math.sin(2 * Math.PI * 329.6275569 * seconds),
    0.19 * Math.sin(2 * Math.PI * 277.182631 * seconds) +
      0.09 * Math.cos(2 * Math.PI * 440 * seconds),
  ];
};

// The fixture comes from a separate implementation. See license/README.md for its source.
// Sparse samples cover stereo impulses, two-second phase wrap, and the full tail;
// energy windows also detect errors between the selected sample positions.
for (const scenario of reference.cases) {
  for (const mode of ["public", "bound"]) {
    test(`Chorus ${mode} matches the reference at amount ${scenario.amount} and ${scenario.sampleRate} Hz`, () => {
      const effect = createEffect("Chorus");
      effect.parameters["amount"] = (scenario.amount / 3) * 100;
      const bound = prepareEffectProcessor(effect, scenario.sampleRate);
      const checkpoints = new Map(
        scenario.checkpoints.map((sample) => [required(sample[0]), sample]),
      );
      const energy = Array.from({ length: scenario.energy.length }, (): [number, number] => [0, 0]);
      let finite = true;
      for (let frame = 0; frame < scenario.frames; frame++) {
        const input = inputSample(frame, scenario.sampleRate);
        // An effect starts its own phase when added during an existing song.
        const seconds = 123.5 + frame / scenario.sampleRate;
        const actual =
          mode === "bound"
            ? bound(input, seconds)
            : processEffect(input, effect, scenario.sampleRate, seconds);
        finite &&= actual.every(Number.isFinite);
        const expected = checkpoints.get(frame);
        if (expected) {
          expect(actual[0]).toBeCloseTo(required(expected[1]), 9);
          expect(actual[1]).toBeCloseTo(required(expected[2]), 9);
        }
        const window = required(energy[Math.floor(frame / 4096)]);
        window[0] += actual[0] * actual[0];
        window[1] += actual[1] * actual[1];
      }
      expect(finite).toBe(true);
      for (const [index, window] of energy.entries()) {
        const expected = required(scenario.energy[index]);
        expect(window[0]).toBeCloseTo(required(expected[0]), 8);
        expect(window[1]).toBeCloseTo(required(expected[1]), 8);
      }
    });
  }
}

for (const mode of ["public", "bound"]) {
  test(`Chorus ${mode} applies edits and temporary overrides without losing delay history`, () => {
    const effect = createEffect("Chorus");
    const comparison = createEffect("Chorus");
    const sampleRate = 8000;
    const bound = prepareEffectProcessor(effect, sampleRate);
    for (let frame = 0; frame < 5000; frame++) {
      if (frame === 300) {
        effect.parameters["amount"] = 25;
      }
      if (frame === 2000) {
        effect.parameters = { amount: 67 };
      }
      const overrides = frame >= 1000 && frame < 1500 ? { amount: 80 } : undefined;
      comparison.parameters["amount"] = overrides?.amount ?? required(effect.parameters["amount"]);
      const input = inputSample(frame, sampleRate);
      const seconds = frame / sampleRate;
      const actual =
        mode === "bound"
          ? bound(input, seconds, overrides)
          : processEffect(input, effect, sampleRate, seconds, overrides);
      expect(actual).toEqual(processEffect(input, comparison, sampleRate, seconds));
    }
    expect(effect.parameters["amount"]).toBe(67);
  });
}

test("Chorus duplicates have independent tails, and reset clears both history and phase", () => {
  const effect = createEffect("Chorus");
  const duplicate = structuredClone(effect);
  const fresh = createEffect("Chorus");
  const sampleRate = 8000;
  let heardTail = false;
  for (let frame = 0; frame < 150; frame++) {
    const output = processEffect(frame === 0 ? [1, -1] : [0, 0], effect, sampleRate, 0);
    heardTail ||= frame > 0 && output.some((sample) => sample !== 0);
    expect(processEffect([0, 0], duplicate, sampleRate, 0)).toEqual([0, 0]);
  }
  expect(heardTail).toBe(true);
  resetEffects([effect]);
  const rebound = prepareEffectProcessor(effect, sampleRate);
  for (let frame = 0; frame < 1500; frame++) {
    const input = inputSample(frame, sampleRate);
    expect(rebound(input, frame / sampleRate)).toEqual(
      processEffect(input, fresh, sampleRate, frame / sampleRate),
    );
  }
});
