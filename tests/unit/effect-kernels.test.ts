import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { prepareEffectProcessor, processEffect, resetEffects } from "../../src/audio";
import { createEffect } from "../../src/instruments";
import { required } from "../../src/model";

// Recorded before splitting the processor. Hash every stereo sample, including
// in-place edits, overrides/restoration, type switches, sample-rate edits, tails
// and reset, so cached controls cannot silently change or lose filter history.
for (const { type, hash } of [
  {
    type: "Gain",
    hash: "90b8e47dfa549e756e3c0a213389552eea4606e2b3b900e99f7e9b97b3ca612b",
  },
  {
    type: "Overdrive",
    hash: "c0da537247c3a4bb5d80283266573859b41a22ef0d4c7561f1493f2e76704cd6",
  },
  {
    type: "Soft Clipping",
    hash: "c0da537247c3a4bb5d80283266573859b41a22ef0d4c7561f1493f2e76704cd6",
  },
  {
    type: "Hard Clipping",
    hash: "cc1131acc6e6921b2a98898c8e8c6b3a98b844f31d64ea29c85e7a06b6c05f2b",
  },
  {
    type: "Fuzz",
    hash: "2a8e331533086f0d808a73ae8115fcc0732745f80fd17761f2f34832dbc88d93",
  },
  {
    type: "Wavefolding",
    hash: "8003fae8480c62fee26f1a859d3d0124d23ed0af537a4dab06671212c450db40",
  },
  {
    type: "Rectification",
    hash: "bb0fa8588e35e13703d63bb4edb2ae28663b7bb4ac143d3de437c675714abd86",
  },
  {
    type: "Bitcrusher",
    hash: "f73c69f99f0ae922d95a89086e76fc4868524f2ed8c89165e8fb038adfe8f18a",
  },
  {
    type: "Sample Rate Reduction",
    hash: "f325b1f36946627dddb7adac437299480b10cdca2f3a832f4888e16c82360dc9",
  },
  {
    type: "Aliasing",
    hash: "a7244400b62259cb2f24a286d7429cda053831059bbef583b77cda643921e311",
  },
  {
    type: "Stereo Width",
    hash: "09b2f92737fdf947ed6cc710b02c570036e8232657bea0d39ec925619c317c6c",
  },
  {
    type: "Mid/Side Processing",
    hash: "7bff9781776def787697fd5c4c3fa5189045c2bc88a69166932284c6980e84e2",
  },
  {
    type: "Phaser",
    hash: "7a98bb726aaec7e7e34a452d50755432daa5f4a28378ebe9d2c346939a4c5ef9",
  },
  {
    type: "Flanger",
    hash: "12fc53426c2b304327eaac8db01832cbcc4ccb54f259cd95af3d77601d115ef1",
  },
  {
    type: "Vibrato",
    hash: "938b3a45e992688b7684f8a359c4a9b78b7d10156b23636e5b1777f6a8ac6bab",
  },
  {
    type: "Rotary Speaker",
    hash: "37fe00e5f477d7a022356d5c6dd85482e2e119f1e38d44e8cec4494d38183fd8",
  },
  {
    type: "Detune",
    hash: "5355f5443ff37839265422224cdfb9919396c4047387037410b8add2904dc11f",
  },
  {
    type: "Frequency Shifter",
    hash: "4b54780b32aa6bf3bfd1d1702534981b9ff50344aeebde0efc1f7bea6388142b",
  },
  {
    type: "Pitch Shift",
    hash: "97b0ef7123a6a311a1187e4424573390db22885cc6344c96a27c8fbfcf204082",
  },
  {
    type: "Unison",
    hash: "eec534efbcb537f144f4acb58a70dc3717ce0fabab0ee1db5a5aab5af511c6bf",
  },
  {
    type: "Vocal Doubling",
    hash: "b47df268c973aa722acd4c2bca3ff5ff41b985114452fcb147248d637cc3725f",
  },
  {
    type: "Echo",
    hash: "a97829c2f66ea4c88c2b280e84bd700e8c4fd832b34bbc73f67bdeba6160e8ee",
  },
  {
    type: "Ping Pong Delay",
    hash: "60b341ef095061c3a12f785c3b6bab36777109652961777c1730f31b45619f9f",
  },
  {
    type: "Multitap Delay",
    hash: "426ef8f1ed8d22c56b53ff8c4f47dc58d525cec48be7b8e4fd5122dbeea8d81f",
  },
  {
    type: "Comb Filter",
    hash: "e2a38013230eef085ca26615b2f446b754a00f63797e09678cdaa21ac00ecb65",
  },
  {
    type: "Reverb",
    hash: "75fcf5c3fd4dd41f845064db859aa289de4de7ecc780c1cb4bf9324dc62920cd",
  },
  {
    type: "Spring Reverb",
    hash: "ea031a2f01c34f6e3f712589324b493d388065cf5d0b6332a2ba5d7d817a8b1f",
  },
  {
    type: "Gated Reverb",
    hash: "2642e0860a3975f138cf9c4a7c0cb95639457b4e79dc0c2318c7dd10b3a6f0bb",
  },
  {
    type: "EQ",
    hash: "75cbdefd82980ab1c823d3cf80043c5cc1d31bb4d675656bd8bc448368fa21f6",
  },
  {
    type: "Low Pass",
    hash: "83e7990dce080523491c61e22d34eb0b0d2ce67c287c3212e87b1101170a2c08",
  },
  {
    type: "High Pass",
    hash: "874d1b3f7812b4b082db52356e625ebe41958265cb039a160612501bc6b42054",
  },
  {
    type: "Band Pass",
    hash: "a420a291daaf1bc5c4e87e2d37d59c4d8fb79df62f03b901d911f3c3ac34565d",
  },
]) {
  for (const mode of ["public", "bound"]) {
    test(`${type} ${mode} preserves every sample across control and processor changes`, () => {
      const effect = createEffect(type);
      // Math.tanh can differ in its final double-precision bits across engines.
      // Check these shapers at the Float32 precision delivered to the worklet;
      // the independent curve fixtures below also check double precision.
      const output =
        type === "Overdrive" || type === "Soft Clipping"
          ? new Float32Array(1024 * 2)
          : new Float64Array(1024 * 2);
      let render = prepareEffectProcessor(effect, 1000);
      for (let frame = 0; frame < 1024; frame++) {
        if (frame === 128) {
          for (const [key, value] of Object.entries(effect.parameters)) {
            if (typeof value === "number") {
              effect.parameters[key] = value * 1.2;
            }
          }
          effect.parameters["mode"] = "Half";
          effect.parameters["bandCount"] = 3;
          effect.parameters["band1Type"] = "peaking";
          effect.parameters["band1Frequency"] = 200;
          effect.parameters["band1Gain"] = 8;
          effect.parameters["band2Type"] = "highpass";
          effect.parameters["band2Frequency"] = 90;
          effect.parameters["band2Gain"] = -4;
        }
        if (frame === 384) {
          effect.type = "Gain";
        }
        if (frame === 448) {
          effect.type = type;
        }
        if (frame === 768) {
          resetEffects([effect]);
        }
        const overrides =
          frame >= 256 && frame < 384
            ? {
                frequency: 300,
                drive: 3,
                stages: 10,
                gain: -9,
                depth: 75,
                rate: 2,
                feedback: 80,
                decay: 7,
                time: 0.1,
                damping: 150,
                voices: 4,
                spread: 45,
                cents: -20,
                phaseRadians: 1.234,
                shift: -73.5,
                width: 140,
                sampleRate: 450,
                bits: 3.2,
                bandCount: 1,
                resonance: 2,
                slope: 36,
              }
            : undefined;
        const sampleRate = frame < 512 ? 1000 : 2000;
        if (frame === 384 || frame === 448 || frame === 512 || frame === 768) {
          render = prepareEffectProcessor(effect, sampleRate);
        }
        const input: [number, number] =
          frame < 640 ? [Math.sin(frame * 0.17) * 0.7, Math.cos(frame * 0.11) * 0.4] : [0, 0];
        const pair =
          mode === "bound"
            ? render(input, frame / 1000, overrides)
            : processEffect(input, effect, sampleRate, frame / 1000, overrides);
        [output[frame * 2], output[frame * 2 + 1]] = pair;
      }
      expect(createHash("sha256").update(output).digest("hex")).toBe(hash);
    });
  }
}

// Calculated with 70-digit decimal arithmetic, independently of Math.tanh.
// Cover the linear region, knee and saturation at zero, default and maximum drive.
for (const type of ["Overdrive", "Soft Clipping"]) {
  for (const mode of ["public", "bound"]) {
    test(`${type} ${mode} matches the high-precision transfer curve`, () => {
      const effect = createEffect(type);
      const render = prepareEffectProcessor(effect, 44_100);
      const inputs = [0.001, 0.25, 1, 4];
      for (const { drive, expected } of [
        {
          drive: 0,
          expected: [
            0.0009999996666668, 0.24491866240370913, 0.7615941559557649, 0.999329299739067,
          ],
        },
        {
          drive: 6,
          expected: [
            0.0014125356701546552, 0.3264940913740111, 0.6822412113171794, 0.7079456188915154,
          ],
        },
        {
          drive: 40,
          expected: [0.009966799462495582, 0.1, 0.1, 0.1],
        },
      ]) {
        effect.parameters["drive"] = drive;
        for (const [index, input] of inputs.entries()) {
          const output =
            mode === "bound"
              ? render([input, -input], 0)
              : processEffect([input, -input], effect, 44_100, 0);
          const value = required(expected[index]);
          expect(output[0]).toBeCloseTo(value, 14);
          expect(output[1]).toBeCloseTo(-value, 14);
        }
      }
    });
  }
}

test("unknown effect types use the fallback, including inherited object names", () => {
  for (const type of ["unknown", "constructor", "__proto__", "toString"]) {
    const effect = createEffect("Echo");
    effect.type = type;
    expect(processEffect([0.25, -0.5], effect, 1000, 0)).toEqual([0.25, -0.5]);
    effect.enabled = false;
    expect(processEffect([0.4, -0.1], effect, 1000, 0.001)).toEqual([0.4, -0.1]);
  }
});

test("public effect outputs remain independent after processing subsequent samples", () => {
  for (const type of ["Gain", "EQ", "Phaser", "Flanger", "Vocal Doubling", "Reverb"]) {
    const effect = createEffect(type);
    const input: [number, number] = [0.3, -0.5];
    const first = processEffect(input, effect, 1000, 0);
    const reference: [number, number] = [...first];
    processEffect([0.7, 0.4], effect, 1000, 0.001);
    expect(first).toEqual(reference);
    expect(input).toEqual([0.3, -0.5]);
  }
});

test("bound processors support feeding their previous output back into the same effect", () => {
  for (const type of ["Gain", "EQ", "Phaser", "Flanger", "Vocal Doubling", "Reverb"]) {
    const effect = createEffect(type);
    const reference = structuredClone(effect);
    const render = prepareEffectProcessor(effect, 1000);
    let input: [number, number] = [0.3, -0.5];
    let expected: [number, number] = [...input];
    for (let frame = 0; frame < 10; frame++) {
      input = render(input, frame / 1000);
      expected = processEffect(expected, reference, 1000, frame / 1000);
      expect(input).toEqual(expected);
    }
  }
});

for (const mode of ["public", "bound"]) {
  test(`${mode} delay wraps correctly when a type edit retains a short filter buffer`, () => {
    const effect = createEffect("Low Pass");
    const reference = structuredClone(effect);
    processEffect([0.2, -0.3], effect, 1000, 0);
    processEffect([0.2, -0.3], reference, 1000, 0);
    effect.type = "Echo";
    effect.parameters = { time: 0.25, feedback: 30, damping: 5000 };
    reference.type = "Reference Delay";
    const render = prepareEffectProcessor(effect, 1000);
    for (let frame = 1; frame < 128; frame++) {
      const input: [number, number] = [Math.sin(frame * 0.17), Math.cos(frame * 0.11)];
      const actual =
        mode === "bound"
          ? render(input, frame / 1000)
          : processEffect(input, effect, 1000, frame / 1000);
      expect(actual).toEqual(processEffect(input, reference, 1000, frame / 1000));
    }
  });
  test(`${mode} delay controls invalidate when switching reverb mode with identical numeric values`, () => {
    const effect = createEffect("Echo");
    effect.parameters = { time: 0.037, feedback: 2, damping: 5000 };
    const reference = structuredClone(effect);
    let render = prepareEffectProcessor(effect, 1000);
    for (let frame = 0; frame < 1200; frame++) {
      if (frame === 384) {
        effect.type = "Reverb";
        effect.parameters = { decay: 2 };
        // The generic reverb fallback uses the same fixed taps, decay and
        // damping, without sharing the optimized delay's cached controls.
        reference.type = "Reference Reverb";
        render = prepareEffectProcessor(effect, 1000);
      } else if (frame === 768) {
        effect.type = "Echo";
        effect.parameters = { time: 0.037, feedback: 2, damping: 5000 };
        reference.type = "Echo";
        render = prepareEffectProcessor(effect, 1000);
      }
      const input: [number, number] = [Math.sin(frame * 0.17), Math.cos(frame * 0.11)];
      const actual =
        mode === "bound"
          ? render(input, frame / 1000)
          : processEffect(input, effect, 1000, frame / 1000);
      expect(actual).toEqual(processEffect(input, reference, 1000, frame / 1000));
    }
  });
}
