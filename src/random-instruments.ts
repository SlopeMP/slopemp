import { envelopeTargets, randomEnvelope } from "./instrument-envelopes";
import {
  CHIP_WAVES,
  createFMOperator,
  createInstrument,
  FM_WAVES,
  INSTRUMENT_TYPES,
  PRESET_GROUPS,
  presetInstrument,
} from "./instruments";
import type { Instrument } from "./instruments";
import { randomEffects } from "./random-effects";
import type { AssetView } from "./resource-identity";
import { noises } from "./synth/noise";

const choose = <T>(values: readonly T[], random: () => number): T => {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) {
    throw new Error("Cannot generate an instrument from an empty selection.");
  }
  return value;
};

export const randomPreset = (
  previous: Instrument,
  assets: readonly AssetView[],
  random: () => number = Math.random,
): Instrument => {
  const factory = Object.values(PRESET_GROUPS)
    .flat()
    .map((name) => ({ kind: "factory" as const, name }));
  const fonts = assets
    .filter((resource) => resource.type === "soundfont" && resource.status === "ready")
    .flatMap((resource) =>
      (resource.presets ?? []).map((preset) => ({ kind: "font" as const, resource, preset })),
    );
  const selected = choose([...factory, ...fonts], random);
  if (selected.kind === "factory") {
    return presetInstrument(selected.name, previous);
  }
  const next = createInstrument("SoundFont");
  next.id = previous.id;
  next.volume = previous.volume;
  next.presetEffects = previous.presetEffects;
  next.resourceId = selected.resource.id;
  next.bank = selected.preset.bank;
  next.program = selected.preset.program;
  next.preset = selected.preset.name;
  return next;
};

// Broad bands, isolated peaks and variable rolloff produce more distinct timbres
// than filling every spectrum bin with equally strong noise.
const randomSpectrum = (length: number, random: () => number): number[] => {
  const center = random() * (length - 1);
  const width = 1 + random() * length * 0.5;
  const rolloff = random() * 2;
  const floor = random() * 0.35;
  return Array.from({ length }, (_, index) => {
    const band = Math.exp(-(((index - center) / width) ** 2));
    return Math.min(1, ((floor + band) * (0.2 + random() * 0.8)) / (1 + index / length) ** rolloff);
  });
};

const randomCycle = (random: () => number): number[] => {
  const partials = Array.from({ length: 8 }, (_, index) => ({
    amplitude: (random() * 2 - 1) / (index + 1),
    phase: random() * Math.PI * 2,
  }));
  const cycle = Array.from({ length: 64 }, (_, index) =>
    partials.reduce(
      (sum, partial, harmonic) =>
        sum + partial.amplitude * Math.sin((index * Math.PI * (harmonic + 1)) / 32 + partial.phase),
      0,
    ),
  );
  const peak = Math.max(0.001, ...cycle.map(Math.abs));
  return cycle.map((value) => Math.round((value / peak) * 24));
};

const randomFM = (instrument: Instrument, random: () => number): void => {
  instrument.operators = Array.from({ length: 2 + Math.floor(random() * 5) }, (_, index) => {
    const operator = createFMOperator(index);
    operator.carrier = index === 0 || random() < 0.25;
    operator.ratio = choose([0.5, 1, 1, 2, 2, 3, 4, 5, 6, 8], random);
    operator.offset = random() < 0.3 ? (random() * 2 - 1) * 15 : 0;
    operator.amplitude = operator.carrier ? 0.55 + random() * 0.4 : 0.15 + random() * 0.7;
    operator.coarse = choose([-12, 0, 0, 0, 12], random);
    operator.fine = Math.round((random() * 2 - 1) * 25);
    operator.pan = random() * 1.2 - 0.6;
    operator.phase = random() * 360;
    operator.stereoPhase = random() * 180 - 90;
    operator.stereoDetune = random() * 40 - 20;
    operator.invert = random() < 0.5;
    operator.wave = choose(FM_WAVES, random);
    operator.pulseWidth = 0.05 + random() * 0.9;
    if (operator.wave === "Custom") {
      operator.customWave = randomCycle(random);
    }
    return operator;
  });
  instrument.connections = [];
  instrument.feedback = [];
  instrument.operators.forEach((operator, index) => {
    if (index > 0) {
      // Edges always descend in index: every modulator reaches a carrier and
      // the normal algorithm cannot cycle. Feedback has its own route list.
      const destinations = instrument.operators.slice(0, index);
      const destination = choose(destinations, random);
      instrument.connections.push({ from: operator.id, to: destination.id });
      for (const extra of destinations) {
        if (extra !== destination && random() < 0.2) {
          instrument.connections.push({ from: operator.id, to: extra.id });
        }
      }
    }
    if (random() < 0.3) {
      instrument.feedback.push({
        from: operator.id,
        to: choose(instrument.operators, random).id,
      });
    }
  });
  instrument.feedbackVolume = instrument.feedback.length > 0 ? random() * 0.6 : 0;
  instrument.phaseRandomness = random();
};

const randomChipWave = (
  instrument: Instrument,
  assets: readonly AssetView[],
  random: () => number,
): void => {
  const samples = assets.filter(
    (resource) => resource.type === "audio" && resource.status === "ready",
  );
  const wave = Math.floor(random() * (CHIP_WAVES.length + samples.length));
  const sample = samples[wave - CHIP_WAVES.length];
  if (!sample) {
    instrument.wave = CHIP_WAVES[wave] ?? "square";
    return;
  }
  instrument.resourceId = sample.id;
  instrument.rootKey = sample.rootKey ?? 60;
  instrument.sampleStart = sample.start ?? 0;
  instrument.loopStart = sample.loopStart ?? 0;
  instrument.loopEnd = sample.loopEnd ?? sample.frames ?? 44_100;
  instrument.loopMode = sample.mode ?? "Loop";
  instrument.backwards = sample.backwards ?? false;
};

// Random Preset chooses a factory sound; Random Generated customizes synthesis,
// assets and modulation while retaining the instrument's routing and mix.
export const randomInstrument = (
  previous?: Instrument,
  random: () => number = Math.random,
  assets: readonly AssetView[] = [],
): Instrument => {
  const fonts = assets
    .filter((resource) => resource.type === "soundfont" && resource.status === "ready")
    .flatMap((resource) => (resource.presets ?? []).map((preset) => ({ resource, preset })));
  const types = INSTRUMENT_TYPES.filter((type) => type !== "SoundFont" || fonts.length > 0);
  const next = createInstrument(choose(types, random));
  next.name = `Generated ${next.type}`;
  next.id = previous?.id ?? next.id;
  next.volume = previous?.volume ?? next.volume;
  next.presetEffects = previous?.presetEffects ?? next.presetEffects;
  next.attack = 0.002 + random() ** 2 * 0.3;
  next.release = 0.03 + random() ** 2 * 0.8;
  if (next.type === "chip wave") {
    randomChipWave(next, assets, random);
  } else if (next.type === "SoundFont") {
    const { resource, preset } = choose(fonts, random);
    next.resourceId = resource.id;
    next.bank = preset.bank;
    next.program = preset.program;
    next.preset = preset.name;
    next.name = `Generated ${preset.name}`;
  } else if (next.type === "FM (n-op)") {
    randomFM(next, random);
  } else if (next.type === "basic noise") {
    next.noise = choose(noises, random).name;
  } else if (next.type === "spectrum") {
    next.spectrum = randomSpectrum(next.spectrum.length, random);
  } else if (next.type === "drumset") {
    next.drums = next.drums.map((drum) => ({
      spectrum: randomSpectrum(drum.spectrum.length, random),
      envelope: randomEnvelope("volume", random, true),
    }));
  } else if (next.type === "harmonics" || next.type === "picked string") {
    next.harmonics = randomSpectrum(next.harmonics.length, random);
    next.sustain = 0.15 + random() * 0.8;
  } else if (next.type === "Custom chip wave") {
    next.customWave = randomCycle(random);
  }
  if (next.type === "pulse width" || next.type === "supersaw") {
    next.pulseWidth = 0.05 + random() * 0.9;
  }
  if (next.type === "supersaw") {
    next.spread = random();
    next.dynamism = random();
    next.shape = random();
  }
  next.effects = randomEffects(random);
  const targets = envelopeTargets(next);
  const envelopeCount = Math.min(targets.length, 1 + Math.floor(random() * 3));
  next.envelopes = Array.from({ length: envelopeCount }, () => {
    const [target] = targets.splice(Math.floor(random() * targets.length), 1);
    return randomEnvelope(target?.value ?? "volume", random);
  });
  return next;
};
