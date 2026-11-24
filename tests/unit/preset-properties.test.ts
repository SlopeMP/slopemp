import { expect, test } from "bun:test";

import { PRESET_DEFINITIONS } from "@slopemp/song/presets";

import { SongRenderer } from "../../src/audio";
import {
  createEffect,
  createEnvelope,
  createInstrument,
  EFFECT_PARAMETERS,
  presetInstrument,
} from "../../src/instruments";
import type { Instrument } from "../../src/instruments";
import { clone, createNote, createSong, required } from "../../src/model";
import { resetSynthNoiseTables } from "../../src/synth/runtime";

test("chorus exposes one percentage slider and factory strengths", () => {
  expect(EFFECT_PARAMETERS["Chorus"]).toEqual([
    { key: "amount", label: "Chorus", min: 0, max: 100, step: 1, value: 100, unit: "%" },
  ]);
  expect(createEffect("Chorus").parameters).toEqual({ amount: 100 });
  const quieterPresets = new Set(["steel pan", "fifth saw lead", "soundtrack"]);
  for (const [name, preset] of Object.entries(PRESET_DEFINITIONS)) {
    for (const effect of preset.effects ?? []) {
      if (effect.type === "Chorus") {
        expect(effect.parameters, name).toEqual({ amount: quieterPresets.has(name) ? 67 : 100 });
      }
    }
  }
});

const expectFields = (value: object, fields: Set<string>, context: string): void => {
  expect(
    Object.keys(value).filter((key) => !fields.has(key)),
    context,
  ).toEqual([]);
};

test("every factory preset envelope uses beats and the song clock", () => {
  for (const name of Object.keys(PRESET_DEFINITIONS)) {
    const instrument = presetInstrument(name);
    for (const envelope of [
      ...instrument.envelopes,
      ...instrument.drums.map((drum) => drum.envelope),
    ]) {
      expect(envelope.timeBasis, `${name}: ${envelope.target}`).toBe("beats");
      expect(envelope.clock, `${name}: ${envelope.target}`).toBe("song synchronized");
    }
  }
});

test("factory presets define only editable instrument, effect and envelope properties", () => {
  const instrumentFields = new Set(Object.keys(createInstrument()));
  // Curve is exposed for temporal envelopes and defaults to one when absent.
  const envelopeFields = new Set([...Object.keys(createEnvelope()), "curve"]);
  for (const [name, preset] of Object.entries(PRESET_DEFINITIONS)) {
    const presetFields = new Set(instrumentFields);
    if (preset.type === "drumset") {
      presetFields.delete("attack");
      presetFields.delete("release");
    }
    expectFields(preset, presetFields, name);
    for (const envelope of [
      ...(preset.envelopes ?? []),
      ...(preset.drums ?? []).map((drum) => drum.envelope),
    ]) {
      expectFields(envelope, envelopeFields, `${name}: envelope`);
    }
    for (const effect of preset.effects ?? []) {
      const fields = new Set((EFFECT_PARAMETERS[effect.type] ?? []).map((item) => item.key));
      if (effect.type === "EQ") {
        for (const key of Object.keys(effect.parameters)) {
          if (
            /^(?:bandCount|filterType|frequency|gain|band\d+(?:Id|Type|Frequency|Gain))$/u.test(key)
          ) {
            fields.add(key);
          }
        }
      }
      expectFields(effect.parameters, fields, `${name}: ${effect.type}`);
    }
  }
});

const render = (instrument: Instrument): [Float32Array, Float32Array] => {
  const song = createSong();
  const channel = required(song.channels[0]);
  song.channels = [channel];
  channel.instruments = [instrument];
  channel.cells[0] = 1;
  required(channel.patterns[1]).notes = [createNote(0, 1, [48, 55])];
  const { random } = Math;
  try {
    resetSynthNoiseTables();
    let seed = 12_345;
    Math.random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    const renderer = new SongRenderer(song, 24_000);
    const left = new Float32Array(4096);
    const right = new Float32Array(left.length);
    renderer.process(left, right);
    return [left, right];
  } finally {
    Math.random = random;
    resetSynthNoiseTables();
  }
};

for (const name of [
  "square lead",
  "chip noise",
  "FM twang",
  "supersaw lead",
  "grand piano",
  "electric piano 1",
  "PWM overdrive",
  "dark choir",
  "standard drumset",
]) {
  test(`${name}: unexposed preset properties cannot change synthesis`, () => {
    const instrument = presetInstrument(name);
    const withHiddenProperties = { ...clone(instrument), pan: 1 };
    if (instrument.type === "drumset") {
      withHiddenProperties.attack = 2;
      withHiddenProperties.release = 3;
    }
    const envelopes = [
      ...withHiddenProperties.envelopes,
      ...withHiddenProperties.drums.map((drum) => drum.envelope),
    ];
    for (const envelope of envelopes) {
      Object.assign(envelope, {
        amount: 0,
        sf2Generators: { 34: 8000 },
      });
    }
    for (const effect of withHiddenProperties.effects) {
      Object.assign(effect.parameters, {
        mix: 0,
        inputGain: -24,
        outputGain: 24,
        filterStage: "instrument",
        legacy: true,
      });
    }
    const actual = render(instrument);
    expect(
      actual[0].some((sample) => sample !== 0),
      name,
    ).toBe(true);
    expect(render(withHiddenProperties)).toEqual(actual);
  });
}
