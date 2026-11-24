import { expect, test } from "bun:test";

import { effectFilterPoints } from "../../src/filters";
import { EFFECT_PARAMETERS } from "../../src/instruments";
import { randomEffects } from "../../src/random-effects";

test("random effects cover supported types with valid discrete and continuous settings", () => {
  let state = 951;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  const seen = new Map<string, Set<string>>();
  const ids = new Set<string>();
  const lengths = new Set<number>();
  const filterTypes = new Set<string>();
  for (let index = 0; index < 600; index++) {
    const chain = randomEffects(random);
    lengths.add(chain.length);
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain.length).toBeLessThanOrEqual(3);
    expect(new Set(chain.map((effect) => effect.type)).size).toBe(chain.length);
    for (const effect of chain) {
      expect(effect.enabled).toBe(true);
      expect(ids.has(effect.id)).toBe(false);
      ids.add(effect.id);
      const settings = seen.get(effect.type) ?? new Set<string>();
      settings.add(JSON.stringify(effect.parameters));
      seen.set(effect.type, settings);
      for (const definition of EFFECT_PARAMETERS[effect.type] ?? []) {
        const value = effect.parameters[definition.key];
        if (definition.options !== undefined) {
          expect(definition.options).toContain(String(value));
        } else {
          expect(typeof value).toBe("number");
          if (typeof value !== "number") {
            throw new TypeError(`Missing numeric ${effect.type} ${definition.key}`);
          }
          expect(value).toBeGreaterThanOrEqual(definition.min);
          expect(value).toBeLessThanOrEqual(definition.max);
          const steps = (value - definition.min) / definition.step;
          expect(steps).toBeCloseTo(Math.round(steps), 5);
        }
      }
      if (effect.type === "EQ") {
        const points = effectFilterPoints(effect);
        expect(points.length).toBeGreaterThanOrEqual(1);
        expect(points.length).toBeLessThanOrEqual(3);
        for (const point of points) {
          filterTypes.add(point.type);
          expect(["peaking", "lowpass", "highpass"]).toContain(point.type);
          expect(point.frequency).toBeGreaterThanOrEqual(20);
          expect(point.frequency).toBeLessThanOrEqual(20_000);
          expect(Math.abs(point.gain)).toBeLessThanOrEqual(9);
        }
      }
    }
  }
  expect(lengths.size).toBe(3);
  expect([...filterTypes].sort()).toEqual(["highpass", "lowpass", "peaking"]);
  expect([...seen.keys()].sort()).toEqual(Object.keys(EFFECT_PARAMETERS).sort());
  for (const [type, settings] of seen) {
    if (type === "EQ" || (EFFECT_PARAMETERS[type]?.length ?? 0) > 0) {
      expect(settings.size, type).toBeGreaterThan(1);
    }
  }
});
