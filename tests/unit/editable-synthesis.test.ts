import { expect, test } from "bun:test";

import { envelopeValue, SongRenderer } from "../../src/audio";
import { setEffectFilterPoints } from "../../src/filters";
import {
  createEffect,
  createEnvelope,
  createInstrument,
  presetInstrument,
} from "../../src/instruments";
import type { Instrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { usesUpstreamSynth } from "../../src/synth/adapter";

const render = (instrument: Instrument): Float32Array => {
  const { random } = Math;
  let seed = 12_345;
  try {
    Math.random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    const song = createSong();
    const channel = required(song.channels[0]);
    song.channels = [channel];
    channel.instruments = [instrument];
    channel.cells[0] = 1;
    required(channel.patterns[1]).notes = [createNote(0, 2, 48)];
    const renderer = new SongRenderer(song, 24_000);
    const samples = new Float32Array(8192);
    for (let index = 0; index < samples.length; index += 2) {
      [samples[index], samples[index + 1]] = renderer.sample();
    }
    expect(samples.some((sample) => sample !== 0)).toBe(true);
    return samples;
  } finally {
    Math.random = random;
  }
};

test("synthesis routing depends on instrument type and sample selection", () => {
  for (const type of [
    "chip wave",
    "basic noise",
    "spectrum",
    "drumset",
    "harmonics",
    "pulse width",
    "picked string",
    "supersaw",
  ]) {
    const instrument = createInstrument(type);
    expect(usesUpstreamSynth(instrument), type).toBe(true);
  }
  expect(usesUpstreamSynth(createInstrument("FM (n-op)"))).toBe(false);
  const sample = { ...createInstrument("chip wave"), resourceId: "selected-sample" };
  expect(usesUpstreamSynth(sample)).toBe(false);
});

test("preset identity cannot change audio with the same editable settings", () => {
  const preset = presetInstrument("square wave");
  const custom = Object.assign(structuredClone(preset), {
    name: "Custom square",
    preset: "",
  });
  expect(render(custom)).toEqual(render(preset));
});

test("hidden SF2 generator maps cannot override editable envelope stages", () => {
  const envelope = {
    ...createEnvelope(),
    type: "Staged / SF2",
    law: "SF2 modulation",
    a: 0,
    b: 1,
    delay: 0,
    attack: 0,
    hold: -32_768,
    decay: -32_768,
    sustain: 0,
    release: 0,
  };
  const imported = { ...envelope, sf2Generators: { 25: -32_768 } };
  expect(envelopeValue(imported, 0.5)).toBe(envelopeValue(envelope, 0.5));
});

test("sample selection left on another instrument type cannot change its sound", () => {
  for (const type of ["FM (n-op)", "Custom chip wave"]) {
    const instrument = createInstrument(type);
    const changedType = { ...instrument, resourceId: "unreachable-sample" };
    expect(render(changedType)).toEqual(render(instrument));
  }
});

test("unexposed instrument pan cannot change synthesis", () => {
  for (const type of ["chip wave", "FM (n-op)"]) {
    const instrument = createInstrument(type);
    const imported = Object.assign(structuredClone(instrument), { pan: -1 });
    expect(render(imported)).toEqual(render(instrument));
  }
});

test("drumset audio ignores instrument fades that its editor does not expose", () => {
  const instrument = createInstrument("drumset");
  const imported = { ...instrument, attack: 1, release: -1 };
  expect(render(imported)).toEqual(render(instrument));
});

test("native effects ignore unexposed mix, gain, and filter settings", () => {
  for (const type of ["Reverb", "Chorus", "Unison", "Vibrato", "EQ", "Low Pass"]) {
    const instrument = createInstrument("harmonics");
    const effect = createEffect(type);
    if (type === "EQ") {
      setEffectFilterPoints(effect, [{ id: "cutoff", type: "lowpass", frequency: 2400, gain: 0 }]);
    }
    if (type === "Vibrato") {
      Object.assign(effect.parameters, { cents: 50, rate: 6, delay: 0 });
    }
    instrument.effects = [effect];
    const imported = structuredClone(instrument);
    Object.assign(required(imported.effects[0]).parameters, {
      mix: 0,
      inputGain: 24,
      outputGain: -24,
      filterStage: "instrument",
      legacy: true,
      ...(type === "EQ" ? { resonance: 20 } : undefined),
      ...(type === "Low Pass" ? { gain: 24 } : undefined),
    });
    expect(render(imported), type).toEqual(render(instrument));
  }
});
