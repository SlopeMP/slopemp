import type { SFModulator } from "@slopemp/song/soundfont-types";
export type { SFModulator } from "@slopemp/song/soundfont-types";

// Preserve SF2 preset/instrument zones, stereo links, generators, modulators and effect sends.
// Generators without an explicit default start at zero.
export const SF2_DEFAULT_GENERATORS: ReadonlyMap<number, number> = new Map([
  [8, 13_500], // Filter cutoff
  [21, -12_000], // Modulation LFO delay
  [23, -12_000], // Vibrato LFO delay
  [25, -12_000], // Modulation envelope delay
  [26, -12_000], // Modulation envelope attack
  [27, -12_000], // Modulation envelope hold
  [28, -12_000], // Modulation envelope decay
  [30, -12_000], // Modulation envelope release
  [33, -12_000], // Volume envelope delay
  [34, -12_000], // Volume envelope attack
  [35, -12_000], // Volume envelope hold
  [36, -12_000], // Volume envelope decay
  [38, -12_000], // Volume envelope release
  [46, -1], // Fixed key
  [47, -1], // Fixed velocity
  [56, 100], // Scale tuning
  [58, -1], // Root key
]);
export const SF2_DEFAULT_MODULATORS: SFModulator[] = [
  { source: 1282, destination: 48, amount: 960, amountSource: 0, transform: 0 },
  { source: 258, destination: 8, amount: -2400, amountSource: 3074, transform: 0 },
  { source: 13, destination: 6, amount: 50, amountSource: 0, transform: 0 },
  { source: 129, destination: 6, amount: 50, amountSource: 0, transform: 0 },
  { source: 1415, destination: 48, amount: 960, amountSource: 0, transform: 0 },
  { source: 650, destination: 17, amount: 500, amountSource: 0, transform: 0 },
  { source: 1419, destination: 48, amount: 960, amountSource: 0, transform: 0 },
  { source: 219, destination: 16, amount: 200, amountSource: 0, transform: 0 },
  { source: 221, destination: 15, amount: 200, amountSource: 0, transform: 0 },
  { source: 526, destination: 52, amount: 12_700, amountSource: 16, transform: 0 },
];
export type SFControllerState = {
  key: number;
  velocity: number;
  polyPressure: number;
  channelPressure: number;
  pitchWheel: number;
  pitchWheelSensitivity: number;
  cc: Record<number, number>;
};
export const defaultSFControllers = (key = 60, velocity = 127): SFControllerState => ({
  key,
  velocity,
  polyPressure: 0,
  channelPressure: 0,
  pitchWheel: 8192,
  pitchWheelSensitivity: 2,
  cc: { 7: 127, 10: 64, 11: 127, 91: 40, 93: 0 },
});
export const timecentsToSeconds = (value: number): number =>
  value <= -32_768 ? 0 : 2 ** (Math.max(-12_000, Math.min(8000, value)) / 1200);
export const absoluteCentsToHz = (value: number): number => 8.175798915643707 * 2 ** (value / 1200);
const clip = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));
export const sfModulatorSource = (source: number, state: SFControllerState): number => {
  if (source === 0) {
    return 1;
  }
  const index = source & 127;
  const isCC = Boolean(source & 128);
  const negative = Boolean(source & 256);
  const bipolar = Boolean(source & 512);
  const curve = source >>> 10;
  let raw = ((): number => {
    if (isCC) {
      return state.cc[index] ?? 0;
    }
    return ((): number => {
      if (index === 2) {
        return state.velocity;
      }
      return ((): number => {
        if (index === 3) {
          return state.key;
        }
        return ((): number => {
          if (index === 10) {
            return state.polyPressure;
          }
          return ((): number => {
            if (index === 13) {
              return state.channelPressure;
            }
            return ((): number => {
              if (index === 14) {
                return state.pitchWheel;
              }
              return index === 16 ? state.pitchWheelSensitivity : 0;
            })();
          })();
        })();
      })();
    })();
  })();
  raw = clip(raw / (index === 14 && !isCC ? 16_384 : 127));
  if (negative) {
    raw = 1 - raw;
  }
  const transformConcave = (value: number): number =>
    ((): number => {
      if (value <= 0) {
        return 0;
      }
      return value >= 1 ? 1 : clip(1 + (20 / 96) * Math.log10(value * value));
    })();
  const transform = (value: number): number => {
    if (curve === 0) {
      return value;
    }
    if (curve === 3) {
      return value >= 0.5 ? 1 : 0;
    }
    if (curve === 1) {
      return ((): number => {
        if (value <= 0) {
          return 0;
        }
        return value >= 1 ? 1 : clip(1 + (20 / 96) * Math.log10(value * value));
      })();
    }
    if (curve === 2) {
      return 1 - transformConcave(1 - value);
    }
    return 0;
  };

  return bipolar ? Math.sign(raw * 2 - 1) * transform(Math.abs(raw * 2 - 1)) : transform(raw);
};
export const applySFModulators = (
  generators: ReadonlyMap<number, number>,
  modulators: readonly SFModulator[],
  state: SFControllerState,
): Map<number, number> => {
  const result = new Map(generators);
  for (const modulator of modulators) {
    let contribution =
      sfModulatorSource(modulator.source, state) *
      sfModulatorSource(modulator.amountSource, state) *
      modulator.amount;
    if (modulator.transform === 2) {
      contribution = Math.abs(contribution);
    }
    if (Number.isFinite(contribution)) {
      result.set(modulator.destination, (result.get(modulator.destination) ?? 0) + contribution);
    }
  }
  return result;
};
export const mergeSFModulators = (
  base: readonly SFModulator[],
  overrides: readonly SFModulator[],
): SFModulator[] => {
  const result = new Map(
    base.map((item) => [
      `${item.source}:${item.destination}:${item.amountSource}:${item.transform}`,
      item,
    ]),
  );
  for (const item of overrides) {
    result.set(`${item.source}:${item.destination}:${item.amountSource}:${item.transform}`, item);
  }
  return [...result.values()];
};
export type PreparedSFEnvelope = {
  volume: boolean;
  delay: number;
  attack: number;
  hold: number;
  decay: number;
  sustain: number;
  sustainExponent: number;
  release: number;
};
// Resolve generator units and key scaling when a zone or its controllers change.
// The sample loop only evaluates the current stage, without reading generator maps.
export const prepareSFEnvelope = (
  g: ReadonlyMap<number, number>,
  key: number,
  volume: boolean,
): PreparedSFEnvelope => {
  const base = volume ? 33 : 25;
  const sustainValue = g.get(base + 4) ?? 0;
  // SF2 generator 37 is attenuation from the attack peak. Negative values mean full sustain.
  const sustainExponent = -Math.max(0, sustainValue) / 200;
  return {
    volume,
    delay: timecentsToSeconds(g.get(base) ?? -12_000),
    attack: timecentsToSeconds(g.get(base + 1) ?? -12_000),
    hold: timecentsToSeconds((g.get(base + 2) ?? -12_000) + (g.get(base + 6) ?? 0) * (60 - key)),
    decay: timecentsToSeconds((g.get(base + 3) ?? -12_000) + (g.get(base + 7) ?? 0) * (60 - key)),
    sustain: volume ? 10 ** sustainExponent : 1 - clip(sustainValue / 1000),
    sustainExponent,
    release: timecentsToSeconds(g.get(base + 5) ?? -12_000),
  };
};
const preparedSFEnvelopeLevel = (envelope: PreparedSFEnvelope, age: number): number => {
  const t = age - envelope.delay;
  if (t < 0) {
    return 0;
  }
  if (t < envelope.attack) {
    return t / Math.max(1e-9, envelope.attack);
  }
  if (t < envelope.attack + envelope.hold) {
    return 1;
  }
  const progress = clip((t - envelope.attack - envelope.hold) / Math.max(1e-9, envelope.decay));
  if (progress >= 1) {
    return envelope.sustain;
  }
  return envelope.volume
    ? 10 ** (envelope.sustainExponent * progress)
    : 1 - (1 - envelope.sustain) * progress;
};
export const preparedSFEnvelopeValue = (
  envelope: PreparedSFEnvelope,
  age: number,
  releasedAt?: number,
): number => {
  if (releasedAt === undefined || age < releasedAt) {
    return preparedSFEnvelopeLevel(envelope, age);
  }
  const progress = clip((age - releasedAt) / Math.max(1e-9, envelope.release));
  if (progress >= 1) {
    return 0;
  }
  const initial = preparedSFEnvelopeLevel(envelope, releasedAt);
  return envelope.volume ? initial * 10 ** (-5 * progress) : initial * (1 - progress);
};

export type SFEnvelopeState = {
  nextAge: number;
  releasedAt: number | undefined;
  until: number;
  remaining: number;
  level: number;
  multiplier: number;
  delta: number;
};
export const createSFEnvelopeState = (): SFEnvelopeState => ({
  nextAge: Number.NaN,
  releasedAt: undefined,
  until: 0,
  remaining: 0,
  level: 0,
  multiplier: 1,
  delta: 0,
});

const anchorSFEnvelope = (
  envelope: PreparedSFEnvelope,
  state: SFEnvelopeState,
  age: number,
  releasedAt: number | undefined,
  step: number,
): void => {
  state.releasedAt = releasedAt;
  state.level = preparedSFEnvelopeValue(envelope, age, releasedAt);
  state.multiplier = 1;
  state.delta = 0;
  state.until = Number.POSITIVE_INFINITY;
  state.remaining = 256;
  if (releasedAt !== undefined && age >= releasedAt) {
    const release = Math.max(1e-9, envelope.release);
    if (age - releasedAt < release) {
      state.until = releasedAt + release;
      if (envelope.volume) {
        state.multiplier = 10 ** ((-5 * step) / release);
      } else {
        state.delta = (-preparedSFEnvelopeLevel(envelope, releasedAt) * step) / release;
      }
    }
  } else {
    const t = age - envelope.delay;
    if (t < 0) {
      state.until = envelope.delay;
    } else if (t < envelope.attack) {
      state.until = envelope.delay + envelope.attack;
      state.delta = step / Math.max(1e-9, envelope.attack);
    } else if (t < envelope.attack + envelope.hold) {
      state.until = envelope.delay + envelope.attack + envelope.hold;
    } else if (t - envelope.attack - envelope.hold < envelope.decay) {
      state.until = envelope.delay + envelope.attack + envelope.hold + envelope.decay;
      const decay = Math.max(1e-9, envelope.decay);
      if (envelope.volume) {
        state.multiplier = 10 ** ((envelope.sustainExponent * step) / decay);
      } else {
        state.delta = (-(1 - envelope.sustain) * step) / decay;
      }
    }
    if (releasedAt !== undefined) {
      state.until = Math.min(state.until, releasedAt);
    }
  }
};

// Native stages are straight lines or exponentials. Advance them with additions
// and multiplications, anchoring periodically so long tails cannot accumulate drift.
// A discontinuity in age or a new release always starts from the analytical curve.
export const sampleSFEnvelope = (
  envelope: PreparedSFEnvelope,
  state: SFEnvelopeState,
  age: number,
  releasedAt: number | undefined,
  step: number,
): number => {
  if (
    age !== state.nextAge ||
    releasedAt !== state.releasedAt ||
    age >= state.until ||
    state.remaining === 0
  ) {
    anchorSFEnvelope(envelope, state, age, releasedAt, step);
  }
  const value = state.level;
  state.level = state.level * state.multiplier + state.delta;
  state.nextAge = age + step;
  state.remaining--;
  return value;
};
