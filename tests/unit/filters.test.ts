import { expect, test } from "bun:test";

import { PRESET_DEFINITIONS } from "@slopemp/song/presets";

import { processEffect } from "../../src/audio";
import { effectFilterPoints, remapFilterParameter, setEffectFilterPoints } from "../../src/filters";
import { createEffect, presetInstrument } from "../../src/instruments";
import { clone, createSong, required, validateSong } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";

const points = [
  { id: "cut", type: "highpass", frequency: 200, gain: 0 },
  { id: "peak", type: "peaking", frequency: 1200, gain: 9 },
  { id: "rolloff", type: "lowpass", frequency: 6000, gain: 0 },
];

test("all factory presets use effect filters and round-trip without losing configuration", () => {
  for (const name of Object.keys(PRESET_DEFINITIONS)) {
    const instrument = presetInstrument(name);
    expect(instrument, name).not.toHaveProperty("eq");
    expect(
      instrument.effects.some((effect) => effect.type === "Note Filter"),
      name,
    ).toBe(false);
    const song = createSong();
    required(song.channels[0]).instruments = [instrument];
    validateSong(song);
    const restored = required(required(decodeSong(encodeSong(song)).channels[0]).instruments[0]);
    expect(restored, name).toEqual(instrument);
    const copy = presetInstrument(name);
    const ids = new Set(copy.effects.map((effect) => effect.id));
    const pointIds = new Set(
      copy.effects
        .filter((effect) => effect.type === "EQ")
        .flatMap(effectFilterPoints)
        .map((point) => point.id),
    );
    for (const effect of instrument.effects) {
      expect(effect.id, name).toMatch(/^effect-[a-z0-9]+-\d+$/u);
      expect(ids.has(effect.id), name).toBe(false);
      if (effect.type === "EQ") {
        for (const point of effectFilterPoints(effect)) {
          expect(point.id, name).toMatch(
            /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u,
          );
          expect(pointIds.has(point.id), name).toBe(false);
        }
      }
    }
  }
});

test("graph EQ cascades cutoffs and peaks, with independent instances and neutral empty graphs", () => {
  const graph = createEffect("EQ");
  expect(processEffect([0.3, -0.2], graph, 44_100, 0)).toEqual([0.3, -0.2]);
  setEffectFilterPoints(graph, points);
  const independent = createEffect("EQ");
  setEffectFilterPoints(independent, [required(points[1])]);
  expect(effectFilterPoints(graph)).toEqual(points);
  expect(effectFilterPoints(independent)).toEqual([required(points[1])]);
  const stages = points.map((point) => {
    const effect = createEffect("EQ");
    setEffectFilterPoints(effect, [point]);
    return effect;
  });
  for (let frame = 0; frame < 2048; frame++) {
    const sample = Math.sin(frame * 0.17);
    const expected = stages.reduce<[number, number]>(
      (input, effect) => processEffect(input, effect, 44_100, frame / 44_100),
      [sample, -sample],
    );
    expect(processEffect([sample, -sample], graph, 44_100, frame / 44_100)).toEqual(expected);
  }
});

test("deleting a point preserves other parameter bindings and disables the deleted target", () => {
  const before = createEffect("EQ");
  setEffectFilterPoints(before, points);
  const after = clone(before);
  setEffectFilterPoints(after, points.slice(1));
  expect(remapFilterParameter(before, after, "frequency")).toBeUndefined();
  expect(remapFilterParameter(before, after, "band1Frequency")).toBe("frequency");
  expect(remapFilterParameter(before, after, "band2Gain")).toBe("band1Gain");
  expect(remapFilterParameter(before, after, "enabled")).toBe("enabled");
});

test("filter edits and automation preserve the ringing history across coefficient changes", () => {
  const effect = createEffect("EQ");
  effect.parameters = { bandCount: 1, filterType: "lowpass", frequency: 2400, gain: 0 };
  const expected = [
    0.023399289110091915, 0.08243757377541976, 0.13452851779376004, 0.15406034032085675,
    0.16921854748455264, 0.18045576357993567, 0.1882027228026302, 0.19286677037814612,
    -0.06458694106788115, -0.02347633407431183, 0.01520820671790967, 0.0016610537960756136,
    -0.010530837496445828, -0.021372817206043518, -0.030884311725780367, -0.03909718652693905,
    -0.04618288331610523, -0.05218179487490602, -0.05714051230687152, -0.06111081751290852,
  ];
  for (let frame = 0; frame < expected.length; frame++) {
    if (frame === 4) {
      effect.parameters["frequency"] = 750;
    }
    if (frame === 12) {
      effect.parameters["filterType"] = "peaking";
      effect.parameters["gain"] = 6;
    }
    const [left, right] = processEffect(
      frame === 0 ? [1, -0.5] : [0, 0],
      effect,
      frame < 16 ? 44_100 : 48_000,
      frame / 44_100,
      frame >= 8 && frame < 12 ? { frequency: 12_000 } : undefined,
    );
    expect(left).toBeCloseTo(required(expected[frame]), 14);
    expect(right).toBeCloseTo(-required(expected[frame]) / 2, 14);
  }
});
