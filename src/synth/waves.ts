const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));

const polyBlep = (phase: number, step: number): number =>
  ((): number => {
    if (phase < step) {
      return 2 * (phase / step) - (phase / step) ** 2 - 1;
    }
    return phase > 1 - step ? ((phase - 1) / step) ** 2 + 2 * ((phase - 1) / step) + 1 : 0;
  })();
type CustomCycle = {
  cosine: Float64Array;
  sine: Float64Array;
  tables: Map<number, Float32Array>;
};
const customCycles = new WeakMap<number[], CustomCycle>();
const CUSTOM_TABLE_LENGTH = 2048;
// Periodic waves suppress aliasing and custom cycles remove DC.
const customCycleTable = (
  drawing: number[],
  frequency: number,
  sampleRate: number,
): Float32Array | undefined => {
  let cycle = customCycles.get(drawing);
  if (!cycle) {
    const cosine = new Float64Array(33);
    const sine = new Float64Array(33);
    const mean = drawing.reduce((sum, value): number => sum + value, 0) / 64;
    for (let harmonic = 1; harmonic <= 32; harmonic++) {
      for (let index = 0; index < 64; index++) {
        const value = ((drawing[index] ?? 0) - mean) / 24;
        const angle = (TAU * harmonic * index) / 64;
        cosine[harmonic] = (cosine[harmonic] ?? 0) + (value * Math.cos(angle)) / 64;
        sine[harmonic] = (sine[harmonic] ?? 0) + (value * Math.sin(angle)) / 64;
      }
      const multiplier = harmonic === 32 ? 1 : 2;
      cosine[harmonic] = (cosine[harmonic] ?? 0) * multiplier;
      sine[harmonic] = (sine[harmonic] ?? 0) * multiplier;
    }
    cycle = { cosine, sine, tables: new Map() };
    // Changes replace saved drawing arrays, so identity caching retains gesture updates.
    customCycles.set(drawing, cycle);
  }
  const harmonics =
    frequency === 0 ? 32 : Math.min(32, Math.floor((sampleRate * 0.48) / frequency));
  if (harmonics < 1) {
    return undefined;
  }
  let table = cycle.tables.get(harmonics);
  if (!table) {
    table = new Float32Array(CUSTOM_TABLE_LENGTH);
    for (let index = 0; index < CUSTOM_TABLE_LENGTH; index++) {
      let value = 0;
      const angle = (TAU * index) / CUSTOM_TABLE_LENGTH;
      for (let harmonic = 1; harmonic <= harmonics; harmonic++) {
        value +=
          (cycle.cosine[harmonic] ?? 0) * Math.cos(angle * harmonic) +
          (cycle.sine[harmonic] ?? 0) * Math.sin(angle * harmonic);
      }
      table[index] = value;
    }
    cycle.tables.set(harmonics, table);
  }
  return table;
};
const interpolateCycle = (table: Float32Array, phase: number): number => {
  const index = phase * CUSTOM_TABLE_LENGTH;
  const left = Math.floor(index);
  const fraction = index - left;
  return (
    (table[left] ?? 0) * (1 - fraction) + (table[(left + 1) % CUSTOM_TABLE_LENGTH] ?? 0) * fraction
  );
};
const trapezoidCycle = Array.from(
  { length: 64 },
  (_, index): number => clamp(Math.sin((index / 64) * TAU) * 1.5, -1, 1) * 24,
);
const spikyAmplitudes = [35 / 64, -21 / 64, 7 / 64, -1 / 64];
export type Waveform =
  | "1/4 pulse"
  | "1/8 pulse"
  | "custom"
  | "noise"
  | "pulse"
  | "quasi-sine"
  | "ramp"
  | "sawtooth"
  | "sine"
  | "spiky"
  | "square"
  | "trapezoid"
  | "triangle";
// FM prepares the shape when a saved wave changes, rather than normalizing and
// searching its name for every stereo oscillator sample.
export const classifyWave = (wave: string): Waveform => {
  const name = wave.toLowerCase();
  if (name === "white noise" || name === "noise") {
    return "noise";
  }
  if (name === "custom") {
    return "custom";
  }
  if (name.includes("saw") || name === "ramp") {
    return name === "ramp" ? "ramp" : "sawtooth";
  }
  if (name.includes("pulse") || name === "square") {
    return name === "square" || name === "1/4 pulse" || name === "1/8 pulse" ? name : "pulse";
  }
  return name === "triangle" || name === "trapezoid" || name === "quasi-sine" || name === "spiky"
    ? name
    : "sine";
};
const wrapPhase = (phase: number): number => {
  // Keep the original +1 rounding, including values that round up to 2, while
  // avoiding floating remainders for the usual single-cycle phase range.
  const remainder = phase > -1 && phase < 1 ? phase : phase % 1;
  const shifted = remainder + 1;
  if (shifted >= 1) {
    return shifted === 2 ? 0 : shifted - 1;
  }
  return shifted;
};
const sampleSine = (phase: number): number => Math.sin(wrapPhase(phase) * TAU);
const sampleNoise = (): number => Math.random() * 2 - 1;
const sampleSilence = (): number => 0;
const isOutOfBand = (frequency: number, sampleRate: number): boolean =>
  frequency >= sampleRate * 0.48 || frequency < 0;
const samplePeriodicWaveform = (
  waveform: Waveform,
  phase: number,
  frequency: number,
  sampleRate: number,
  pulseWidth: number,
  custom: number[] | undefined,
): number => {
  const p = wrapPhase(phase);
  if (waveform === "custom" && custom?.length === 64) {
    const table = customCycleTable(custom, frequency, sampleRate);
    return table ? interpolateCycle(table, p) : 0;
  }
  if (waveform === "sawtooth" || waveform === "ramp") {
    const step = clamp(frequency / sampleRate, 1e-9, 0.48);
    const saw = 2 * p - 1 - polyBlep(p, step);
    return waveform === "ramp" ? -saw : saw;
  }
  if (
    waveform === "pulse" ||
    waveform === "square" ||
    waveform === "1/4 pulse" ||
    waveform === "1/8 pulse"
  ) {
    const step = clamp(frequency / sampleRate, 1e-9, 0.48);
    const width = ((): number => {
      if (waveform === "square") {
        return 0.5;
      }
      if (waveform === "1/4 pulse") {
        return 0.25;
      }
      return waveform === "1/8 pulse" ? 0.125 : clamp(pulseWidth, 0.01, 0.99);
    })();
    return (p < width ? 1 : -1) + polyBlep(p, step) - polyBlep((p - width + 1) % 1, step);
  }
  if (waveform === "triangle") {
    let sample = 0;
    for (
      let harmonic = 1;
      harmonic * frequency < sampleRate * 0.45 && harmonic < 40;
      harmonic += 2
    ) {
      sample +=
        (Math.sin(p * TAU * harmonic) * (harmonic % 4 === 1 ? 1 : -1)) / (harmonic * harmonic);
    }
    return (sample * 8) / (Math.PI * Math.PI);
  }
  if (waveform === "trapezoid") {
    const table = customCycleTable(trapezoidCycle, frequency, sampleRate);
    return table ? interpolateCycle(table, p) : 0;
  }
  if (waveform === "quasi-sine") {
    return (
      Math.sin(p * TAU) * 0.8 +
      (frequency * 2 < sampleRate * 0.48 ? Math.sin(p * TAU * 2) * 0.2 : 0)
    );
  }
  if (waveform === "spiky") {
    let value = 0;
    for (let index = 0; index < spikyAmplitudes.length; index++) {
      const harmonic = index * 2 + 1;
      if (harmonic * frequency < sampleRate * 0.48) {
        value += (spikyAmplitudes[index] ?? 0) * Math.sin(p * TAU * harmonic);
      }
    }
    return value;
  }
  return Math.sin(p * TAU);
};
export const sampleWaveform = (
  waveform: Waveform,
  phase: number,
  frequency: number,
  sampleRate: number,
  pulseWidth = 0.5,
  custom?: number[],
): number => {
  if (waveform === "noise") {
    return sampleNoise();
  }
  if (isOutOfBand(frequency, sampleRate)) {
    return 0;
  }
  return waveform === "sine"
    ? sampleSine(phase)
    : samplePeriodicWaveform(waveform, phase, frequency, sampleRate, pulseWidth, custom);
};
export const prepareWaveform = (
  waveform: Waveform,
  frequency: number,
  sampleRate: number,
  pulseWidth: number,
  custom: number[],
): ((phase: number) => number) => {
  if (waveform === "noise") {
    return sampleNoise;
  }
  if (isOutOfBand(frequency, sampleRate)) {
    return sampleSilence;
  }
  if (waveform === "sine" || (waveform === "custom" && custom.length !== 64)) {
    return sampleSine;
  }
  if (waveform === "custom" || waveform === "trapezoid") {
    const drawing = waveform === "custom" ? custom : trapezoidCycle;
    const table = customCycleTable(drawing, frequency, sampleRate);
    return table ? (phase): number => interpolateCycle(table, wrapPhase(phase)) : sampleSilence;
  }
  return (phase): number =>
    samplePeriodicWaveform(waveform, phase, frequency, sampleRate, pulseWidth, custom);
};
export const waveSample = (
  wave: string,
  phase: number,
  frequency: number,
  sampleRate: number,
  pulseWidth = 0.5,
  custom?: number[],
): number => sampleWaveform(classifyWave(wave), phase, frequency, sampleRate, pulseWidth, custom);
