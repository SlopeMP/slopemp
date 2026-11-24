import { expect, test } from "bun:test";

import { processEffect, resetEffects } from "../../src/audio";
import type { Stereo } from "../../src/audio";
import { createEffect } from "../../src/instruments";
import { required } from "../../src/model";

test("Phaser preserves modulation, inactive stage histories, automation, tails and reset", () => {
  const effect = createEffect("Phaser");
  effect.parameters = {
    rate: 0.63,
    depth: 43.29,
    frequency: 2129,
    feedback: 53.75,
    stages: 8,
    phase: 132.79,
  };
  // Recorded before preparing the all-pass cascade. Static controls exercise
  // coefficient reuse; stage and sample-rate edits must retain filter history.
  const frames = [0, 63, 64, 95, 96, 127, 128, 159, 160, 191, 192, 223, 224, 255];
  const expected: Stereo[] = [
    [0, 0.5000652446753796],
    [-1.1502436959240159, 0.2023434382606399],
    [-0.37941868821870095, 0.5239056082835777],
    [-1.4713438182722514, 0.03161678389085171],
    [-0.64300375807256, -0.23131702809380839],
    [0.3051316394738899, 0.0745219260499288],
    [0.16193203393337885, 0.09679346217635669],
    [2.2217243121694135, 0.15614558919866292],
    [0.17170482406085352, 0.5065745900137828],
    [-0.201056700778522, -0.696008225974335],
    [-1.5006225365039965, 0.25802336959253197],
    [-0.6080541329911324, 0.032369904076939564],
    [0, 0],
    [0, 0],
  ];
  for (let frame = 0; frame <= 255; frame++) {
    if (frame === 64) {
      effect.parameters["stages"] = 3;
    }
    if (frame === 96) {
      effect.parameters["stages"] = 12;
    }
    if (frame === 128) {
      effect.parameters["depth"] = 0;
      effect.parameters["frequency"] = 1600;
    }
    if (frame === 160) {
      effect.parameters["stages"] = 4;
    }
    if (frame === 192) {
      effect.parameters["stages"] = 8;
    }
    if (frame === 224) {
      resetEffects([effect]);
    }
    const actual = processEffect(
      frame < 192 ? [Math.sin(frame * 0.17), Math.cos(frame * 0.11) * 0.5] : [0, 0],
      effect,
      frame < 160 ? 44_100 : 48_000,
      frame / 44_100,
      frame >= 64 && frame < 128
        ? { phaseRadians: 1.234, frequency: 500, feedback: 90 }
        : undefined,
    );
    const index = frames.indexOf(frame);
    if (index !== -1) {
      expect(actual).toEqual(required(expected[index]));
    }
  }
});
