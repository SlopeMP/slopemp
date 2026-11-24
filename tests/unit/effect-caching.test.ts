import { expect, test } from "bun:test";

import { processEffect } from "../../src/audio";
import { createEffect } from "../../src/instruments";
import { required } from "../../src/model";

// Recorded stereo output protects the delay history and crossfades while controls
// are edited, overridden by automation, and restored to their saved values.
for (const { type, expected } of [
  {
    type: "Vocal Doubling",
    expected: [
      [0.36757791372652915, -0.018309687149345055],
      [0.4374391263245727, -0.0809746266263367],
      [0.618573183575271, 0.3856883031524736],
      [-0.5624097838047047, -0.2252717117844515],
      [0.5572938124292851, -0.1404045070381958],
      [-0.34070760056926197, 0.3650735722769294],
    ],
  },
  {
    type: "Unison",
    expected: [
      [0.3719894758933502, -0.019081976565507808],
      [0.4374391263245727, -0.0809746266263367],
      [0.6131064294044044, 0.37291081137541493],
      [-0.5301867091161325, -0.21139931872260692],
      [0.6076552713841197, -0.09017952641076904],
      [-0.3968335861896495, 0.43270487448075234],
    ],
  },
  {
    type: "Pitch Shift",
    expected: [
      [-0.5689446926116943, 0.489344984292984],
      [-0.6998746991157532, 0.4751162827014923],
      [-0.9613974690437317, 0.0022128489799797535],
      [-0.12604424243069456, 0.1765467791670651],
      [-0.9750934890800409, -0.4737624460961309],
      [-0.13630651450612646, 0.08469786872705015],
    ],
  },
]) {
  test(`${type} retains its sound through live pitch and stereo control changes`, () => {
    const effect = createEffect(type);
    const frames = [79, 80, 120, 140, 160, 180];
    for (let frame = 0; frame <= 180; frame++) {
      if (frame === 80) {
        effect.parameters["cents"] = 35;
      }
      if (frame === 100) {
        effect.parameters["voices"] = 4;
      }
      if (frame === 120) {
        effect.parameters["spread"] = 20;
      }
      if (frame === 140) {
        effect.parameters["interval"] = 7;
      }
      const actual = processEffect(
        [Math.sin(frame * 0.17), Math.cos(frame * 0.11) * 0.5],
        effect,
        1000,
        frame / 1000,
        frame >= 160 && frame < 180
          ? { cents: 60, interval: -5, voices: 3, spread: 95 }
          : undefined,
      );
      const index = frames.indexOf(frame);
      if (index !== -1) {
        const reference = required(expected[index]);
        expect(actual[0]).toBeCloseTo(required(reference[0]), 14);
        expect(actual[1]).toBeCloseTo(required(reference[1]), 14);
      }
    }
  });
}
