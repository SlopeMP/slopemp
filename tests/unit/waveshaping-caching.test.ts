import { expect, test } from "bun:test";

import { processEffect } from "../../src/audio";
import { createEffect } from "../../src/instruments";
import { required } from "../../src/model";

// Samples recorded before optimization include in-place edits, temporary
// automation overrides, and restoration of the saved controls.
for (const { type, expected } of [
  {
    type: "Gain",
    expected: [
      [0.7909214102813759, 0.3255513826650136],
      [0.24061395794879115, 0.08484780058174467],
      [-0.25529686536432833, -0.04047555867322429],
      [-0.9054796513046705, -0.6297165564407119],
      [0.20691838061872667, -0.141802611588344],
    ],
  },
  {
    type: "Fuzz",
    expected: [
      [0.9912112875073036, 0.8575381759049268],
      [0.9999999041064023, 0.996649068599209],
      [-0.9999999892262657, -0.9801272267789949],
      [-0.7336892731661777, -0.5216514099868466],
      [0.9999969396356471, -0.9999779829878087],
    ],
  },
  {
    type: "Soft Clipping",
    expected: [
      [0.6501094271553616, 0.40450178595140107],
      [0.35479852255429867, 0.3392708300940473],
      [-0.3548056854328448, -0.25520731731154606],
      [-0.4758937663473369, -0.3520773933789518],
      [0.354746184164027, -0.3535749370690673],
    ],
  },
  {
    type: "Hard Clipping",
    expected: [
      [0.251188643150958, 0.251188643150958],
      [0.251188643150958, 0.251188643150958],
      [-0.251188643150958, -0.251188643150958],
      [-0.6410305019867607, -0.44580518148909803],
      [0.251188643150958, -0.251188643150958],
    ],
  },
  {
    type: "Wavefolding",
    expected: [
      [-0.014598195936335578, 0.9633226309732322],
      [-0.9754098677569981, -0.6110755578601184],
      [0.6219274292574909, 0.8716926301785803],
      [-0.42687158712760404, -0.24333738269340094],
      [-0.9395586005139199, -0.9870525233831937],
    ],
  },
  {
    type: "Rectification",
    expected: [
      [1.578095684036469, 0.6495604054175146],
      [1.3530717197221813, 0.4771342461862476],
      [0, 0],
      [0, 0],
      [1.1635875636337578, 0],
    ],
  },
]) {
  test(`${type} preserves stereo shaping through edits and automation`, () => {
    const effect = createEffect(type);
    const frames = [2, 3, 6, 8, 10];
    for (let frame = 0; frame < 12; frame++) {
      if (frame === 3) {
        effect.parameters["drive"] = 18;
        effect.parameters["gain"] = -9;
        effect.parameters["mode"] = "Half";
      }
      if (frame === 6) {
        effect.parameters["threshold"] = -12;
        effect.parameters["folds"] = 4;
        effect.parameters["bias"] = -0.4;
      }
      const input: [number, number] = [Math.sin(frame * 0.71) * 0.8, Math.cos(frame * 0.31) * 0.4];
      const overrides =
        frame >= 8 && frame < 10
          ? { drive: 3, gain: 6, threshold: -2, folds: 1, bias: 0.2 }
          : undefined;
      const actual = processEffect(input, effect, 1000, frame / 1000, overrides);
      const index = frames.indexOf(frame);
      if (index !== -1) {
        const reference = required(expected[index]);
        expect(actual[0]).toBeCloseTo(required(reference[0]), 14);
        expect(actual[1]).toBeCloseTo(required(reference[1]), 14);
      }
      expect(processEffect(input, structuredClone(effect), 1000, frame / 1000, overrides)).toEqual(
        actual,
      );
    }
  });
}
