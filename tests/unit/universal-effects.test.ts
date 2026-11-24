import { expect, test } from "bun:test";

import { envelopeValue, processEffect, SongRenderer } from "../../src/audio";
import { setEffectFilterPoints } from "../../src/filters";
import { createEffect, createEnvelope, createInstrument } from "../../src/instruments";
import type { Effect, Instrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import type { Song } from "../../src/model";
import { createNativeSynth } from "../../src/synth/adapter";
import { resetSynthNoiseTables } from "../../src/synth/runtime";

const sampleRate = 8000;
const fixture = (type = "chip wave"): Song => {
  const song = createSong();
  song.volume = 100;
  song.tempo = 120;
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  channel.cells.fill(1);
  channel.instruments = [createInstrument(type)];
  required(channel.instruments[0]).volume = 0.3;
  required(channel.patterns[1]).notes = [createNote(0, 4, [48, 55])];
  return song;
};
const instrumentOf = (song: Song): Instrument =>
  required(required(song.channels[0]).instruments[0]);
const sharedEffects = [
  "EQ",
  "Low Pass",
  "High Pass",
  "Reverb",
  "Chorus",
  "Unison",
  "Bitcrusher",
  "Sample Rate Reduction",
  "Pitch Shift",
  "Detune",
  "Echo",
  "Overdrive",
  "Pan",
  "Vibrato",
];

const renderSong = (song: Song, frames = 4096): Float32Array => {
  const { random } = Math;
  let seed = 12_345;
  Math.random = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  resetSynthNoiseTables();
  const renderer = new SongRenderer(song, sampleRate);
  const output = new Float32Array(frames * 2);
  try {
    for (let frame = 0; frame < frames; frame++) {
      [output[frame * 2], output[frame * 2 + 1]] = renderer.sample();
    }
    return output;
  } finally {
    renderer.reset();
    Math.random = random;
    resetSynthNoiseTables();
  }
};

for (const type of [
  "chip wave",
  "basic noise",
  "spectrum",
  "drumset",
  "harmonics",
  "pulse width",
  "picked string",
  "supersaw",
  "FM (n-op)",
  "Custom chip wave",
]) {
  test(`${type} uses the same effects at instrument and track scope`, () => {
    for (const effectType of sharedEffects) {
      const song = fixture(type);
      const effect = createEffect(effectType);
      if (effectType === "EQ") {
        setEffectFilterPoints(effect, [
          { id: "test-cutoff", type: "lowpass", frequency: 1600, gain: 0 },
        ]);
      }
      if (effectType === "Detune") {
        effect.parameters["cents"] = 50;
      }
      if (effectType === "Pitch Shift") {
        effect.parameters["interval"] = 7;
      }
      instrumentOf(song).effects = [effect];
      const trackSong = structuredClone(song);
      instrumentOf(trackSong).effects = [];
      required(trackSong.channels[0]).effects = [structuredClone(effect)];
      const instrument = renderSong(song);
      const track = renderSong(trackSong);
      let difference = 0;
      let energy = 0;
      for (let index = 0; index < instrument.length; index++) {
        const actual = required(instrument[index]);
        difference = Math.max(difference, Math.abs(actual - required(track[index])));
        energy += actual ** 2;
      }
      expect(difference, `${type}: ${effectType}`).toBeLessThan(1e-6);
      expect(energy, `${type}: ${effectType}`).toBeGreaterThan(0);
    }
  });
}

test("native synthesis produces dry audio regardless of the effect rack", () => {
  const song = fixture();
  const channel = required(song.channels[0]);
  const dryInstrument = instrumentOf(song);
  const wetInstrument = structuredClone(dryInstrument);
  wetInstrument.effects = sharedEffects.map((type) => createEffect(type));
  const dry = createNativeSynth(song, channel, dryInstrument, sampleRate, envelopeValue).runtime;
  const wet = createNativeSynth(song, channel, wetInstrument, sampleRate, envelopeValue).runtime;
  let energy = 0;
  for (let frame = 0; frame < 4096; frame++) {
    const reference = dry.sample(true, [], song.tempo, 0);
    expect(wet.sample(true, [], song.tempo, 0)).toEqual(reference);
    energy += reference[0] ** 2 + reference[1] ** 2;
  }
  expect(energy).toBeGreaterThan(0);
});

const renderRack = (effects: Effect[]): Float32Array => {
  const song = fixture();
  instrumentOf(song).effects = effects;
  const renderer = new SongRenderer(song, sampleRate);
  const output = new Float32Array(4096);
  renderer.process(output, new Float32Array(output.length));
  renderer.reset();
  expect(output.some((sample) => Math.abs(sample) > 1e-6)).toBe(true);
  return output;
};

test("effect order and repeated instances are preserved on native instruments", () => {
  const gain = createEffect("Gain");
  gain.parameters["gain"] = 12;
  const clip = createEffect("Hard Clipping");
  Object.assign(clip.parameters, { drive: 12, threshold: -24 });
  const firstEcho = createEffect("Echo");
  firstEcho.parameters["time"] = 0.025;
  const secondEcho = createEffect("Echo");
  secondEcho.parameters["time"] = 0.04;
  const rack = [gain, clip, firstEcho, secondEcho];
  const song = fixture();
  instrumentOf(song).effects = structuredClone(rack);
  const actual = new SongRenderer(song, sampleRate);
  const dry = new SongRenderer(fixture(), sampleRate);
  let difference = 0;
  for (let frame = 0; frame < 4096; frame++) {
    let expected = dry.sample();
    for (const effect of rack) {
      expected = processEffect(expected, effect, sampleRate, frame / sampleRate);
    }
    const output = actual.sample();
    difference = Math.max(
      difference,
      Math.abs(output[0] - expected[0]),
      Math.abs(output[1] - expected[1]),
    );
  }
  expect(difference).toBeLessThan(1e-6);
  expect(renderRack(rack)).not.toEqual(renderRack([clip, gain, firstEcho, secondEcho]));
  expect(renderRack([firstEcho, secondEcho])).not.toEqual(renderRack([firstEcho]));
  const bypassed = structuredClone(rack);
  for (const effect of bypassed) {
    effect.enabled = false;
  }
  expect(renderRack(bypassed)).toEqual(renderRack([]));
});

test("native effect envelopes restart at each note and change only their targeted instance", () => {
  const song = fixture();
  const channel = required(song.channels[0]);
  required(channel.patterns[1]).notes = [createNote(0, 0.75, 48), createNote(1, 1.75, 48)];
  const first = createEffect("Gain");
  first.parameters["gain"] = -12;
  const second = createEffect("Gain");
  second.parameters["gain"] = -6;
  const envelope = {
    ...createEnvelope(),
    target: `effect:${first.id}:gain`,
    type: "Decay",
    timeBasis: "seconds",
    speed: 1,
  };
  instrumentOf(song).effects = [first, second];
  instrumentOf(song).envelopes = [envelope];
  const drySong = structuredClone(song);
  instrumentOf(drySong).effects = [];
  instrumentOf(drySong).envelopes = [];
  const actual = new SongRenderer(song, sampleRate);
  const dry = new SongRenderer(drySong, sampleRate);
  let difference = 0;
  let energy = 0;
  for (let frame = 0; frame < 6800; frame++) {
    const reference = dry.sample();
    const output = actual.sample();
    energy += output[0] ** 2 + output[1] ** 2;
    // Only inspect held notes, excluding their independent synthesis release.
    if (frame < 2800 || (frame >= 4100 && frame < 6800)) {
      const age = frame < 4000 ? frame / sampleRate : (frame - 4000) / sampleRate;
      const gain = 10 ** ((-12 * Math.exp(-4 * age) - 6) / 20);
      difference = Math.max(
        difference,
        Math.abs(output[0] - reference[0] * gain),
        Math.abs(output[1] - reference[1] * gain),
      );
    }
  }
  expect(difference).toBeLessThan(1e-6);
  expect(energy).toBeGreaterThan(0);
});

for (const type of ["chip wave", "FM (n-op)", "Custom chip wave"]) {
  test(`${type} shared effect envelopes retrigger when the same live pitch is pressed again`, () => {
    const song = fixture(type);
    const instrument = instrumentOf(song);
    const gain = createEffect("Gain");
    gain.parameters["gain"] = -12;
    instrument.effects = [gain];
    instrument.envelopes = [
      {
        ...createEnvelope(),
        target: `effect:${gain.id}:gain`,
        type: "Decay",
        timeBasis: "seconds",
        speed: 1,
        a: 1,
        b: 0,
      },
    ];
    const drySong = structuredClone(song);
    instrumentOf(drySong).effects = [];
    instrumentOf(drySong).envelopes = [];
    const actual = new SongRenderer(song, sampleRate);
    const dry = new SongRenderer(drySong, sampleRate);
    actual.playing = false;
    dry.playing = false;
    const channel = required(song.channels[0]);
    const dryChannel = required(drySong.channels[0]);
    let difference = 0;
    let energy = 0;
    for (let press = 0; press < 2; press++) {
      actual.audition(channel, 48);
      dry.audition(dryChannel, 48);
      for (let frame = 0; frame < 800; frame++) {
        const reference = dry.sample();
        const output = actual.sample();
        const multiplier = 10 ** ((-12 * Math.exp((-4 * frame) / sampleRate)) / 20);
        difference = Math.max(
          difference,
          Math.abs(output[0] - reference[0] * multiplier),
          Math.abs(output[1] - reference[1] * multiplier),
        );
        energy += output[0] ** 2 + output[1] ** 2;
      }
      actual.release(48);
      dry.release(48);
      for (let frame = 0; frame < 800; frame++) {
        actual.sample();
        dry.sample();
      }
    }
    expect(difference).toBeLessThan(1e-6);
    expect(energy).toBeGreaterThan(0);
  });
}
