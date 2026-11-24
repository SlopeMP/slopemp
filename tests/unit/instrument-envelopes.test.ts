import { expect, test } from "bun:test";

import { envelopeValue } from "../../src/audio";
import { setEffectFilterPoints } from "../../src/filters";
import { envelopeTargets, envelopeTypes, randomEnvelope } from "../../src/instrument-envelopes";
import {
  createEffect,
  createEnvelope,
  createInstrument,
  INSTRUMENT_TYPES,
} from "../../src/instruments";

test("new envelopes and default drums use beats and the song clock", () => {
  expect(createEnvelope()).toMatchObject({ timeBasis: "beats", clock: "song synchronized" });
  for (const type of INSTRUMENT_TYPES) {
    for (const drum of createInstrument(type).drums) {
      expect(drum.envelope).toMatchObject({ timeBasis: "beats", clock: "song synchronized" });
    }
  }
});

test("shared envelope targets bind to the chosen synth, operator and effect identities", () => {
  const instrument = createInstrument("FM (n-op)");
  const [operator] = instrument.operators;
  if (!operator) {
    throw new Error("Missing FM operator");
  }
  operator.wave = "pulse width";
  const eq = createEffect("EQ");
  setEffectFilterPoints(eq, [{ id: "peak", type: "peaking", frequency: 1500, gain: 4 }]);
  const pan = createEffect("Pan");
  instrument.effects = [eq, pan, createEffect("Monoize")];
  const targets = envelopeTargets(instrument).map((target) => target.value);
  expect(targets).not.toContain("arpeggioSpeed");
  expect(targets).toContain(`operator:${operator.id}:pulseWidth`);
  expect(targets).toContain(`operator:${operator.id}:ratio`);
  expect(targets).toContain(`effect:${eq.id}:frequency`);
  expect(targets).toContain(`effect:${pan.id}:position`);
  expect(targets).not.toContain(`effect:${pan.id}:mode`);
  expect(targets).not.toContain("pulseWidth");
  expect(envelopeTargets(createInstrument("pulse width")).map((target) => target.value)).toContain(
    "pulseWidth",
  );
});

test("every generated envelope shape produces finite, audible modulation", () => {
  const shapes = envelopeTypes.filter((type) => type !== "None");
  for (const [index, shape] of shapes.entries()) {
    let first = true;
    const envelope = randomEnvelope("volume", () => {
      if (first) {
        first = false;
        return index / shapes.length;
      }
      return 0.5;
    });
    expect(envelope.type).toBe(shape);
    expect(envelope.target).toBe("volume");
    expect(envelope.enabled).toBe(true);
    const values = Array.from({ length: 101 }, (_, sample) =>
      envelopeValue(envelope, sample / 100, sample / 50, 0.75, 0.8),
    );
    expect(values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    expect(Math.max(...values)).toBeGreaterThan(0.1);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.01);
  }
});

test("generated drum envelopes reach silence after their percussive shape", () => {
  for (let index = 0; index < 5; index++) {
    let first = true;
    const envelope = randomEnvelope(
      "volume",
      () => {
        if (first) {
          first = false;
          return index / 5;
        }
        return 0.5;
      },
      true,
    );
    expect(envelopeValue(envelope, 20, 20)).toBeLessThan(0.01);
    expect(envelope.sustain).toBe(0);
  }
});
