import { expect, test } from "bun:test";

import { registerAudioResource, removeAudioResource, SongRenderer } from "../../src/audio";
import { envelopeTargets } from "../../src/instrument-envelopes";
import {
  CHIP_WAVES,
  createInstrument,
  INSTRUMENT_TYPES,
  validateInstrument,
} from "../../src/instruments";
import type { Instrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import type { Resource } from "../../src/model";
import { randomInstrument, randomPreset } from "../../src/random-instruments";
import type { AssetView } from "../../src/resource-identity";
import { parseSongBytes, serializeSongBytes } from "../../src/storage";
import { createNativeSynth, usesUpstreamSynth } from "../../src/synth/adapter";
import { resetSynthNoiseTables } from "../../src/synth/runtime";

const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

const generateType = (type: string, seed: number, assets: AssetView[] = []): Instrument => {
  const types = INSTRUMENT_TYPES.filter((entry) => entry !== "SoundFont" || type === "SoundFont");
  let first = true;
  const random = seeded(seed);
  return randomInstrument(
    undefined,
    () => {
      if (first) {
        first = false;
        return (types.indexOf(type) + 0.5) / types.length;
      }
      return random();
    },
    assets,
  );
};

test("generated instruments vary their synthesis while retaining mix and stable routing identity", () => {
  const random = seeded(151);
  const previous = createInstrument("chip wave");
  previous.volume = 0.37;
  previous.presetEffects = false;
  const original = structuredClone(previous);
  const snapshots = new Set<string>();
  const types = new Set<string>();
  for (let index = 0; index < 64; index++) {
    const instrument = randomInstrument(previous, random);
    expect(validateInstrument(instrument)).toBe(true);
    expect(instrument.id).toBe(previous.id);
    expect(instrument.volume).toBe(0.37);
    expect(instrument.presetEffects).toBe(false);
    expect(instrument.type).not.toBe("SoundFont");
    expect(instrument.resourceId).toBe("");
    snapshots.add(JSON.stringify(instrument));
    types.add(instrument.type);
  }
  expect(snapshots.size).toBe(64);
  expect(types.size).toBeGreaterThan(6);
  expect(previous).toEqual(original);
});

test("every synth varies its audible settings and binds enabled envelopes to generated controls", () => {
  for (const type of INSTRUMENT_TYPES.filter((entry) => entry !== "SoundFont")) {
    const settings = new Set<string>();
    for (let seed = 0; seed < 24; seed++) {
      const instrument = generateType(type, seed * 10_007);
      expect(instrument.type).toBe(type);
      expect(validateInstrument(instrument), type).toBe(true);
      expect(instrument.effects.length).toBeGreaterThan(0);
      expect(instrument.envelopes.length).toBeGreaterThan(0);
      const targets = new Set(envelopeTargets(instrument).map((target) => target.value));
      expect(new Set(instrument.envelopes.map((envelope) => envelope.target)).size).toBe(
        instrument.envelopes.length,
      );
      for (const envelope of instrument.envelopes) {
        expect(envelope).toMatchObject({ timeBasis: "beats", clock: "song synchronized" });
        expect(envelope.enabled).toBe(true);
        expect(envelope.type).not.toBe("None");
        expect(targets.has(envelope.target)).toBe(true);
      }
      const defaults = createInstrument(type);
      if (type === "drumset") {
        expect(new Set(instrument.drums.map((drum) => JSON.stringify(drum.spectrum))).size).toBe(
          12,
        );
        for (const [index, drum] of instrument.drums.entries()) {
          expect(drum.envelope).toMatchObject({ timeBasis: "beats", clock: "song synchronized" });
          expect(drum.spectrum).not.toEqual(required(defaults.drums[index]).spectrum);
          expect(drum.envelope.enabled).toBe(true);
          expect(drum.envelope).not.toEqual(required(defaults.drums[index]).envelope);
          expect(drum.spectrum.every((bin) => bin >= 0 && bin <= 1)).toBe(true);
        }
        settings.add(JSON.stringify(instrument.drums.map((drum) => drum.spectrum)));
      } else if (type === "spectrum") {
        expect(instrument.spectrum).not.toEqual(defaults.spectrum);
        expect(instrument.spectrum.every((bin) => bin >= 0 && bin <= 1)).toBe(true);
        settings.add(JSON.stringify(instrument.spectrum));
      } else if (type === "FM (n-op)") {
        settings.add(
          JSON.stringify(instrument.operators.map(({ id: _id, ...operator }) => operator)),
        );
        const carrierIds = new Set(
          instrument.operators
            .filter((operator) => operator.carrier)
            .map((operator) => operator.id),
        );
        const reachesCarrier = (id: string): boolean =>
          carrierIds.has(id) ||
          instrument.connections.some((edge) => edge.from === id && reachesCarrier(edge.to));
        expect(instrument.operators.every((operator) => reachesCarrier(operator.id))).toBe(true);
      } else {
        const keys: Record<string, string> = {
          "chip wave": "wave",
          "basic noise": "noise",
          "Custom chip wave": "customWave",
          "pulse width": "pulseWidth",
          supersaw: "shape",
        };
        const key = keys[type] ?? "harmonics";
        settings.add(JSON.stringify(instrument[key]));
      }
    }
    expect(settings.size, type).toBeGreaterThan(2);
  }
});

test("FM generation varies operators, oscillator controls, algorithms and feedback", () => {
  const counts = new Set<number>();
  const graphs = new Set<string>();
  const waves = new Set<string>();
  let feedbackCount = 0;
  for (let seed = 0; seed < 60; seed++) {
    const instrument = generateType("FM (n-op)", seed * 10_007);
    counts.add(instrument.operators.length);
    const indices = new Map(instrument.operators.map((operator, index) => [operator.id, index]));
    graphs.add(
      JSON.stringify(
        instrument.connections.map((edge) => [indices.get(edge.from), indices.get(edge.to)]),
      ),
    );
    for (const operator of instrument.operators) {
      waves.add(operator.wave);
    }
    if (instrument.feedback.length > 0) {
      feedbackCount++;
      expect(instrument.feedbackVolume).toBeGreaterThan(0);
    }
    expect(instrument.phaseRandomness).toBeGreaterThan(0);
  }
  expect(counts.size).toBe(5);
  expect(graphs.size).toBeGreaterThan(10);
  expect(waves.size).toBeGreaterThan(8);
  expect(feedbackCount).toBeGreaterThan(20);
});

test("generated source envelopes reach the native evaluator while effect envelopes stay shared", () => {
  let sourceBindings = 0;
  let effectBindings = 0;
  for (const type of INSTRUMENT_TYPES) {
    if (!usesUpstreamSynth(createInstrument(type))) {
      continue;
    }
    for (let seed = 0; seed < 12; seed++) {
      const instrument = generateType(type, seed * 10_007);
      const song = createSong();
      const channel = required(song.channels[0]);
      channel.instruments = [instrument];
      channel.cells[0] = 1;
      required(channel.patterns[1]).notes = [createNote(0, 2, 48)];
      const evaluated = new Set<string>();
      const { runtime } = createNativeSynth(song, channel, instrument, 24_000, (envelope) => {
        evaluated.add(envelope.id);
        return 1;
      });

      for (let frame = 0; frame < 512; frame++) {
        runtime.sample(true, [], song.tempo, 0);
      }
      for (const envelope of instrument.envelopes) {
        const effectTarget = envelope.target.startsWith("effect:");
        expect(evaluated.has(envelope.id), `${type} ${envelope.target}`).toBe(!effectTarget);
        if (effectTarget) {
          effectBindings++;
        } else {
          sourceBindings++;
        }
      }
    }
  }
  expect(sourceBindings).toBeGreaterThan(0);
  expect(effectBindings).toBeGreaterThan(0);
});

test("generated effect envelopes audibly modulate every native source through the shared chain", () => {
  const render = (instrument: Instrument): Float32Array => {
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    channel.instruments = [instrument];
    channel.cells[0] = 1;
    required(channel.patterns[1]).notes = [createNote(0, 2, 48)];
    const { random } = Math;
    Math.random = seeded(12_345);
    resetSynthNoiseTables();
    const renderer = new SongRenderer(song, 24_000);
    const left = new Float32Array(6000);
    const right = new Float32Array(left.length);
    try {
      renderer.process(left, right);
      expect(left.every(Number.isFinite)).toBe(true);
      expect(right.every(Number.isFinite)).toBe(true);
      const audio = new Float32Array(left.length * 2);
      audio.set(left);
      audio.set(right, left.length);
      return audio;
    } finally {
      renderer.reset();
      Math.random = random;
      resetSynthNoiseTables();
    }
  };
  for (const type of INSTRUMENT_TYPES) {
    if (!usesUpstreamSynth(createInstrument(type))) {
      continue;
    }
    let audible = false;
    for (let seed = 0; seed < 64 && !audible; seed++) {
      const instrument = generateType(type, seed * 10_007);
      const effectEnvelopes = instrument.envelopes.filter((envelope) =>
        envelope.target.startsWith("effect:"),
      );
      if (effectEnvelopes.length === 0) {
        continue;
      }
      const disabled = structuredClone(instrument);
      for (const envelope of disabled.envelopes) {
        if (envelope.target.startsWith("effect:")) {
          envelope.enabled = false;
        }
      }
      const modulated = render(instrument);
      const fixed = render(disabled);
      let energy = 0;
      let difference = 0;
      for (let index = 0; index < modulated.length; index++) {
        const sample = required(modulated[index]);
        energy += sample ** 2;
        difference = Math.max(difference, Math.abs(sample - required(fixed[index])));
      }
      audible = energy > 1e-9 && difference > 1e-6;
    }
    expect(audible, `${type}: generated effect envelopes must change audible audio`).toBe(true);
  }
});

test("resource generation uses ready presets and samples and preserves sample playback configuration", () => {
  const sample: AssetView = {
    id: "generation-sample",
    name: "sample",
    type: "audio",
    status: "ready",
    url: "https://example.com/sample.wav",
    rootKey: 42,
    start: 20,
    loopStart: 100,
    loopEnd: 900,
    frames: 1000,
    mode: "Ping-pong",
    backwards: true,
  };
  const font: AssetView = {
    id: "generation-font",
    name: "font",
    type: "soundfont",
    status: "ready",
    url: "https://example.com/font.sf2",
    presets: [
      { name: "Piano", bank: 0, program: 0 },
      { name: "Kit", bank: 128, program: 12 },
    ],
  };
  const unavailable: AssetView[] = [
    { ...sample, id: "unresolved-sample", status: "unloaded" },
    { ...font, id: "loading-font", status: "loading" },
    { ...font, id: "empty-font", presets: [] },
  ];
  const programs = new Set<number>();
  const waves = new Set<string>();
  for (let seed = 0; seed < 100; seed++) {
    const soundFont = generateType("SoundFont", seed * 10_007, [...unavailable, font]);
    expect(soundFont.resourceId).toBe(font.id);
    programs.add(soundFont.program);
    expect(font.presets).toContainEqual({
      name: soundFont.preset,
      bank: soundFont.bank,
      program: soundFont.program,
    });
    const chip = generateType("chip wave", seed * 10_007, [...unavailable, sample]);
    waves.add(chip.resourceId || chip.wave);
    if (chip.resourceId) {
      expect(chip.resourceId).toBe(sample.id);
      expect(chip).toMatchObject({
        rootKey: 42,
        sampleStart: 20,
        loopStart: 100,
        loopEnd: 900,
        loopMode: "Ping-pong",
        backwards: true,
      });
    }
    expect(randomInstrument(undefined, seeded(seed), unavailable).type).not.toBe("SoundFont");
  }
  expect(programs.size).toBe(2);
  expect(waves).toEqual(new Set([...CHIP_WAVES, sample.id]));
});

test("generated settings survive song serialization and render finite, audible audio", () => {
  const resource: Resource = {
    id: "generation-audio",
    url: "https://example.com/sample.wav",
  };
  const asset: AssetView = {
    ...resource,
    type: "audio",
    name: "sample",
    status: "ready",
    frames: 1024,
  };
  const wave = Float32Array.from({ length: 1024 }, (_, index) => Math.sin((index * Math.PI) / 32));
  registerAudioResource(resource.id, wave, wave, 24_000);
  try {
    for (const type of INSTRUMENT_TYPES.filter((entry) => entry !== "SoundFont")) {
      const instrument = generateType(type, 73_152, [asset]);
      const song = createSong();
      const channel = required(song.channels[0]);
      song.channels = [channel];
      song.resources = [resource];
      channel.instruments = [instrument];
      channel.cells[0] = 1;
      required(channel.patterns[1]).notes = [createNote(0, 2, 48)];
      const restored = parseSongBytes(serializeSongBytes(song));
      expect(restored).toEqual(song);
      const renderer = new SongRenderer(restored, 24_000);
      const audio = new Float32Array(12_000);
      const right = new Float32Array(audio.length);
      renderer.process(audio, right);
      expect(audio.every(Number.isFinite), type).toBe(true);
      expect(right.every(Number.isFinite), type).toBe(true);
      expect(
        audio.some((value) => Math.abs(value) > 1e-7),
        type,
      ).toBe(true);
      renderer.reset();
    }
  } finally {
    removeAudioResource(resource.id);
  }
});

test("random preset selects ready SoundFont presets and retains instrument identity", () => {
  const previous = createInstrument("chip wave");
  previous.volume = 0.4;
  const font: AssetView = {
    id: "font",
    name: "Font",
    type: "soundfont",
    status: "ready",
    url: "font.sf2",
    presets: [{ name: "Kit", bank: 128, program: 12 }],
  };
  const selected = randomPreset(previous, [font], () => 0.999999);
  expect(selected).toMatchObject({
    id: previous.id,
    volume: 0.4,
    type: "SoundFont",
    resourceId: "font",
    preset: "Kit",
    bank: 128,
    program: 12,
  });
  expect(randomPreset(previous, [{ ...font, status: "loading" }], () => 0.999999).type).not.toBe(
    "SoundFont",
  );
});
