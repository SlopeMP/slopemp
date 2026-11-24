import { expect, test } from "bun:test";

import { PRESET_DEFINITIONS } from "@slopemp/song/presets";

import {
  createEnvelope,
  createFMOperator,
  createInstrument,
  FM_WAVES,
  presetInstrument,
  validateInstrument,
} from "../../src/instruments";
import { createSong, required } from "../../src/model";
import { decodeSong, encodeSong, parseSongBytes, serializeSongBytes } from "../../src/storage";

test("FM operators have independent drawings, fresh identities and neutral oscillator controls", () => {
  const first = createFMOperator();
  const second = createFMOperator();
  expect(first.id).not.toBe(second.id);
  expect(first).toMatchObject({
    coarse: 0,
    fine: 0,
    pan: 0,
    phase: 0,
    stereoPhase: 0,
    stereoDetune: 0,
    invert: false,
    ratio: 1,
    offset: 0,
    amplitude: 1,
    carrier: true,
  });
  first.customWave[0] = 24;
  expect(second.customWave[0]).toBe(0);
  for (const wave of FM_WAVES) {
    const instrument = createInstrument("FM (n-op)");
    required(instrument.operators[0]).wave = wave;
    expect(validateInstrument(instrument), wave).toBe(true);
  }
});

test("every factory FM preset defines editable oscillator controls without repairs", () => {
  for (const [name, definition] of Object.entries(PRESET_DEFINITIONS)) {
    if (definition.type !== "FM (n-op)") {
      continue;
    }
    expect(validateInstrument(presetInstrument(name)), name).toBe(true);
    for (const operator of definition.operators ?? []) {
      expect(operator, name).toMatchObject({
        coarse: 0,
        pan: 0,
        phase: 0,
        stereoPhase: 0,
        stereoDetune: 0,
      });
    }
  }
});

test("FM controls and envelope identities survive binary and URL song round trips", () => {
  const song = createSong();
  const instrument = createInstrument("FM (n-op)");
  const operator = required(instrument.operators[0]);
  Object.assign(operator, {
    coarse: -24,
    fine: 38,
    pan: -0.73,
    phase: 138,
    stereoPhase: -80,
    stereoDetune: 33,
    invert: true,
    ratio: 1.37,
    offset: -0.4,
    pulseWidth: 0.234,
    wave: "pulse width",
  });
  instrument.phaseRandomness = 0.36;
  instrument.envelopes = ["amplitude", "coarse", "fine", "pan", "stereoDetune", "pulseWidth"].map(
    (key) => ({ ...createEnvelope(), target: `operator:${operator.id}:${key}` }),
  );
  required(song.channels[0]).instruments = [instrument];
  expect(parseSongBytes(serializeSongBytes(song))).toEqual(song);
  expect(decodeSong(encodeSong(song))).toEqual(song);
});

test("FM validation rejects missing, nonfinite, mistyped and out-of-range controls", () => {
  const instrument = createInstrument("FM (n-op)");
  const first = required(instrument.operators[0]);
  for (const [key, value] of [
    ["coarse", 49],
    ["fine", -101],
    ["pan", 1.01],
    ["phase", -1],
    ["stereoPhase", 181],
    ["stereoDetune", -101],
    ["invert", "true"],
    ["amplitude", 1.01],
    ["ratio", -1],
    ["offset", Infinity],
    ["pulseWidth", 0],
    ["wave", "missing"],
    ["customWave", [0]],
    ["carrier", 1],
    ["id", ""],
  ]) {
    expect(
      validateInstrument({
        ...instrument,
        operators: [{ ...first, [String(key)]: value }, ...instrument.operators.slice(1)],
      }),
      String(key),
    ).toBe(false);
  }
  for (const key of Object.keys(first)) {
    const missing = Object.fromEntries(Object.entries(first).filter(([field]) => field !== key));
    expect(
      validateInstrument({ ...instrument, operators: [missing, ...instrument.operators.slice(1)] }),
      `missing ${key}`,
    ).toBe(false);
  }
  expect(validateInstrument({ ...instrument, phaseRandomness: Number.NaN })).toBe(false);
  expect(validateInstrument({ ...instrument, phaseRandomness: 1.01 })).toBe(false);
  expect(validateInstrument({ ...instrument, feedbackVolume: -0.1 })).toBe(false);
});

test("FM validation checks feedback endpoints, duplicate routes and operator identities", () => {
  const instrument = createInstrument("FM (n-op)");
  const first = required(instrument.operators[0]);
  const feedback = { from: first.id, to: first.id };
  expect(validateInstrument({ ...instrument, feedback: [feedback] })).toBe(true);
  expect(validateInstrument({ ...instrument, feedback: [{ ...feedback, to: "missing" }] })).toBe(
    false,
  );
  expect(validateInstrument({ ...instrument, feedback: [feedback, feedback] })).toBe(false);
  expect(
    validateInstrument({ ...instrument, connections: [...instrument.connections, null] }),
  ).toBe(false);
  expect(
    validateInstrument({
      ...instrument,
      connections: [...instrument.connections, required(instrument.connections[0])],
    }),
  ).toBe(false);
  expect(
    validateInstrument({
      ...instrument,
      operators: [first, { ...required(instrument.operators[1]), id: first.id }],
    }),
  ).toBe(false);
});
