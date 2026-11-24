import { expect, test } from "bun:test";

import { PRESET_DEFINITIONS } from "@slopemp/song/presets";

import { envelopeValue, SongRenderer } from "../../src/audio";
import { presetInstrument, validateInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";
import { fmAmplitudeCurve } from "../../src/synth/fm";
import reference from "../fixtures/fm-preset-levels.json";

// Track RMS at middle C includes each factory preset's effects, articulation,
// and song-synchronized envelopes at the reference tempo.
for (const [name, expectedRms] of Object.entries(reference.rms)) {
  test(`${name}: retuned FM factory level stays within 0.25 dB of its reference`, () => {
    const instrument = presetInstrument(name);
    expect(validateInstrument(instrument)).toBe(true);
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    song.tempo = reference.tempo;
    const channel = required(song.channels[0]);
    channel.instruments = [instrument];
    channel.cells.fill(1);
    required(channel.patterns[1]).notes = [createNote(0, 4, reference.midiKey - 12)];
    const renderer = new SongRenderer(song, reference.sampleRate, 0, undefined, { master: false });
    const left = new Float32Array(reference.frames);
    const right = new Float32Array(left.length);
    renderer.process(left, right);
    expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true);
    const rms = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0) / left.length);
    expect(Math.abs(20 * Math.log10(rms / expectedRms))).toBeLessThan(0.25);
  });
}

test("level references cover every built-in FM preset", () => {
  const names = Object.entries(PRESET_DEFINITIONS)
    .filter(([, definition]) => definition.type === "FM (n-op)")
    .map(([name]) => name)
    .sort();
  expect(Object.keys(reference.rms).sort()).toEqual(names);
});

test("factory carrier detuning and frequency-choice polarity are explicit editable settings", () => {
  const organ = presetInstrument("FM organ");
  expect(organ.operators.map((operator) => operator.fine)).toEqual([0, 4, 0, 4]);
  let inverted = 0;
  for (const definition of Object.values(PRESET_DEFINITIONS)) {
    if (definition.type !== "FM (n-op)") {
      continue;
    }
    for (const operator of definition.operators ?? []) {
      expect(operator.invert).toBe([1.5, -1.3, -2.4, -5].includes(operator.offset));
      inverted += Number(operator.invert);
    }
  }
  expect(inverted).toBe(41);
});

test("retuned modulation envelope follows its original depth more closely than unchanged sliders", () => {
  const preset = presetInstrument("FM twang");
  const modulator = required(preset.operators[1]);
  const envelope = required(preset.envelopes[0]);
  let adjustedError = 0;
  let unchangedError = 0;
  for (let i = 1; i <= 100; i++) {
    const seconds = i / 100;
    const originalDepth = 1 / (1 + seconds * 8);
    const adjustedDepth = fmAmplitudeCurve(modulator.amplitude * envelopeValue(envelope, seconds));
    const unchangedDepth = fmAmplitudeCurve(modulator.amplitude * originalDepth);
    adjustedError += (adjustedDepth - originalDepth) ** 2;
    unchangedError += (unchangedDepth - originalDepth) ** 2;
  }
  expect(adjustedError).toBeLessThan(unchangedError * 0.1);
});

test("retuned FM factory envelopes and gain remain editable after saving and loading", () => {
  for (const name of ["FM twang", "harp", "rock organ"]) {
    const song = createSong();
    const instrument = presetInstrument(name);
    required(song.channels[0]).instruments = [instrument];
    expect(required(required(decodeSong(encodeSong(song)).channels[0]).instruments[0])).toEqual(
      instrument,
    );
  }
});
