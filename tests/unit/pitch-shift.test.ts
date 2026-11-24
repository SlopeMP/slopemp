import { expect, test } from "bun:test";

import { prepareEffectProcessor, processEffect } from "../../src/audio";
import { createEffect } from "../../src/instruments";

const sampleRate = 8000;
const sourceFrequency = 400;
const source = (frame: number): number =>
  Math.sin((2 * Math.PI * sourceFrequency * frame) / sampleRate);

for (const bound of [false, true]) {
  const mode = bound ? "prepared" : "public";
  const fixture = (interval: number): ((frame: number) => [number, number]) => {
    const effect = createEffect("Pitch Shift");
    effect.parameters["interval"] = interval;
    const prepared = prepareEffectProcessor(effect, sampleRate);
    return (frame): [number, number] => {
      const input: [number, number] = [source(frame), -source(frame)];
      return bound
        ? prepared(input, frame / sampleRate)
        : processEffect(input, effect, sampleRate, frame / sampleRate);
    };
  };

  test(`Pitch Shift ${mode} zero interval preserves pitch after its grain delay`, () => {
    const render = fixture(0);
    const delay = sampleRate * 0.02;
    let difference = 0;
    for (let frame = 0; frame < 2000; frame++) {
      const expected = frame < delay ? 0 : Math.fround(source(frame - delay));
      const [left, right] = render(frame);
      difference = Math.max(difference, Math.abs(left - expected), Math.abs(right + expected));
    }
    expect(difference).toBeLessThan(1e-7);
  });

  for (const interval of [-12, 12]) {
    test(`Pitch Shift ${mode} ${interval} semitones produces an exact octave`, () => {
      const render = fixture(interval);
      const frames = sampleRate * 2;
      const expectedFrequency = sourceFrequency * 2 ** (interval / 12);
      const samples = new Float64Array(sampleRate);
      let stereoDifference = 0;
      for (let frame = 0; frame < frames; frame++) {
        const [left, right] = render(frame);
        stereoDifference = Math.max(stereoDifference, Math.abs(left + right));
        if (frame >= sampleRate) {
          samples[frame - sampleRate] = left;
        }
      }
      expect(stereoDifference).toBeLessThan(1e-12);
      let strongest = 0;
      let frequency = 0;
      // Resolve pitch around the target to 0.25 Hz, well below a ten-cent error.
      for (
        let candidate = expectedFrequency - 8;
        candidate <= expectedFrequency + 8;
        candidate += 0.25
      ) {
        let real = 0;
        let imaginary = 0;
        for (let frame = 0; frame < samples.length; frame++) {
          const phase = (2 * Math.PI * candidate * frame) / sampleRate;
          real += (samples[frame] ?? 0) * Math.cos(phase);
          imaginary += (samples[frame] ?? 0) * Math.sin(phase);
        }
        const strength = real ** 2 + imaginary ** 2;
        if (strength > strongest) {
          strongest = strength;
          frequency = candidate;
        }
      }
      expect(strongest).toBeGreaterThan(1);
      expect(frequency).toBe(expectedFrequency);
    });
  }
}
