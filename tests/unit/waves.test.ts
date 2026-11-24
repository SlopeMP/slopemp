import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { waveSample } from "../../src/audio";
import { classifyWave, sampleWaveform } from "../../src/synth/waves";

const cycle = (value: (phase: number) => number): number[] =>
  Array.from({ length: 64 }, (_, index): number => value(index / 64) * 24);
const rms = (values: number[]): number =>
  Math.sqrt(values.reduce((sum, value): number => sum + value * value, 0) / values.length);
const readCycle = (drawing: number[], frequency: number): number[] =>
  Array.from({ length: 2048 }, (_, index): number =>
    waveSample("Custom", index / 2048, frequency, 48_000, 0.5, drawing),
  );

test("prepared waveforms retain exact samples across pitch, phase and duty limits", () => {
  // Recorded before classifying oscillator shapes. Include mixed-case aliases,
  // ambiguous names, noise draw order, Nyquist limits and invalid control values.
  const expected = {
    Sine: "4b65e36aa22f80849149dc063c662fb20a8aa1cb6250c76ebf6ae0b28c9566d1",
    unknown: "4b65e36aa22f80849149dc063c662fb20a8aa1cb6250c76ebf6ae0b28c9566d1",
    sawtooth: "6740bf8cedfad1b8e5e04f0c76b9c531c73faf4e846a131afb3e2cf70a212127",
    ramp: "e5b216c12d7914a3be15919b9e6f96b95130107a2d2dde1369082609c2360bfc",
    "Saw pulse": "6740bf8cedfad1b8e5e04f0c76b9c531c73faf4e846a131afb3e2cf70a212127",
    Pulse: "0c34f35dddfe6d16c004cd6108cd64a4491fe282069ad8555866a2d7eb135f69",
    Square: "51185b200184edb731b5db5e829129511e43c4ea72139882b1152caec4fec2bb",
    "1/4 pulse": "e4b064ed5e38d1e3ec3bfe5ec10ae50cdbcacf3cad4ff7eda00b799aaa89c566",
    "1/8 pulse": "616d7cc12d627a0b34be7eb075af19400b6c19443a380b102bff916fe1f72515",
    triangle: "f6a66bf00b6c29c5dc4d9f597dd373c607b56df5ad986862ba6229e35cc23392",
    trapezoid: "0b4232f33fff581a24aa1f73ff7766c3365626b2c2efc4f6895e4c7029cd5070",
    "quasi-sine": "9001a285d5173f154ae322d2495078cf58d01aa882499090c15c72631e557677",
    spiky: "47bf8468032e26d35a6e480e6a28e91d9623cd4880a60895e5b147beb7c29c4f",
    Custom: "a84b9c06272ed4bb856c60877f35a095dee7e96548c4e4cce734856a3404eaa1",
    NOISE: "207e1072a5b75e10a8cab8846a629e3d0cb3f430a283a6e966733009127afb22",
    "White Noise": "207e1072a5b75e10a8cab8846a629e3d0cb3f430a283a6e966733009127afb22",
  };
  const drawing = Array.from({ length: 64 }, (_, i) => 12 * Math.sin(i / 10) + 4 * Math.cos(i / 3));
  const { random } = Math;
  try {
    for (const [wave, hash] of Object.entries(expected)) {
      const waveform = classifyWave(wave);
      let seed = 12_345;
      Math.random = (): number => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 4_294_967_296;
      };
      const samples: number[] = [];
      for (const sampleRate of [44_100, 48_000]) {
        for (const frequency of [0, 440, 10_000, 22_000, 24_000, -1]) {
          for (const phase of [-2.125, -0.01, 0, 0.1, 0.25, 0.999, 1.375, Number.NaN]) {
            for (const width of [0.01, 0.37, 0.99, Number.NaN]) {
              samples.push(sampleWaveform(waveform, phase, frequency, sampleRate, width, drawing));
            }
          }
        }
      }
      expect(createHash("sha256").update(new Float64Array(samples)).digest("hex"), wave).toBe(hash);
    }
  } finally {
    Math.random = random;
  }
});

test("phase normalization retains exact rounding near boundaries and across large phases", () => {
  const phases = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0];
  for (const boundary of [-2, -1, -0.5, 0, 0.5, 1, 2, Number.MAX_SAFE_INTEGER, 1e100]) {
    const step = Math.max(Number.MIN_VALUE, (Math.abs(boundary) * Number.EPSILON) / 2);
    phases.push(boundary - step, boundary, boundary + step);
  }
  let seed = 12_345;
  for (let index = 0; index < 4096; index++) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    phases.push((seed / 2_147_483_648 - 1) * 2 ** ((index % 100) - 50));
  }
  for (const frequency of [0, 440, 24_000]) {
    for (const phase of phases) {
      const expected =
        frequency >= 48_000 * 0.48 ? 0 : Math.sin((((phase % 1) + 1) % 1) * Math.PI * 2);
      expect(sampleWaveform("sine", phase, frequency, 48_000)).toBe(expected);
    }
  }
});

describe("bandlimited custom periodic sources", (): void => {
  test("a high partial sounds below the cutoff and is removed before it can fold down", (): void => {
    const drawing = cycle((phase): number => Math.sin(phase * Math.PI * 2 * 31));
    expect(rms(readCycle(drawing, 200))).toBeCloseTo(Math.SQRT1_2, 5);
    expect(rms(readCycle(drawing, 2000))).toBeLessThan(1e-10);
  });
  test("pitch modulation removes high partials without normalizing remaining partial gains", (): void => {
    const drawing = cycle(
      (phase): number =>
        0.5 * Math.sin(phase * Math.PI * 2) + 0.25 * Math.sin(phase * Math.PI * 14),
    );
    const high = readCycle(drawing, 5000);
    for (let index = 0; index < high.length; index++) {
      expect(high[index] ?? 0).toBeCloseTo(0.5 * Math.sin((index / 2048) * Math.PI * 2), 6);
    }
    expect(rms(readCycle(drawing, 100))).toBeCloseTo(Math.sqrt((0.5 ** 2 + 0.25 ** 2) / 2), 5);
  });
  test("the full source cycle retains signed amplitudes and seam while removing only DC", (): void => {
    const drawing = cycle(
      (phase): number =>
        0.2 + 0.4 * Math.sin(phase * Math.PI * 2) + 0.1 * Math.cos(phase * Math.PI * 64),
    );
    const snapshot = [...drawing];
    for (let index = 0; index < 64; index++) {
      const expected = (drawing[index] ?? 0) / 24 - 0.2;
      expect(waveSample("Custom", index / 64, 100, 48_000, 0.5, drawing)).toBeCloseTo(expected, 6);
    }
    expect(waveSample("Custom", 1, 100, 48_000, 0.5, drawing)).toBe(
      waveSample("Custom", 0, 100, 48_000, 0.5, drawing),
    );
    expect(drawing).toEqual(snapshot);
    expect(rms(readCycle(Array<number>(64).fill(12), 100))).toBeLessThan(1e-10);
  });
  test("a replacement drawing immediately changes playback while another drawing remains independent", (): void => {
    const first = cycle((phase): number => Math.sin(phase * Math.PI * 2));
    const second = first.map((value): number => value / 2);
    const original = readCycle(first, 440);
    const replacement = readCycle(second, 440);
    expect(rms(replacement)).toBeCloseTo(rms(original) / 2, 6);
    expect(readCycle(first, 440)).toEqual(original);
  });
  test("square retains its fixed half-cycle duty independently of saved pulse width", (): void => {
    for (let index = 0; index < 128; index++) {
      const phase = index / 128;
      expect(waveSample("Square", phase, 440, 48_000, 0.1)).toBe(
        waveSample("Square", phase, 440, 48_000, 0.9),
      );
    }
    expect(waveSample("Pulse", 0.3, 440, 48_000, 0.1)).not.toBe(
      waveSample("Pulse", 0.3, 440, 48_000, 0.9),
    );
  });
  test("noise ignores retained pitch offsets that would silence a periodic oscillator", (): void => {
    expect(waveSample("Sine", 0.25, 120_000, 48_000)).toBe(0);
    const values = Array.from({ length: 256 }, (): number =>
      waveSample("White Noise", 0.25, 120_000, 48_000),
    );
    expect(
      values.every((value): boolean => Number.isFinite(value) && value >= -1 && value <= 1),
    ).toBe(true);
    expect(rms(values)).toBeGreaterThan(0.1);
  });
  test("builtin shaped cycles suppress upper partials without boosting the fundamental", (): void => {
    for (let index = 0; index < 2048; index++) {
      const phase = index / 2048;
      expect(waveSample("spiky", phase, 100, 48_000)).toBeCloseTo(
        Math.sin(phase * Math.PI * 2) ** 7,
        12,
      );
      expect(waveSample("spiky", phase, 10_000, 48_000)).toBeCloseTo(
        (Math.sin(phase * Math.PI * 2) * 35) / 64,
        12,
      );
      expect(waveSample("quasi-sine", phase, 14_000, 48_000)).toBeCloseTo(
        Math.sin(phase * Math.PI * 2) * 0.8,
        12,
      );
    }
    const third = (frequency: number): number =>
      Math.abs(
        (Array.from(
          { length: 2048 },
          (_, index): number =>
            waveSample("trapezoid", index / 2048, frequency, 48_000) *
            Math.sin((index / 2048) * Math.PI * 6),
        ).reduce((sum, value): number => sum + value, 0) *
          2) /
          2048,
      );
    expect(third(100)).toBeGreaterThan(0.05);
    expect(third(14_000)).toBeLessThan(1e-6);
    expect(waveSample("trapezoid", 0.25, 14_000, 48_000)).toBeGreaterThan(0.5);
  });
});
