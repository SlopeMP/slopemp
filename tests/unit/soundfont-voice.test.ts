import { expect, test } from "bun:test";

import { required } from "../../src/model";
import { SF2_DEFAULT_GENERATORS } from "../../src/synth/soundfont";
import type { SFPreset, SoundFont } from "../../src/synth/soundfont-file";
import { prepareSoundFontVoice } from "../../src/synth/soundfont-voice";

const makeFont = (): SoundFont => {
  const generators = new Map(SF2_DEFAULT_GENERATORS);
  generators.set(43, (72 << 8) | 48);
  generators.set(31, 120);
  generators.set(27, -1200);
  const preset: SFPreset = {
    name: "Prepared zone",
    bank: 0,
    program: 0,
    zones: [{ generators, sampleIndex: 0, modulators: [] }],
  };
  return {
    samples: new Float32Array(32),
    headers: [
      {
        start: 0,
        end: 32,
        loopStart: 0,
        loopEnd: 32,
        sampleRate: 8000,
        root: 60,
        correction: 0,
        link: 0,
        type: 1,
      },
    ],
    presets: [preset],
  };
};

test("repeated SoundFont notes reuse metadata and keep playback state independent", () => {
  const font = makeFont();
  const preset = required(font.presets[0]);
  const first = prepareSoundFontVoice(font, preset, 60);
  const a = required(first.zones[0]);
  a.position = 17;
  a.rateCents = 500;
  a.history.fill(0.75);
  first.finished = true;
  const second = prepareSoundFontVoice(font, preset, 60);
  const b = required(second.zones[0]);
  expect(b.modEnvelope).toBe(a.modEnvelope);
  expect(b.volEnvelope).toBe(a.volEnvelope);
  expect(b.position).toBe(0);
  expect(b.rateCents).toBeNaN();
  expect(b.history.every((value) => value === 0)).toBe(true);
  expect(b.history).not.toBe(a.history);
  expect(b.modEnvelopeState).not.toBe(a.modEnvelopeState);
  expect(b.volEnvelopeState).not.toBe(a.volEnvelopeState);
  expect(second.finished).toBe(false);
});

test("prepared SoundFont metadata keeps key ranges and key-scaled envelopes distinct", () => {
  const font = makeFont();
  const preset = required(font.presets[0]);
  const middle = required(prepareSoundFontVoice(font, preset, 60).zones[0]);
  const high = required(prepareSoundFontVoice(font, preset, 72).zones[0]);
  expect(middle.modEnvelope).not.toBe(high.modEnvelope);
  expect(middle.modEnvelope.hold).toBeGreaterThan(high.modEnvelope.hold);
  expect(prepareSoundFontVoice(font, preset, 47).zones).toHaveLength(0);
  expect(prepareSoundFontVoice(font, preset, 73).zones).toHaveLength(0);
  expect(prepareSoundFontVoice(font, preset, 60).zones[0]?.modEnvelope).toBe(middle.modEnvelope);
});

test("font and preset replacements get fresh prepared metadata", () => {
  const font = makeFont();
  const preset = required(font.presets[0]);
  const original = required(prepareSoundFontVoice(font, preset, 60).zones[0]);
  const replacement = {
    ...font,
    headers: [{ ...required(font.headers[0]), start: 4, correction: 25 }],
  };
  const replaced = required(prepareSoundFontVoice(replacement, preset, 60).zones[0]);
  expect(replaced.position).toBe(4);
  expect(replaced.tuning).toBe(25);
  expect(replaced.modEnvelope).not.toBe(original.modEnvelope);
  const newPreset = { ...preset, program: 1 };
  const switched = prepareSoundFontVoice(font, newPreset, 60);
  expect(switched.program).toBe(1);
  expect(switched.zones[0]?.modEnvelope).not.toBe(original.modEnvelope);
});
