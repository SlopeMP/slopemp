import { AudioOutputBuffer } from "./audio-output-buffer";
import { audioResourceIds } from "./audio-resource-ids";
import { evaluateLane, prepareLane } from "./automation";
import { Chorus } from "./chorus";
import { EFFECT_PARAMETERS, MAX_INSTRUMENT_VOLUME, TEMPO_DELAY_EFFECTS } from "./instruments";
import type { Effect, Envelope, Instrument } from "./instruments";
import { notesTie, required } from "./model";
import type { AutomationLane, Channel, Note, Song } from "./model";
import { PlaybackClock } from "./playback-clock";
import type { AudioBlock } from "./playback-clock";
import { defaultAudioThreads, normalizeAudioThreads } from "./preferences";
import { shareSamples } from "./shared-samples";
import { createNativeSynth, usesUpstreamSynth } from "./synth/adapter";
import type { NativeSynth } from "./synth/adapter";
import { createFMVoice, sampleFM } from "./synth/fm";
import type { FMVoiceState } from "./synth/fm";
import {
  absoluteCentsToHz,
  applySFModulators,
  defaultSFControllers,
  preparedSFEnvelopeValue,
  prepareSFEnvelope,
  sampleSFEnvelope,
  SF2_DEFAULT_GENERATORS,
} from "./synth/soundfont";
import { decodePCMSoundFont, parseSoundFont } from "./synth/soundfont-file";
import type { SoundFont, SoundFontPreset } from "./synth/soundfont-file";
import { prepareSoundFontVoice } from "./synth/soundfont-voice";
import type { SFVoiceState } from "./synth/soundfont-voice";
import { waveSample } from "./synth/waves";
export { waveSample } from "./synth/waves";
// Envelope targets use stable instrument/effect/parameter identities, including filter points.
// Repeated effects have independent targets; view expansion never changes evaluation order.
export const finite = (value: number, fallback = 0): number => {
  if (Number.isFinite(value)) {
    return value;
  }
  return Number.isNaN(value) ? fallback : Math.sign(value) * 1e6;
};
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, finite(value)));
const TAU = Math.PI * 2;
const noPitches: number[] = [];
const defaultNoteContour = { interval: 0, volume: 1 };
const envelopeNumber = (envelope: Envelope, key: string, fallback: number): number =>
  typeof envelope[key] === "number" ? finite(envelope[key], fallback) : fallback;
const stagedProgress = (
  envelope: Envelope,
  time: number,
  releasedAt: number | undefined,
  key: number,
): number => {
  const nativeVolume = envelope.law === "SF2 volume";
  const nativeModulation = envelope.law === "SF2 modulation";
  if (nativeVolume || nativeModulation) {
    const base = nativeVolume ? 33 : 25;
    const generators = new Map(SF2_DEFAULT_GENERATORS);
    generators.set(base, envelopeNumber(envelope, "delay", -32_768));
    generators.set(base + 1, envelope.attack);
    generators.set(base + 2, envelopeNumber(envelope, "hold", -32_768));
    generators.set(base + 3, envelope.decay);
    generators.set(base + 4, envelope.sustain);
    generators.set(base + 5, envelope.release);
    generators.set(base + 6, envelopeNumber(envelope, "keyToHold", 0));
    generators.set(base + 7, envelopeNumber(envelope, "keyToDecay", 0));
    const effective = applySFModulators(
      generators,
      envelope.sf2Modulators ?? [],
      defaultSFControllers(key),
    );
    const initial = clamp(envelopeNumber(envelope, "initialLevel", 0), 0, 1);
    const terminal = clamp(envelopeNumber(envelope, "terminalLevel", 0), 0, 1);
    const prepared = prepareSFEnvelope(effective, key, nativeVolume);
    const native = preparedSFEnvelopeValue(prepared, time, releasedAt);
    if (releasedAt === undefined || time < releasedAt) {
      return initial + (1 - initial) * native;
    }
    const progress = clamp((time - releasedAt) / Math.max(1e-9, prepared.release), 0, 1);
    let remaining = 1 - progress;
    if (nativeVolume) {
      remaining = progress >= 1 ? 0 : 10 ** (-5 * progress);
    }
    return native * (1 - initial) + initial * remaining + terminal * (1 - remaining);
  }
  const delay = Math.max(0, envelopeNumber(envelope, "delay", 0));
  const attack = Math.max(0, envelope.attack);
  const hold = Math.max(0, envelopeNumber(envelope, "hold", 0));
  const decay = Math.max(0, envelope.decay);
  const sustain = clamp(envelope.sustain, 0, 1);
  const initial = clamp(envelopeNumber(envelope, "initialLevel", 0), 0, 1);
  const terminal = clamp(envelopeNumber(envelope, "terminalLevel", 0), 0, 1);
  const levelAt = (at: number): number => {
    const elapsed = at - delay;
    if (elapsed < 0) {
      return initial;
    }
    if (elapsed < attack) {
      return initial + ((1 - initial) * elapsed) / Math.max(1e-9, attack);
    }
    if (elapsed < attack + hold) {
      return 1;
    }
    if (elapsed < attack + hold + decay) {
      return 1 - ((1 - sustain) * (elapsed - attack - hold)) / Math.max(1e-9, decay);
    }
    return sustain;
  };
  if (releasedAt === undefined || time < releasedAt) {
    return levelAt(time);
  }
  const progress = clamp((time - releasedAt) / Math.max(1e-9, envelope.release), 0, 1);
  return levelAt(releasedAt) * (1 - progress) + terminal * progress;
};
export const envelopeValue = (
  envelope: Envelope,
  seconds: number,
  beats = seconds,
  expression = 1,
  releasedAt?: number,
  midiKey = 60,
): number => {
  const a = finite(envelope.a, 1);
  const b = finite(envelope.b);
  const elapsed = Math.max(0, envelope.timeBasis === "beats" ? beats : seconds);
  if (elapsed === 0) {
    return a;
  }
  if (envelope.type === "Note Size") {
    return finite(a + (b - a) * clamp(expression, 0, 1), a);
  }
  const speed = Math.max(0, envelope.speed);
  if (speed === 0) {
    return a;
  }
  const periodic =
    envelope.type === "Sine" || envelope.type === "Triangle" || envelope.type === "Square";
  if (speed === Infinity) {
    if (envelope.type === "None") {
      return a;
    }
    return periodic ? (a + b) / 2 : b;
  }
  const t = elapsed * speed;
  const phase = periodic ? (((t + (envelope.phase || 0) / 360) % 1) + 1) % 1 : 0;
  const curve = Math.max(0.01, envelopeNumber(envelope, "curve", 1));
  let position = 0;
  switch (envelope.type) {
    case "None": {
      break;
    }
    case "Punch": {
      position = 1 - Math.exp(-t * 15);
      break;
    }
    case "Twang": {
      position = 1 - 1 / (1 + t * 8 * curve);
      break;
    }
    case "Decay": {
      position = 1 - Math.exp(-t * 4 * curve);
      break;
    }
    case "Swell": {
      position = 1 - Math.exp(-(t ** (1 + curve)) * 3);
      break;
    }
    case "Flare": {
      const rise = clamp(curve / 5, 0.01, 0.99);
      position = t < rise ? t / rise : Math.exp((-(t - rise) * 4) / curve);
      break;
    }
    case "Sine": {
      position = (1 - Math.cos(phase * TAU)) / 2;
      break;
    }
    case "Triangle": {
      position = 1 - Math.abs(phase * 2 - 1);
      break;
    }
    case "Square": {
      position = phase < clamp(envelope.duty, 0.01, 0.99) ? 0 : 1;
      break;
    }
    case "Staged / SF2": {
      const releaseTime =
        releasedAt === undefined
          ? undefined
          : releasedAt * speed * (seconds > 0 ? elapsed / seconds : 1);
      position = stagedProgress(envelope, t, releaseTime, midiKey);
      break;
    }
    default: {
      break;
    }
  }
  return finite(a + (b - a) * clamp(position, 0, 1), a);
};
export type EffectiveGlobals = {
  tempo: number;
  volume: number;
  detune: number;
};
const initialGlobals = (song: Song): EffectiveGlobals => ({
  tempo: song.tempo,
  volume: song.volume,
  detune: song.detune,
});
const applyGlobalLane = (result: EffectiveGlobals, target: string, value: number): void => {
  switch (target) {
    case "tempo": {
      result.tempo = clamp(value, 1, 300);
      break;
    }
    case "volume": {
      result.volume = clamp(value, 0, 100);
      break;
    }
    case "detune": {
      result.detune = clamp(value, -250, 250);
      break;
    }
    default: {
      break;
    }
  }
};
export const evaluateAutomation = (
  song: Song,
  bar: number,
  beat: number,
  muted: ReadonlySet<string> = new Set(),
  channels: readonly Channel[] = song.channels,
): EffectiveGlobals => {
  const result = initialGlobals(song);
  for (const channel of channels) {
    if (
      channel.kind !== "automation" ||
      channel.target.kind !== "song" ||
      !channel.enabled ||
      muted.has(channel.id)
    ) {
      continue;
    }
    const pattern = channel.patterns[channel.cells[bar] ?? 0];
    for (const lane of pattern?.lanes ?? []) {
      if (lane.effectId !== undefined && lane.effectId !== "") {
        continue;
      }
      const value = evaluateLane(lane, beat);
      if (value === undefined) {
        continue;
      }
      applyGlobalLane(result, lane.target, value);
    }
  }
  return result;
};
type GlobalBarAutomation = {
  lanes: Array<{ target: string; read: ReturnType<typeof prepareLane> }>;
  nextBar: AutomationLane[];
};
class AutomationBlock {
  private readonly bars = new Map<number, GlobalBarAutomation>();
  private readonly readers = new Map<AutomationLane, ReturnType<typeof prepareLane>>();
  private readonly channels: readonly Channel[];
  private readonly globals: readonly Channel[];
  private readonly muted: ReadonlySet<string>;

  public constructor(
    channels: readonly Channel[],
    globals: readonly Channel[],
    muted: ReadonlySet<string>,
  ) {
    this.channels = channels;
    this.globals = globals;
    this.muted = muted;
  }

  public read(lane: AutomationLane, beat: number): number | undefined {
    let points = this.readers.get(lane);
    if (!points) {
      points = prepareLane(lane);
      this.readers.set(lane, points);
    }
    return points(beat);
  }

  public forBar(bar: number): GlobalBarAutomation {
    const existing = this.bars.get(bar);
    if (existing) {
      return existing;
    }
    const lanes: GlobalBarAutomation["lanes"] = [];
    for (const channel of this.globals) {
      if (channel.enabled && !this.muted.has(channel.id)) {
        for (const lane of channel.patterns[channel.cells[bar] ?? 0]?.lanes ?? []) {
          if (lane.enabled && (lane.effectId === undefined || lane.effectId === "")) {
            lanes.push({
              target: lane.target,
              read: prepareLane(lane),
            });
          }
        }
      }
    }
    const nextBar: AutomationLane[] = [];
    for (const channel of this.channels) {
      if (channel.enabled && !this.muted.has(channel.id)) {
        for (const lane of channel.patterns[channel.cells[bar] ?? 0]?.lanes ?? []) {
          if (lane.enabled && lane.target === "nextBar") {
            nextBar.push(lane);
          }
        }
      }
    }
    const prepared = { lanes, nextBar };
    this.bars.set(bar, prepared);
    return prepared;
  }
}

export type Stereo = [number, number];
type BiquadState = {
  output: Stereo;
  type: string;
  frequency: number;
  q: number;
  gain: number;
  sampleRate: number;
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
  history: [number, number, number, number, number, number, number, number];
};
type PitchShiftState = {
  voices: number;
  cents: number;
  interval: number;
  spread: number;
  settings: Array<{ ratio: number; offset: number; left: number; right: number }>;
};
type PhaserState = {
  output: Stereo;
  center: number;
  sampleRate: number;
  count: number;
  stages: Array<{
    b0: number;
    b1: number;
    b2: number;
    history: BiquadState["history"];
  }>;
};
type EffectState = {
  output: Stereo;
  left: Float32Array;
  right: Float32Array;
  index: number;
  lowL: number;
  lowR: number;
  level: number;
  holdL: number;
  holdR: number;
  counter: number;
  lastInputTime: number;
  filters: Map<string, BiquadState>;
  mainFilter?: BiquadState;
  eqFilters?: BiquadState[];
  slopeFilters?: BiquadState[];
  pitchShift?: PitchShiftState;
  frequencyShifter?: { sampleRate: number; delays: Float64Array; wholeTaps: boolean };
  phaser?: PhaserState;
  chorus?: Chorus;
  gain?: { decibels: number; linear: number; normalization: number };
  phaserControls?: {
    depth: number;
    rate: number;
    phase: number;
    frequency: number;
    stages: number;
    feedback: number;
    sampleRate: number;
    normalizedDepth: number;
    normalizedRate: number;
    phaseRadians: number;
    cutoff: number;
    count: number;
    feedbackGain: number;
  };
  processor?: { type: string; render: EffectProcessor | undefined };
  quantization?: { bits: number; steps: number };
  delay?: {
    reverb: boolean;
    time: number;
    feedback: number;
    damping: number;
    sampleRate: number;
    samples: number;
    coefficient: number;
    feedbackGain: number;
    second: number;
    third: number;
  };
};
const db = (value: number): number => 10 ** (clamp(value, -100, 60) / 20);
const effectGain = (state: EffectState, decibels: number): NonNullable<EffectState["gain"]> => {
  if (state.gain?.decibels !== decibels) {
    const linear = db(decibels);
    state.gain = { decibels, linear, normalization: Math.max(1, Math.sqrt(linear)) };
  }
  return state.gain;
};
const effectParameterKeys = new Map(
  Object.entries(EFFECT_PARAMETERS).map(([type, parameters]) => [
    type,
    new Set(parameters.map((parameter) => parameter.key)),
  ]),
);
effectParameterKeys.set(
  "EQ",
  new Set([
    "bandCount",
    "frequency",
    "gain",
    ...Array.from({ length: 7 }, (_, index) => [
      `band${index + 1}Frequency`,
      `band${index + 1}Gain`,
    ]).flat(),
  ]),
);
const editableEffectParameter = (effect: Effect, key: string): boolean =>
  effectParameterKeys.get(effect.type)?.has(key) ?? false;
const numberParameter = (effect: Effect, key: string, fallback: number): number =>
  editableEffectParameter(effect, key) && typeof effect.parameters[key] === "number"
    ? effect.parameters[key]
    : fallback;
const resources = new Map<string, AudioResource>();
const soundFonts = new Map<string, SoundFont>();
// Each playback worker receives decoded resources once, then only replacements.
// Samples stay available on the UI thread for previews, metadata and offline export.
export type AudioResourceUpdate =
  | { type: "remove"; id: string }
  | { type: "sample"; id: string; resource: AudioResource }
  | { type: "soundfont"; id: string; font: SoundFont };
const resourceListeners = new Set<(update: AudioResourceUpdate) => void>();
const notifyAudioResource = (update: AudioResourceUpdate): void => {
  for (const listener of resourceListeners) {
    listener(update);
  }
};
export const applyAudioResourceUpdate = (update: AudioResourceUpdate): void => {
  switch (update.type) {
    case "sample": {
      resources.set(update.id, update.resource);
      soundFonts.delete(update.id);
      break;
    }
    case "soundfont": {
      soundFonts.set(update.id, update.font);
      resources.delete(update.id);
      break;
    }
    case "remove": {
      resources.delete(update.id);
      soundFonts.delete(update.id);
      break;
    }
  }
};
// Export captures decoded resources once, before workers start.
export const snapshotAudioResources = (ids: ReadonlySet<string>): AudioResourceUpdate[] => [
  ...[...resources].flatMap(([id, resource]): AudioResourceUpdate[] =>
    ids.has(id) ? [{ type: "sample", id, resource }] : [],
  ),
  ...[...soundFonts].flatMap(([id, font]): AudioResourceUpdate[] =>
    ids.has(id) ? [{ type: "soundfont", id, font }] : [],
  ),
];
const states = new WeakMap<Effect, EffectState>();
const effectState = (effect: Effect, sampleRate: number): EffectState => {
  let state = states.get(effect);
  if (!state) {
    const delayed = ![
      "Chorus",
      "Muffle",
      "Low Pass",
      "High Pass",
      "Band Pass",
      "Notch",
      "EQ",
      "Wah",
      "Auto Wah",
      "Filter Sweep",
      "Resonator",
      "Formant Filter",
      "De-Esser",
      "Phaser",
      "Compressor",
      "Limiter",
      "Expander",
      "Noise Gate",
      "Transient Shaper",
      "Overdrive",
      "Fuzz",
      "Soft Clipping",
      "Hard Clipping",
      "Wavefolding",
      "Rectification",
      "Bitcrusher",
      "Sample Rate Reduction",
      "Aliasing",
      "Tremolo",
      "Ring Modulation",
      "Pan",
      "Auto Pan",
      "3D Panning",
      "Stereo Width",
      "Mid/Side Processing",
      "Stereo Rotation",
      "Vinyl Simulation",
    ].includes(effect.type);
    let duration = 4.1;
    if (TEMPO_DELAY_EFFECTS.has(effect.type)) {
      duration = effect.type === "Multitap Delay" ? 64.1 : 8.1;
    }
    const length = delayed ? Math.ceil(sampleRate * duration) : 1;
    state = {
      output: [0, 0],
      left: new Float32Array(length),
      right: new Float32Array(length),
      index: 0,
      lowL: 0,
      lowR: 0,
      level: 0,
      holdL: 0,
      holdR: 0,
      counter: 0,
      lastInputTime: -Infinity,
      filters: new Map(),
    };
    states.set(effect, state);
  }
  return state;
};
const writeEffectOutput = (state: { output: Stereo }, left: number, right: number): Stereo => {
  state.output[0] = left;
  state.output[1] = right;
  return state.output;
};
const prepareBiquad = (state: EffectState, key: string): BiquadState => {
  let filter = state.filters.get(key);
  if (!filter) {
    filter = {
      output: [0, 0],
      type: "",
      frequency: Number.NaN,
      q: Number.NaN,
      gain: Number.NaN,
      sampleRate: Number.NaN,
      b0: 0,
      b1: 0,
      b2: 0,
      a0: 1,
      a1: 0,
      a2: 0,
      history: [0, 0, 0, 0, 0, 0, 0, 0],
    };
    state.filters.set(key, filter);
  }
  return filter;
};
const biquadSample = (
  input: Stereo,
  type: string,
  frequency: number,
  q: number,
  gain: number,
  sampleRate: number,
  filter: BiquadState,
): Stereo => {
  if (
    filter.type !== type ||
    filter.frequency !== frequency ||
    filter.q !== q ||
    filter.gain !== gain ||
    filter.sampleRate !== sampleRate
  ) {
    const omega = (TAU * clamp(frequency, 10, sampleRate * 0.48)) / sampleRate;
    const cos = Math.cos(omega);
    const sin = Math.sin(omega);
    const alpha = sin / (2 * clamp(q, 0.1, 40));
    let b0 = (1 - cos) / 2;
    let b1 = 1 - cos;
    let b2 = b0;
    let a0 = 1 + alpha;
    let a1 = -2 * cos;
    let a2 = 1 - alpha;
    if (type === "highpass") {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
    } else if (type === "bandpass") {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    } else if (type === "notch") {
      b0 = 1;
      b1 = -2 * cos;
      b2 = 1;
    } else if (type === "allpass") {
      b0 = 1 - alpha;
      b1 = -2 * cos;
      b2 = 1 + alpha;
    } else if (type === "peaking") {
      const a = 10 ** (gain / 40);
      b0 = 1 + alpha * a;
      b1 = -2 * cos;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cos;
      a2 = 1 - alpha / a;
    }
    filter.type = type;
    filter.frequency = frequency;
    filter.q = q;
    filter.gain = gain;
    filter.sampleRate = sampleRate;
    filter.b0 = b0;
    filter.b1 = b1;
    filter.b2 = b2;
    filter.a0 = a0;
    filter.a1 = a1;
    filter.a2 = a2;
  }
  const { b0, b1, b2, a0, a1, a2, history } = filter;
  const [inputL, inputR] = input;
  const [x1L, x2L, y1L, y2L, x1R, x2R, y1R, y2R] = history;
  const left = finite((b0 * inputL + b1 * x1L + b2 * x2L - a1 * y1L - a2 * y2L) / a0);
  const right = finite((b0 * inputR + b1 * x1R + b2 * x2R - a1 * y1R - a2 * y2R) / a0);
  history[1] = x1L;
  history[0] = inputL;
  history[3] = y1L;
  history[2] = left;
  history[5] = x1R;
  history[4] = inputR;
  history[7] = y1R;
  history[6] = right;
  return writeEffectOutput(filter, left, right);
};
const biquadStereo = (
  input: Stereo,
  type: string,
  frequency: number,
  q: number,
  gain: number,
  sampleRate: number,
  state: EffectState,
  key: string,
): Stereo => biquadSample(input, type, frequency, q, gain, sampleRate, prepareBiquad(state, key));
const mainBiquad = (state: EffectState): BiquadState => {
  state.mainFilter ??= prepareBiquad(state, "main");
  return state.mainFilter;
};
const phaserStereo = (
  left: number,
  right: number,
  state: EffectState,
  center: number,
  count: number,
  sampleRate: number,
): Stereo => {
  let { phaser } = state;
  if (!phaser) {
    phaser = {
      output: [0, 0],
      center: Number.NaN,
      sampleRate: Number.NaN,
      count: 0,
      stages: [],
    };
    state.phaser = phaser;
  }
  const changed =
    phaser.center !== center || phaser.sampleRate !== sampleRate || phaser.count !== count;
  phaser.center = center;
  phaser.sampleRate = sampleRate;
  phaser.count = count;
  // An all-pass biquad has a0=b2, a1=b1 and a2=b0. Keep the same
  // arithmetic order as the generic filter while sharing one stereo accumulator.
  // Inactive stages retain their histories when the stage count changes.
  let outputL = left;
  let outputR = right;
  for (let index = 0; index < count; index++) {
    let stage = phaser.stages[index];
    if (!stage) {
      stage = { b0: 0, b1: 0, b2: 0, history: [0, 0, 0, 0, 0, 0, 0, 0] };
      phaser.stages[index] = stage;
    }
    if (changed) {
      const omega = (TAU * clamp(center * (1 + index * 0.1), 10, sampleRate * 0.48)) / sampleRate;
      const alpha = Math.sin(omega) / (2 * 0.7);
      stage.b0 = 1 - alpha;
      stage.b1 = -2 * Math.cos(omega);
      stage.b2 = 1 + alpha;
    }
    const { b0, b1, b2, history } = stage;
    const [x1L, x2L, y1L, y2L, x1R, x2R, y1R, y2R] = history;
    const nextL = finite((b0 * outputL + b1 * x1L + b2 * x2L - b1 * y1L - b0 * y2L) / b2);
    const nextR = finite((b0 * outputR + b1 * x1R + b2 * x2R - b1 * y1R - b0 * y2R) / b2);
    history[1] = x1L;
    history[0] = outputL;
    history[3] = y1L;
    history[2] = nextL;
    history[5] = x1R;
    history[4] = outputR;
    history[7] = y1R;
    history[6] = nextR;
    outputL = nextL;
    outputR = nextR;
  }
  return writeEffectOutput(phaser, outputL, outputR);
};
export const resetEffects = (effects: readonly Effect[]): void => {
  for (const effect of effects) {
    states.delete(effect);
  }
};
// Hot effects use small processors so the audio loop does not repeatedly resolve
// unrelated controls or allocate a temporary wet pair. Read primitive values each
// sample so direct edits, replacement parameter objects and automation stay live.
type EffectProcessor = (
  input: Stereo,
  effect: Effect,
  sampleRate: number,
  seconds: number,
  overrides: Record<string, number> | undefined,
  state: EffectState,
  tempo: number,
) => Stereo;
const effectNumber = (
  effect: Effect,
  overrides: Record<string, number> | undefined,
  key: string,
  fallback: number,
): number =>
  overrides?.[key] ??
  (typeof effect.parameters[key] === "number" ? effect.parameters[key] : fallback);
const processEQ: EffectProcessor = (input, effect, sampleRate, _seconds, overrides, state) => {
  const count = Math.round(clamp(effectNumber(effect, overrides, "bandCount", 1), 0, 8));
  state.eqFilters ??= [mainBiquad(state)];
  let output = input;
  for (let index = 0; index < count; index++) {
    let filter = state.eqFilters[index];
    if (!filter) {
      filter = prepareBiquad(state, `band${index}`);
      state.eqFilters[index] = filter;
    }
    output = biquadSample(
      output,
      String(effect.parameters[index === 0 ? "filterType" : `band${index}Type`] ?? "peaking"),
      effectNumber(effect, overrides, index === 0 ? "frequency" : `band${index}Frequency`, 1200),
      Math.SQRT1_2,
      effectNumber(effect, overrides, index === 0 ? "gain" : `band${index}Gain`, 0),
      sampleRate,
      filter,
    );
  }
  return writeEffectOutput(state, finite(output[0]), finite(output[1]));
};
const passFilter =
  (kind: string, resonant: boolean): EffectProcessor =>
  (input, effect, sampleRate, _seconds, overrides, state) => {
    const frequency = clamp(
      effectNumber(effect, overrides, "frequency", 1200),
      20,
      sampleRate * 0.45,
    );
    const q = resonant
      ? clamp(effectNumber(effect, overrides, "resonance", Math.SQRT1_2), 0.1, 40)
      : Math.SQRT1_2;
    let output = biquadSample(input, kind, frequency, q, 0, sampleRate, mainBiquad(state));
    if (resonant) {
      const slope = Math.round(clamp(effectNumber(effect, overrides, "slope", 12) / 12, 1, 4));
      if (slope > 1 && !state.slopeFilters) {
        state.slopeFilters = [];
      }
      for (let stage = 1; stage < slope; stage++) {
        const filters = required(state.slopeFilters);
        let filter = filters[stage];
        if (!filter) {
          filter = prepareBiquad(state, `slope${stage}`);
          filters[stage] = filter;
        }
        output = biquadSample(output, kind, frequency, q, 0, sampleRate, filter);
      }
    }
    return output;
  };
const processGain: EffectProcessor = (input, effect, _rate, _seconds, overrides, state) => {
  const gain = effectGain(state, effectNumber(effect, overrides, "gain", 0)).linear;
  return writeEffectOutput(state, finite(input[0] * gain), finite(input[1] * gain));
};
const processSoftShaping: EffectProcessor = (input, effect, _rate, _seconds, overrides, state) => {
  const { linear, normalization } = effectGain(state, effectNumber(effect, overrides, "drive", 6));
  return writeEffectOutput(
    state,
    finite(Math.tanh(input[0] * linear + 0) / normalization),
    finite(Math.tanh(input[1] * linear + 0) / normalization),
  );
};
const processWavefolding: EffectProcessor = (input, effect, _rate, _seconds, overrides, state) => {
  const drive = effectGain(state, effectNumber(effect, overrides, "drive", 6)).linear;
  const bias = effectNumber(effect, overrides, "bias", 0);
  const folds = Math.max(1, effectNumber(effect, overrides, "folds", 2));
  return writeEffectOutput(
    state,
    finite(Math.sin((input[0] * drive + bias) * folds)),
    finite(Math.sin((input[1] * drive + bias) * folds)),
  );
};
const processRectification: EffectProcessor = (
  input,
  effect,
  _rate,
  _seconds,
  _overrides,
  state,
) => {
  const drive = effectGain(state, 6).linear;
  return effect.parameters["mode"] === "Half"
    ? writeEffectOutput(
        state,
        finite(Math.max(0, input[0] * drive)),
        finite(Math.max(0, input[1] * drive)),
      )
    : writeEffectOutput(
        state,
        finite(Math.abs(input[0] * drive)),
        finite(Math.abs(input[1] * drive)),
      );
};
const processBitcrusher: EffectProcessor = (input, effect, _rate, _seconds, overrides, state) => {
  const bits = effectNumber(effect, overrides, "bits", 8);
  if (state.quantization?.bits !== bits) {
    state.quantization = { bits, steps: 2 ** clamp(bits, 1, 24) };
  }
  const { steps } = state.quantization;
  return writeEffectOutput(
    state,
    finite(Math.round(input[0] * steps) / steps),
    finite(Math.round(input[1] * steps) / steps),
  );
};
const processRateReduction: EffectProcessor = (
  input,
  effect,
  sampleRate,
  _seconds,
  overrides,
  state,
) => {
  state.counter++;
  if (
    state.counter >=
    sampleRate / clamp(effectNumber(effect, overrides, "sampleRate", 8000), 100, sampleRate)
  ) {
    state.counter = 0;
    [state.holdL, state.holdR] = input;
  }
  return writeEffectOutput(state, finite(state.holdL), finite(state.holdR));
};
const processStereoWidth: EffectProcessor = (input, effect, _rate, _seconds, overrides, state) => {
  const mid = (input[0] + input[1]) / 2;
  const side = (((input[0] - input[1]) / 2) * effectNumber(effect, overrides, "width", 100)) / 100;
  return writeEffectOutput(state, finite(mid + side), finite(mid - side));
};
const processPhaser: EffectProcessor = (input, effect, sampleRate, seconds, overrides, state) => {
  const depth = effectNumber(effect, overrides, "depth", 50);
  const rate = effectNumber(effect, overrides, "rate", 2);
  const phaseDegrees = effectNumber(effect, overrides, "phase", 0);
  const frequency = effectNumber(effect, overrides, "frequency", 1200);
  const stages = effectNumber(effect, overrides, "stages", 4);
  const feedback = effectNumber(effect, overrides, "feedback", 30);
  let controls = state.phaserControls;
  if (
    controls?.depth !== depth ||
    controls.rate !== rate ||
    controls.phase !== phaseDegrees ||
    controls.frequency !== frequency ||
    controls.stages !== stages ||
    controls.feedback !== feedback ||
    controls.sampleRate !== sampleRate
  ) {
    controls = {
      depth,
      rate,
      phase: phaseDegrees,
      frequency,
      stages,
      feedback,
      sampleRate,
      normalizedDepth: clamp(depth / 100, 0, 1),
      normalizedRate: clamp(rate, 0.001, 100),
      phaseRadians: (phaseDegrees * Math.PI) / 180,
      cutoff: clamp(frequency, 20, sampleRate * 0.45),
      count: Math.round(clamp(stages, 2, 12)),
      feedbackGain: clamp(feedback / 100, 0, 0.95),
    };
    state.phaserControls = controls;
  }
  const phase =
    overrides?.["phaseRadians"] ?? seconds * controls.normalizedRate * TAU + controls.phaseRadians;
  const center = clamp(
    controls.cutoff * 2 ** (Math.sin(phase) * controls.normalizedDepth * 3),
    20,
    sampleRate * 0.4,
  );
  const pair = phaserStereo(
    input[0] + state.lowL * controls.feedbackGain,
    input[1] + state.lowR * controls.feedbackGain,
    state,
    center,
    controls.count,
    sampleRate,
  );
  [state.lowL, state.lowR] = pair;
  return writeEffectOutput(state, finite(input[0] + pair[0]), finite(input[1] + pair[1]));
};
const delayReadIndex = (index: number, distance: number, length: number): number => {
  const position = index - distance + length;
  // Normal delay taps are shorter than the ring. A type edit can retain a
  // shorter buffer, so preserve the original remainder for negative positions.
  if (position < 0) {
    return position % length;
  }
  return position >= length ? position - length : position;
};
const delaySeconds = (
  effect: Effect,
  overrides: Record<string, number> | undefined,
  tempo: number,
): number => {
  const time = effectNumber(effect, overrides, "time", 0.25);
  return TEMPO_DELAY_EFFECTS.has(effect.type) && effect.parameters["timeBasis"] === "Beats"
    ? (time * 60) / clamp(tempo, 1, 300)
    : time;
};
const simpleDelay =
  (reverb: boolean, pingPong = false): EffectProcessor =>
  (input, effect, sampleRate, _seconds, overrides, state, tempo) => {
    // Comb filters have fixed damping, matching the fallback.
    const time = reverb ? 0.037 : delaySeconds(effect, overrides, tempo);
    const feedback = reverb
      ? effectNumber(effect, overrides, "decay", 2)
      : effectNumber(effect, overrides, "feedback", 30);
    const damping =
      effect.type === "Comb Filter" ? 5000 : effectNumber(effect, overrides, "damping", 5000);
    let { delay } = state;
    if (
      delay?.reverb !== reverb ||
      delay.time !== time ||
      delay.feedback !== feedback ||
      delay.damping !== damping ||
      delay.sampleRate !== sampleRate
    ) {
      delay = {
        reverb,
        time,
        feedback,
        damping,
        sampleRate,
        samples: Math.floor(
          clamp(time, 1 / sampleRate, TEMPO_DELAY_EFFECTS.has(effect.type) ? 8 : 4) * sampleRate,
        ),
        coefficient: 1 - Math.exp((-TAU * clamp(damping, 20, sampleRate * 0.45)) / sampleRate),
        feedbackGain: reverb
          ? clamp(0.7 + feedback / 100, 0, 0.97)
          : clamp(feedback / 100, 0, 0.95),
        second: Math.floor(sampleRate * 0.053),
        third: Math.floor(sampleRate * 0.079),
      };
      state.delay = delay;
    }
    const position = delayReadIndex(state.index, delay.samples, state.left.length);
    let left = state.left[position] ?? 0;
    let right = state.right[position] ?? 0;
    if (pingPong) {
      [left, right] = [right, left];
    }
    if (reverb) {
      const second = delayReadIndex(state.index, delay.second, state.left.length);
      const third = delayReadIndex(state.index, delay.third, state.left.length);
      left = (left + (state.right[second] ?? 0) + (state.left[third] ?? 0)) / 3;
      right = (right + (state.left[second] ?? 0) + (state.right[third] ?? 0)) / 3;
    }
    const fb = delay.feedbackGain;
    state.lowL += (left - state.lowL) * delay.coefficient;
    state.lowR += (right - state.lowR) * delay.coefficient;
    state.left[state.index] = clamp(input[0] + state.lowL * fb, -8, 8);
    state.right[state.index] = clamp(input[1] + state.lowR * fb, -8, 8);
    state.index = state.index + 1 === state.left.length ? 0 : state.index + 1;
    return writeEffectOutput(state, finite(input[0] + left), finite(input[1] + right));
  };
const readDelaySample = (
  state: EffectState,
  buffer: Float32Array,
  delay: number,
  sampleRate: number,
): number => {
  let position = state.index - clamp(delay * sampleRate, 0, buffer.length - 2) + buffer.length;
  if (position >= buffer.length) {
    position -= buffer.length;
  }
  const index = Math.floor(position);
  const fraction = position - index;
  const next = index + 1 === buffer.length ? 0 : index + 1;
  return (buffer[index] ?? 0) * (1 - fraction) + (buffer[next] ?? 0) * fraction;
};
const modulatedDelay = (type: string): EffectProcessor => {
  const flanger = type === "Flanger";
  const vibrato = type === "Vibrato";
  const rotary = type === "Rotary Speaker";
  return (input, effect, sampleRate, seconds, overrides, state) => {
    const [left, right] = input;
    state.left[state.index] = left;
    state.right[state.index] = right;
    const depth = vibrato ? 0.5 : clamp(effectNumber(effect, overrides, "depth", 50) / 100, 0, 1);
    const rate = clamp(effectNumber(effect, overrides, "rate", 2), 0.001, 100);
    const phase =
      overrides?.["phaseRadians"] ??
      seconds * rate * TAU + (effectNumber(effect, overrides, "phase", 0) * Math.PI) / 180;
    const onset = seconds >= (vibrato ? effectNumber(effect, overrides, "delay", 0) : 0);
    const spread = rotary ? clamp(effectNumber(effect, overrides, "spread", 70) / 100, 0, 1) : 0.7;
    const base = flanger
      ? clamp(effectNumber(effect, overrides, "time", 0.003), 0.0001, 0.02)
      : 0.015;
    const variation = vibrato
      ? Math.min(
          0.01,
          (2 ** (effectNumber(effect, overrides, "cents", 20) / 1200) - 1) /
            Math.max(0.1, rate) /
            TAU,
        )
      : 0.006 * depth;
    const modulation = onset ? Math.sin(phase) : 0;
    let wetL = readDelaySample(
      state,
      state.left,
      Math.max(0.00001, base + modulation * variation),
      sampleRate,
    );
    let wetR = readDelaySample(
      state,
      state.right,
      Math.max(0.00001, base + Math.sin(phase + spread * Math.PI) * variation),
      sampleRate,
    );
    if (rotary) {
      wetL *= 0.65 + 0.35 * Math.sin(phase);
      wetR *= 0.65 - 0.35 * Math.sin(phase);
    }
    if (flanger) {
      const feedback = clamp(effectNumber(effect, overrides, "feedback", 30) / 100, 0, 0.95);
      state.left[state.index] = clamp(left + wetL * feedback, -8, 8);
      state.right[state.index] = clamp(right + wetR * feedback, -8, 8);
    }
    state.index = state.index + 1 === state.left.length ? 0 : state.index + 1;
    return flanger
      ? writeEffectOutput(state, finite(left + wetL), finite(right + wetR))
      : writeEffectOutput(state, finite(wetL), finite(wetR));
  };
};
const processChorus: EffectProcessor = (input, effect, sampleRate, _seconds, overrides, state) => {
  if (state.chorus?.sampleRate !== sampleRate) {
    state.chorus = new Chorus(sampleRate);
  }
  const amount = clamp(effectNumber(effect, overrides, "amount", 100), 0, 100);
  return state.chorus.process(input[0], input[1], amount);
};
const pitchDelay = (type: string): EffectProcessor => {
  const layered = type === "Unison" || type === "Vocal Doubling";
  const unison = type === "Unison";
  const shift = type === "Pitch Shift";
  return (input, effect, sampleRate, seconds, overrides, state) => {
    const [left, right] = input;
    state.left[state.index] = left;
    state.right[state.index] = right;
    const voices = layered
      ? Math.round(clamp(effectNumber(effect, overrides, "voices", 2), 1, 8))
      : 1;
    const spread = unison ? clamp(effectNumber(effect, overrides, "spread", 70) / 100, 0, 1) : 0.7;
    const cents = shift ? 0 : effectNumber(effect, overrides, "cents", 10);
    const interval = shift || unison ? effectNumber(effect, overrides, "interval", 0) : 0;
    let prepared = state.pitchShift;
    if (
      prepared?.voices !== voices ||
      prepared.cents !== cents ||
      prepared.interval !== interval ||
      prepared.spread !== spread
    ) {
      prepared = {
        voices,
        cents,
        interval,
        spread,
        settings: Array.from({ length: voices }, (_, voice) => {
          const detune = cents * (voices === 1 ? 1 : (voice / (voices - 1) - 0.5) * 2);
          const pan = voices === 1 ? 0 : (voice / (voices - 1) - 0.5) * 2 * spread;
          return {
            ratio: 2 ** ((interval + detune / 100) / 12),
            offset: voice / voices,
            left: Math.cos((Math.max(0, pan) * Math.PI) / 2),
            right: Math.cos((Math.max(0, -pan) * Math.PI) / 2),
          };
        }),
      };
      state.pitchShift = prepared;
    }
    const window = 0.04;
    let wetL = 0;
    let wetR = 0;
    for (const setting of prepared.settings) {
      const { ratio, offset } = setting;
      const progress = ((((seconds * (1 - ratio)) / window + offset) % 1) + 1) % 1;
      const second = (progress + 0.5) % 1;
      const firstGain = (1 - Math.cos(progress * TAU)) / 2;
      const secondGain = 1 - firstGain;
      const shiftedL =
        readDelaySample(state, state.left, progress * window, sampleRate) * firstGain +
        readDelaySample(state, state.left, second * window, sampleRate) * secondGain;
      const shiftedR =
        readDelaySample(state, state.right, progress * window, sampleRate) * firstGain +
        readDelaySample(state, state.right, second * window, sampleRate) * secondGain;
      wetL += (shiftedL * setting.left) / voices;
      wetR += (shiftedR * setting.right) / voices;
    }
    state.index = state.index + 1 === state.left.length ? 0 : state.index + 1;
    return layered
      ? writeEffectOutput(state, finite(left + wetL), finite(right + wetR))
      : writeEffectOutput(state, finite(wetL), finite(wetR));
  };
};
const hilbertCenter = 32;
const hilbertLastDelay = hilbertCenter * 3 - 1;
const hilbertCoefficients = Float64Array.from({ length: hilbertCenter }, (_, index) => {
  const tap = index * 2 + 1;
  return (2 / (Math.PI * tap)) * (0.54 + 0.46 * Math.cos((Math.PI * tap) / 64));
});
// Retain the interpolation result for signed zero and non-finite input.
const wholeDelayFraction = 0;
const wholeDelaySample = (buffer: Float32Array, index: number): number =>
  (buffer[index] ?? 0) + (buffer[index + 1] ?? 0) * wholeDelayFraction;
const processFrequencyShifter: EffectProcessor = (
  input,
  effect,
  sampleRate,
  seconds,
  overrides,
  state,
) => {
  const { index, left, right, output } = state;
  const { length } = left;
  const [inputL, inputR] = input;
  left[index] = inputL;
  right[index] = inputR;
  if (state.frequencyShifter?.sampleRate !== sampleRate) {
    const delays = Float64Array.from({ length: hilbertLastDelay + 1 }, (_, frames) =>
      clamp((frames / sampleRate) * sampleRate, 0, length - 2),
    );
    state.frequencyShifter = {
      sampleRate,
      delays,
      // Adding a ring length of at least 512 rounds away these small errors
      // when the entire read window lies inside the ring.
      wholeTaps:
        length >= 512 && delays.every((delay, frames) => Math.abs(delay - frames) <= 2 ** -46),
    };
  }
  const { delays, wholeTaps } = state.frequencyShifter;
  let hilbertL = 0;
  let hilbertR = 0;
  if (wholeTaps && index >= hilbertLastDelay && index + 1 < length) {
    const currentL = wholeDelaySample(left, index);
    const currentR = wholeDelaySample(right, index);
    for (let tap = 0; tap < hilbertCoefficients.length; tap++) {
      const offset = tap * 2 + 1;
      const early = index - hilbertCenter + offset;
      const late = index - hilbertCenter - offset;
      const earlyL = offset < hilbertCenter ? wholeDelaySample(left, early) : currentL;
      const earlyR = offset < hilbertCenter ? wholeDelaySample(right, early) : currentR;
      const coefficient = hilbertCoefficients[tap] ?? 0;
      hilbertL += (earlyL - wholeDelaySample(left, late)) * coefficient;
      hilbertR += (earlyR - wholeDelaySample(right, late)) * coefficient;
    }
    output[0] = wholeDelaySample(left, index - hilbertCenter);
    output[1] = wholeDelaySample(right, index - hilbertCenter);
  } else {
    // Wrap at the ring boundary and preserve fractional/clamped positions
    // when a live type edit has retained a shorter delay line.
    const read = (frames: number): void => {
      const unwrapped = index - (delays[frames] ?? 0) + length;
      const position = unwrapped >= length ? unwrapped - length : unwrapped;
      const first = Math.floor(position);
      const next = first + 1 === length ? 0 : first + 1;
      const fraction = position - first;
      output[0] = (left[first] ?? 0) * (1 - fraction) + (left[next] ?? 0) * fraction;
      output[1] = (right[first] ?? 0) * (1 - fraction) + (right[next] ?? 0) * fraction;
    };
    read(0);
    const [currentL, currentR] = output;
    for (let tap = 0; tap < hilbertCoefficients.length; tap++) {
      const offset = tap * 2 + 1;
      let earlyL = currentL;
      let earlyR = currentR;
      if (offset < hilbertCenter) {
        read(hilbertCenter - offset);
        [earlyL, earlyR] = output;
      }
      read(hilbertCenter + offset);
      const coefficient = hilbertCoefficients[tap] ?? 0;
      hilbertL += (earlyL - output[0]) * coefficient;
      hilbertR += (earlyR - output[1]) * coefficient;
    }
    read(hilbertCenter);
  }
  const angle = seconds * effectNumber(effect, overrides, "shift", 20) * TAU;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  state.index = (index + 1) % length;
  return writeEffectOutput(
    state,
    finite(output[0] * cosine - hilbertL * sine),
    finite(output[1] * cosine - hilbertR * sine),
  );
};
const fastEffectProcessors = new Map<string, EffectProcessor>(
  Object.entries({
    EQ: processEQ,
    "Low Pass": passFilter("lowpass", true),
    "High Pass": passFilter("highpass", true),
    "Band Pass": passFilter("bandpass", false),
    Gain: processGain,
    Overdrive: processSoftShaping,
    "Soft Clipping": processSoftShaping,
    Wavefolding: processWavefolding,
    Rectification: processRectification,
    Bitcrusher: processBitcrusher,
    "Sample Rate Reduction": processRateReduction,
    "Stereo Width": processStereoWidth,
    Phaser: processPhaser,
    Chorus: processChorus,
    "Frequency Shifter": processFrequencyShifter,
    Flanger: modulatedDelay("Flanger"),
    Vibrato: modulatedDelay("Vibrato"),
    "Rotary Speaker": modulatedDelay("Rotary Speaker"),
    Detune: pitchDelay("Detune"),
    "Pitch Shift": pitchDelay("Pitch Shift"),
    Unison: pitchDelay("Unison"),
    "Vocal Doubling": pitchDelay("Vocal Doubling"),
    "Comb Filter": simpleDelay(false),
    Echo: simpleDelay(false),
    "Ping Pong Delay": simpleDelay(false, true),
    Reverb: simpleDelay(true),
  }),
);
// Enabled effect instances process stereo audio in visible order with independent state.
// Bypass passes audio unchanged; duplication copies settings and automation, not tail state.
// Time-based effects keep their own sample history without rescheduling notes.
export const processEffect = (
  input: Stereo,
  effect: Effect,
  sampleRate: number,
  seconds: number,
  overrides?: Record<string, number>,
  tempo = 150,
): Stereo => {
  if (!effect.enabled) {
    return input;
  }
  if (effect.type === "Monoize") {
    const mono = (input[0] + input[1]) / 2;
    return [mono, mono];
  }
  const state = effectState(effect, sampleRate);
  if (state.processor?.type !== effect.type) {
    state.processor = { type: effect.type, render: fastEffectProcessors.get(effect.type) };
  }
  if (state.processor.render) {
    const output = state.processor.render(
      input,
      effect,
      sampleRate,
      seconds,
      overrides,
      state,
      tempo,
    );
    return [output[0], output[1]];
  }
  const parameterKeys = effectParameterKeys.get(effect.type);
  const p = (key: string, fallback: number): number => {
    if (parameterKeys?.has(key) !== true) {
      return fallback;
    }
    return (
      overrides?.[key] ??
      (typeof effect.parameters[key] === "number" ? effect.parameters[key] : fallback)
    );
  };
  const [l, r] = input;
  const wet: Stereo = [0, 0];
  let direct = true;
  switch (effect.type) {
    case "Muffle":
    case "Notch":
    case "Wah":
    case "Auto Wah":
    case "Filter Sweep":
    case "Resonator":
    case "Formant Filter":
    case "De-Esser": {
      const depth = clamp(p("depth", 50) / 100, 0, 1);
      const cutoff = clamp(p("frequency", 1200), 20, sampleRate * 0.45);
      let frequency = cutoff;
      if (effect.type === "Auto Wah") {
        const detector = Math.max(Math.abs(l), Math.abs(r));
        state.level +=
          (detector - state.level) *
          (1 -
            Math.exp(
              -1 /
                (sampleRate *
                  Math.max(0.00001, p(detector > state.level ? "attack" : "release", 0.02))),
            ));
        frequency = clamp(
          cutoff * (0.1 + state.level * p("sensitivity", 50)),
          20,
          sampleRate * 0.45,
        );
      }
      if (effect.type === "Filter Sweep") {
        const duration = Math.max(0.001, p("time", 1));
        const progress = Math.min(1, seconds / duration);
        frequency = cutoff * (Math.max(20, p("endFrequency", 200)) / cutoff) ** progress;
      }
      const q = clamp(
        p("resonance", effect.type === "Wah" || effect.type === "Auto Wah" ? 4 : Math.SQRT1_2),
        0.1,
        40,
      );
      let kind = "lowpass";
      if (effect.type === "Notch") {
        kind = "notch";
      } else if (effect.type === "Wah" || effect.type === "Auto Wah") {
        kind = "bandpass";
      }
      if (effect.type === "Formant Filter") {
        const vowels = [
          [800, 1150, 2900],
          [400, 1700, 2600],
          [350, 2000, 2800],
          [450, 800, 2830],
          [325, 700, 2530],
        ];
        const vowel = clamp(p("vowel", 0) + p("morph", 0) / 100, 0, 4);
        const first = Math.floor(vowel);
        const next = Math.min(4, first + 1);
        const fraction = vowel - first;
        for (let band = 0; band < 3; band++) {
          const formantFrequency =
            (required(vowels[first])[band] ?? 800) * (1 - fraction) +
            (required(vowels[next])[band] ?? 800) * fraction;
          const pair = biquadStereo(
            [l, r],
            "bandpass",
            formantFrequency,
            clamp(p("width", 4), 0.5, 20),
            0,
            sampleRate,
            state,
            `formant${band}`,
          );
          wet[0] += pair[0];
          wet[1] += pair[1];
        }
      } else if (effect.type === "Resonator") {
        for (let band = 1; band <= 3; band++) {
          const pair = biquadStereo(
            [l, r],
            "bandpass",
            frequency * band,
            clamp(30 - p("damping", 40) * 0.25, 0.5, 30),
            0,
            sampleRate,
            state,
            `resonance${band}`,
          );
          wet[0] += pair[0];
          wet[1] += pair[1];
        }
      } else if (effect.type === "De-Esser") {
        const detected = biquadStereo(
          [l, r],
          "highpass",
          frequency,
          Math.SQRT1_2,
          0,
          sampleRate,
          state,
          "detect",
        );
        const reduction =
          Math.max(Math.abs(detected[0]), Math.abs(detected[1])) > db(p("threshold", -20))
            ? depth
            : 0;
        wet[0] = l - detected[0] * reduction;
        wet[1] = r - detected[1] * reduction;
      } else {
        [wet[0], wet[1]] = biquadStereo(input, kind, frequency, q, 0, sampleRate, state, "main");
      }
      if (effect.type === "Muffle") {
        wet[0] = l * (1 - depth) + wet[0] * depth;
        wet[1] = r * (1 - depth) + wet[1] * depth;
      }
      break;
    }
    case "Compressor":
    case "Limiter":
    case "Expander":
    case "Noise Gate":
    case "Transient Shaper": {
      const level = Math.max(Math.abs(l), Math.abs(r));
      const threshold = db(p("threshold", -12));
      const coefficient =
        1 -
        Math.exp(
          -1 /
            (sampleRate * Math.max(0.00001, p(level > state.level ? "attack" : "release", 0.02))),
        );
      state.level += (level - state.level) * coefficient;
      let gain = 1;
      if (effect.type === "Compressor" && state.level > threshold) {
        gain =
          ((threshold + (state.level - threshold) / Math.max(1, p("ratio", 4))) /
            Math.max(1e-9, state.level)) *
          db(p("makeup", 0));
      } else if (effect.type === "Limiter") {
        gain = Math.min(1, db(p("ceiling", -0.5)) / Math.max(1e-9, level * db(p("drive", 0))));
      } else if (effect.type === "Noise Gate") {
        gain = state.level < threshold ? 0 : 1;
      } else if (effect.type === "Expander" && state.level < threshold) {
        gain = (state.level / Math.max(1e-9, threshold)) ** Math.max(0, p("ratio", 2) - 1);
      } else if (effect.type === "Transient Shaper") {
        gain = Math.max(
          0,
          1 + (level > state.level ? p("attackAmount", 0) : p("sustainAmount", 0)) / 100,
        );
      }
      wet[0] = l * gain;
      wet[1] = r * gain;
      break;
    }
    case "Fuzz":
    case "Hard Clipping": {
      const { linear: drive } = effectGain(state, p("drive", 6));
      const bias = p("bias", 0);
      const drivenL = l * drive + bias;
      const drivenR = r * drive + bias;
      if (effect.type === "Hard Clipping") {
        const threshold = Math.max(0.001, db(p("threshold", -3)));
        wet[0] = clamp(drivenL, -threshold, threshold);
        wet[1] = clamp(drivenR, -threshold, threshold);
      } else {
        wet[0] = Math.sign(drivenL) * (1 - Math.exp(-Math.abs(drivenL) * 3));
        wet[1] = Math.sign(drivenR) * (1 - Math.exp(-Math.abs(drivenR) * 3));
      }
      break;
    }
    case "Aliasing": {
      state.counter++;
      if (state.counter >= sampleRate / Math.min(8000, sampleRate)) {
        state.counter = 0;
        state.holdL = l;
        state.holdR = r;
      }
      wet[0] = state.holdL;
      wet[1] = state.holdR;
      break;
    }
    case "Tremolo":
    case "Ring Modulation": {
      const depth = clamp(p("depth", 50) / 100, 0, 1);
      const rate = clamp(p("rate", 2), 0.001, 100);
      const phase =
        overrides?.["phaseRadians"] ?? seconds * rate * TAU + (p("phase", 0) * Math.PI) / 180;
      const cutoff = clamp(p("frequency", 1200), 20, sampleRate * 0.45);
      const carrier = Math.sin(effect.type === "Tremolo" ? phase : seconds * cutoff * TAU);
      const gain =
        effect.type === "Tremolo" ? 1 - (depth * (1 - carrier)) / 2 : 1 - depth + carrier * depth;
      wet[0] = l * gain;
      wet[1] = r * gain;
      break;
    }
    case "Pan":
    case "Auto Pan":
    case "3D Panning": {
      const position = ((): number => {
        if (effect.type === "Auto Pan") {
          const depth = clamp(p("depth", 50) / 100, 0, 1);
          const rate = clamp(p("rate", 2), 0.001, 100);
          const phase =
            overrides?.["phaseRadians"] ?? seconds * rate * TAU + (p("phase", 0) * Math.PI) / 180;
          return clamp(p("center", 0) / 100 + Math.sin(phase) * depth, -1, 1);
        }
        return effect.type === "3D Panning"
          ? Math.sin((p("azimuth", 0) * Math.PI) / 180)
          : clamp(p("position", 0) / 100, -1, 1);
      })();
      const { mode } = effect.parameters;
      let sourceL = l;
      let sourceR = r;
      if (mode === "Mono") {
        sourceL = (l + r) / 2;
        sourceR = sourceL;
      }
      if (mode === "Split Stereo") {
        const left = clamp(p("left", -100) / 100, -1, 1);
        const right = clamp(p("right", 100) / 100, -1, 1);
        wet[0] =
          l * Math.cos(((left + 1) * Math.PI) / 4) + r * Math.cos(((right + 1) * Math.PI) / 4);
        wet[1] =
          l * Math.sin(((left + 1) * Math.PI) / 4) + r * Math.sin(((right + 1) * Math.PI) / 4);
      } else {
        wet[0] = sourceL * Math.cos((Math.max(0, position) * Math.PI) / 2);
        wet[1] = sourceR * Math.cos((Math.max(0, -position) * Math.PI) / 2);
      }
      break;
    }
    case "Mid/Side Processing": {
      const mid = ((l + r) / 2) * db(p("midGain", 0));
      const side = (((l - r) / 2) * db(p("sideGain", 0)) * 100) / 100;
      wet[0] = mid + side;
      wet[1] = mid - side;
      break;
    }
    case "Stereo Rotation": {
      const depth = clamp(p("depth", 50) / 100, 0, 1);
      const angle = ((p("angle", 0) * Math.PI) / 180) * depth;
      wet[0] = l * Math.cos(angle) - r * Math.sin(angle);
      wet[1] = l * Math.sin(angle) + r * Math.cos(angle);
      break;
    }
    case "Vinyl Simulation": {
      const noise = p("noise", 5) / 1000;
      wet[0] = l + (Math.random() * 2 - 1) * noise;
      wet[1] = r + (Math.random() * 2 - 1) * noise;
      break;
    }
    default: {
      direct = false;
      const { type } = effect;
      const reverb = type.includes("Reverb");
      const delay = reverb
        ? 0.037
        : clamp(
            delaySeconds(effect, overrides, tempo),
            1 / sampleRate,
            TEMPO_DELAY_EFFECTS.has(type) ? 8 : 4,
          );
      const samples = Math.floor(delay * sampleRate);
      const position = (state.index - samples + state.left.length) % state.left.length;
      wet[0] = state.left[position] ?? 0;
      wet[1] = state.right[position] ?? 0;
      if (type === "Multitap Delay") {
        const taps = Math.round(clamp(p("taps", 3), 1, 8));
        for (let tap = 2; tap <= taps; tap++) {
          const tapPosition =
            (state.index - Math.floor(samples * tap) + state.left.length * 8) % state.left.length;
          wet[0] += (state.left[tapPosition] ?? 0) / tap;
          wet[1] += (state.right[tapPosition] ?? 0) / tap;
        }
      }
      if (reverb) {
        const second =
          (state.index - Math.floor(sampleRate * 0.053) + state.left.length) % state.left.length;
        const third =
          (state.index - Math.floor(sampleRate * 0.079) + state.left.length) % state.left.length;
        wet[0] = (wet[0] + (state.right[second] ?? 0) + (state.left[third] ?? 0)) / 3;
        wet[1] = (wet[1] + (state.left[second] ?? 0) + (state.right[third] ?? 0)) / 3;
        if (type === "Spring Reverb") {
          const tension = 1 + p("tension", 50) / 50;
          wet[0] = Math.sin(wet[0] * tension) / tension;
          wet[1] = Math.sin(wet[1] * tension) / tension;
        }
        if (type === "Gated Reverb") {
          if (Math.max(Math.abs(l), Math.abs(r)) > 0.0001) {
            state.lastInputTime = seconds;
          }
          if (seconds - state.lastInputTime > p("hold", 0.3)) {
            wet[0] = 0;
            wet[1] = 0;
          }
        }
      }
      const fb = reverb
        ? clamp(0.7 + p("decay", 2) / 100, 0, 0.97)
        : clamp(p("feedback", 30) / 100, 0, 0.95);
      const damp =
        1 - Math.exp((-TAU * clamp(p("damping", 5000), 20, sampleRate * 0.45)) / sampleRate);
      state.lowL += (wet[0] - state.lowL) * damp;
      state.lowR += (wet[1] - state.lowR) * damp;
      state.left[state.index] = clamp(l + state.lowL * fb, -8, 8);
      state.right[state.index] = clamp(r + state.lowR * fb, -8, 8);
      state.index = (state.index + 1) % state.left.length;
      break;
    }
  }
  if (direct) {
    return [finite(wet[0]), finite(wet[1])];
  }
  // Delays, reverbs and layering effects retain the original alongside their wet signal.
  return [finite(l + wet[0]), finite(r + wet[1])];
};
// A render chain owns this binding until it resets, bypasses or changes type.
// Parameters remain on the effect so edits and automation never need rebinding.
export const prepareEffectProcessor = (
  effect: Effect,
  sampleRate: number,
): ((
  input: Stereo,
  seconds: number,
  overrides?: Record<string, number>,
  tempo?: number,
) => Stereo) => {
  const render = fastEffectProcessors.get(effect.type);
  if (!render) {
    return (input, seconds, overrides, tempo = 150): Stereo =>
      processEffect(input, effect, sampleRate, seconds, overrides, tempo);
  }
  const state = effectState(effect, sampleRate);
  return (input, seconds, overrides, tempo = 150): Stereo =>
    render(input, effect, sampleRate, seconds, overrides, state, tempo);
};
type Voice = {
  live: boolean;
  activeFrame: number;
  midiKey: number;
  pitch: number;
  tuning: number;
  frequency: number;
  beatAge: number;
  evaluateParameter: ((target: string, base: number) => number) | null;
  sharedTime: number;
  sharedElapsedBeat: number;
  tempo: number;
  expression: number;
  sharedBeat: number;
  phase: number;
  sfReverbL: number;
  sfReverbR: number;
  sfChorusL: number;
  sfChorusR: number;
  fmState: FMVoiceState;
  sourceOutput: Stereo;
  parameterInstrument: Instrument | null;
  parameterEnvelopes: Map<string, Envelope[]>;
  age: number;
  noteId: string;
  samplePosition: number;
  released: number | undefined;
  soundFont: SFVoiceState | undefined;
};
type EnvelopeVoice = Pick<
  Voice,
  | "age"
  | "beatAge"
  | "expression"
  | "midiKey"
  | "released"
  | "sharedBeat"
  | "sharedElapsedBeat"
  | "sharedTime"
  | "tempo"
>;
type EffectNote = {
  voice: EnvelopeVoice;
  note: Note | undefined;
  visit: number;
  frame: number;
  beatOffset: number;
  livePitches: readonly number[];
  liveNoteIds: readonly number[];
};
type VoiceSlot = { id: string; voice: Voice | undefined };
type SoundFontSend = {
  input: Stereo;
  effect: RuntimeEffect;
};
type RuntimeEffect = Effect & {
  render?: ReturnType<typeof prepareEffectProcessor> | undefined;
};
type EffectEnvelopeBinding = { envelope: Envelope; parameter: string };
type RenderEffect = {
  source: Effect;
  id: string;
  runtime: RuntimeEffect;
  bindings: readonly EffectEnvelopeBinding[];
  skipped: boolean;
  syncRate: number | undefined;
  syncPhase: number;
};
type RenderEffectChain = {
  instrument: Instrument | undefined;
  envelopes: Envelope[] | undefined;
  steps: RenderEffect[];
  block: number;
};
const makeVoice = (id: string, live: boolean): Voice => {
  return {
    live,
    activeFrame: -1,
    midiKey: 60,
    pitch: 0,
    tuning: Number.NaN,
    frequency: 0,
    beatAge: 0,
    evaluateParameter: null,
    sharedTime: 0,
    sharedElapsedBeat: 0,
    tempo: 150,
    expression: 1,
    sharedBeat: 0,
    phase: 0,
    sfReverbL: 0,
    sfReverbR: 0,
    sfChorusL: 0,
    sfChorusR: 0,
    fmState: createFMVoice(),
    sourceOutput: [0, 0],
    parameterInstrument: null,
    parameterEnvelopes: new Map(),
    age: 0,
    noteId: id,
    samplePosition: 0,
    released: undefined,
    soundFont: undefined,
  };
};
const voiceEnvelopeValue = (
  envelope: Envelope,
  voice: EnvelopeVoice,
  beatAge: number,
  expression: number,
): number => {
  let seconds = voice.age;
  let beats = beatAge;
  if (envelope.type === "Sine" || envelope.type === "Triangle" || envelope.type === "Square") {
    if (envelope.clock === "song synchronized") {
      beats = voice.sharedBeat;
      seconds = (beats * 60) / voice.tempo;
    } else {
      seconds = voice.sharedTime;
      beats = voice.sharedElapsedBeat;
    }
  }
  return envelopeValue(envelope, seconds, beats, expression, voice.released, voice.midiKey);
};
const prepareVoiceParameters = (instrument: Instrument, voice: Voice): void => {
  if (voice.parameterInstrument === instrument) {
    return;
  }
  voice.parameterInstrument = instrument;
  voice.evaluateParameter = null;
  // Replacing this map invalidates the FM control cache when the patch changes.
  voice.parameterEnvelopes = Map.groupBy(instrument.envelopes, (envelope) => envelope.target);
};
const voiceParameter = (
  target: string,
  base: number,
  voice: Voice,
  beatAge: number,
  expression: number,
): number => {
  const envelopes = voice.parameterEnvelopes.get(target);
  if (!envelopes) {
    return finite(base, base);
  }
  let value = base;
  for (const envelope of envelopes) {
    if (envelope.enabled) {
      value *= voiceEnvelopeValue(envelope, voice, beatAge, expression);
    }
  }
  return finite(value, base);
};
type AudioResource = {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
};

export const hasAudioResource = (id: string): boolean => resources.has(id) || soundFonts.has(id);
export const registerAudioResource = (
  id: string,
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): void => {
  if (left.length === 0 || right.length !== left.length || sampleRate <= 0) {
    throw new Error("Invalid audio sample.");
  }
  const sharedLeft = shareSamples(left);
  const resource = {
    left: sharedLeft,
    right: right === left ? sharedLeft : shareSamples(right),
    sampleRate,
  };
  applyAudioResourceUpdate({ type: "sample", id, resource });
  notifyAudioResource({ type: "sample", id, resource });
};
export const loadAudioResource = async (
  id: string,
  data: ArrayBuffer,
  signal?: AbortSignal,
): Promise<number> => {
  signal?.throwIfAborted();
  // Saved sample and loop positions count frames, so decoding must not depend
  // on the playback device's sample rate.
  const context = new OfflineAudioContext(2, 1, 44_100);
  const buffer = await context.decodeAudioData(data.slice(0));
  signal?.throwIfAborted();
  const left = buffer.getChannelData(0);
  registerAudioResource(
    id,
    left,
    buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left,
    buffer.sampleRate,
  );
  return buffer.length;
};
const sampleVoice = (
  instrument: Instrument,
  voice: Voice,
  frequency: number,
  sampleRate: number,
): Stereo => {
  const sample = resources.get(instrument.resourceId);
  if (!sample) {
    return [0, 0];
  }
  const root = typeof instrument.rootKey === "number" ? instrument.rootKey : 60;
  const rate = ((sample.sampleRate / sampleRate) * frequency) / (440 * 2 ** ((root - 69) / 12));
  const start = typeof instrument.sampleStart === "number" ? instrument.sampleStart : 0;
  const loopStart = typeof instrument.loopStart === "number" ? instrument.loopStart : 0;
  const loopEnd = typeof instrument.loopEnd === "number" ? instrument.loopEnd : sample.left.length;
  const mode = instrument.loopMode ?? "Loop";
  const reverse = instrument.backwards === true;
  let position = voice.samplePosition + start;
  if (mode === "Loop" && position >= loopEnd) {
    position = loopStart + ((position - loopStart) % Math.max(1, loopEnd - loopStart));
  }
  if (mode === "Ping-Pong") {
    const span = Math.max(1, loopEnd - loopStart);
    const offset = Math.max(0, position - loopStart) % (span * 2);
    if (position >= loopStart) {
      position = loopStart + (offset < span ? offset : span * 2 - offset);
    }
  }
  if (mode === "Play Loop Once" && position >= loopEnd) {
    return [0, 0];
  }
  if (reverse) {
    position = sample.left.length - 1 - position;
  }
  voice.samplePosition += rate;
  if (position < 0 || position >= sample.left.length) {
    return [0, 0];
  }
  const index = Math.floor(position);
  const fraction = position - index;
  return [
    (sample.left[index] ?? 0) * (1 - fraction) + (sample.left[index + 1] ?? 0) * fraction,
    (sample.right[index] ?? 0) * (1 - fraction) + (sample.right[index + 1] ?? 0) * fraction,
  ];
};
export const installAudioResourceAlias = (sourceId: string, destinationId: string): void => {
  const resource = resources.get(sourceId);
  const font = soundFonts.get(sourceId);
  if (!resource && !font) {
    throw new Error("The prepared audio resource is unavailable.");
  }
  if (resource) {
    applyAudioResourceUpdate({ type: "sample", id: destinationId, resource });
    notifyAudioResource({ type: "sample", id: destinationId, resource });
  }
  if (font) {
    applyAudioResourceUpdate({ type: "soundfont", id: destinationId, font });
    notifyAudioResource({ type: "soundfont", id: destinationId, font });
  }
};
export const removeAudioResource = (id: string): void => {
  applyAudioResourceUpdate({ type: "remove", id });
  notifyAudioResource({ type: "remove", id });
};

// Only publish a resource after its sample data and presets are ready.
export const installSoundFont = (id: string, font: SoundFont): SoundFontPreset[] => {
  const sharedFont = { ...font, samples: shareSamples(font.samples) };
  applyAudioResourceUpdate({ type: "soundfont", id, font: sharedFont });
  notifyAudioResource({ type: "soundfont", id, font: sharedFont });
  return font.presets
    .filter(({ bank, program }) => bank <= 16_383 && program <= 127)
    .map(({ name, bank, program }) => ({ name, bank, program }));
};
export const registerSoundFont = (id: string, data: ArrayBuffer): SoundFontPreset[] =>
  installSoundFont(id, decodePCMSoundFont(parseSoundFont(data)));

const resolveSoundFontVoice = (
  instrument: Instrument,
  voice: Voice,
  frequency: number,
  block: number,
): SFVoiceState | undefined => {
  const font = soundFonts.get(instrument.resourceId);
  if (!font) {
    return undefined;
  }
  let prepared = voice.soundFont;
  if (
    prepared?.font !== font ||
    prepared.bank !== instrument.bank ||
    prepared.program !== instrument.program
  ) {
    const preset = font.presets.find(
      (item) => item.bank === instrument.bank && item.program === instrument.program,
    );
    if (!preset) {
      return undefined;
    }
    prepared = prepareSoundFontVoice(
      font,
      preset,
      prepared?.originalKey ?? Math.round(69 + 12 * Math.log2(frequency / 440)),
    );
    voice.soundFont = prepared;
  }
  prepared.block = block;
  return prepared;
};
const soundFontSample = (
  instrument: Instrument,
  voice: Voice,
  frequency: number,
  sampleRate: number,
  block: number,
): Stereo => {
  // Resource and preset edits take effect between synchronous blocks.
  const output = voice.sourceOutput;
  output[0] = 0;
  output[1] = 0;
  const cached = voice.soundFont;
  const prepared =
    block !== 0 && cached?.block === block
      ? cached
      : resolveSoundFontVoice(instrument, voice, frequency, block);
  if (!prepared || prepared.finished) {
    return output;
  }
  if (prepared.frequency !== frequency) {
    prepared.frequency = frequency;
    prepared.midi = 69 + 12 * Math.log2(frequency / 440);
  }
  const { midi, font } = prepared;
  let left = 0;
  let right = 0;
  let remaining = false;
  for (const zone of prepared.zones) {
    const loop = zone.mode === 1 || (zone.mode === 3 && voice.released === undefined);
    let p = zone.position;
    if (loop && p >= zone.loopEnd && zone.loopEnd > zone.loopStart) {
      p = zone.loopStart + ((p - zone.loopStart) % (zone.loopEnd - zone.loopStart));
    }
    // Native volume release has reached exact silence. Do not carry dead zones through long editor fades.
    if (
      p >= zone.end ||
      (voice.released !== undefined && voice.age - voice.released >= zone.volEnvelope.release)
    ) {
      continue;
    }
    remaining = true;
    const modEnv =
      zone.envPitch !== 0 || zone.envFilter !== 0
        ? sampleSFEnvelope(
            zone.modEnvelope,
            zone.modEnvelopeState,
            voice.age,
            voice.released,
            1 / sampleRate,
          )
        : 0;
    const volEnv = sampleSFEnvelope(
      zone.volEnvelope,
      zone.volEnvelopeState,
      voice.age,
      voice.released,
      1 / sampleRate,
    );
    const modLFO =
      (zone.modPitch !== 0 || zone.modFilter !== 0 || zone.modVolume !== 0) &&
      voice.age >= zone.modDelay
        ? Math.sin((voice.age - zone.modDelay) * zone.modRate)
        : 0;
    const vibLFO =
      zone.vibPitch !== 0 && voice.age >= zone.vibDelay
        ? Math.sin((voice.age - zone.vibDelay) * zone.vibRate)
        : 0;
    const cents =
      (zone.fixedKey >= 0 ? zone.fixedKey - zone.root : midi - zone.root) * zone.scale +
      zone.tuning +
      modLFO * zone.modPitch +
      vibLFO * zone.vibPitch +
      modEnv * zone.envPitch;
    if (zone.rateCents !== cents) {
      zone.rateCents = cents;
      zone.playbackRate = (zone.header.sampleRate / sampleRate) * 2 ** (cents / 1200);
    }
    const rate = zone.playbackRate;
    if (rate < 0 || !Number.isFinite(rate)) {
      continue;
    }
    zone.position = p + rate;
    if (p < 0) {
      continue;
    }
    const sampleIndex = Math.floor(p);
    const fraction = p - sampleIndex;
    const { samples } = font;
    let l =
      (samples[sampleIndex] ?? 0) * (1 - fraction) + (samples[sampleIndex + 1] ?? 0) * fraction;
    let r = l;
    if (zone.linkedOffset !== 0) {
      const linkedIndex = sampleIndex + zone.linkedOffset;
      const linked =
        (samples[linkedIndex] ?? 0) * (1 - fraction) + (samples[linkedIndex + 1] ?? 0) * fraction;
      if (zone.header.type === 4) {
        r = linked;
      } else {
        l = linked;
      }
    }
    const filterCents = zone.cutoff + modEnv * zone.envFilter + modLFO * zone.modFilter;
    if (filterCents !== zone.filterCents) {
      zone.filterCents = filterCents;
      const filterHz = clamp(absoluteCentsToHz(filterCents), 20, sampleRate * 0.45);
      const omega = (TAU * filterHz) / sampleRate;
      const cos = Math.cos(omega);
      const alpha = Math.sin(omega) / (2 * zone.q);
      const a0 = 1 + alpha;
      zone.b0 = (1 - cos) / 2 / a0;
      zone.a1 = (-2 * cos) / a0;
      zone.a2 = (1 - alpha) / a0;
    }
    const h = zone.history;
    const filteredL = finite(
      zone.b0 * (l + 2 * (h[0] ?? 0) + (h[1] ?? 0)) - zone.a1 * (h[2] ?? 0) - zone.a2 * (h[3] ?? 0),
    );
    const filteredR = zone.mono
      ? filteredL
      : finite(
          zone.b0 * (r + 2 * (h[4] ?? 0) + (h[5] ?? 0)) -
            zone.a1 * (h[6] ?? 0) -
            zone.a2 * (h[7] ?? 0),
        );
    h[1] = h[0] ?? 0;
    h[0] = l;
    h[3] = h[2] ?? 0;
    h[2] = filteredL;
    h[5] = h[4] ?? 0;
    h[4] = r;
    h[7] = h[6] ?? 0;
    h[6] = filteredR;
    l = filteredL;
    r = filteredR;
    const lfoGain = modLFO === 0 || zone.modVolume === 0 ? 1 : db(modLFO * zone.modVolume);
    const gain = zone.gain * volEnv * lfoGain;
    left += l * gain * zone.panL;
    right += r * gain * zone.panR;
    if (instrument.presetEffects) {
      voice.sfReverbL += l * gain * zone.reverb;
      voice.sfReverbR += r * gain * zone.reverb;
      voice.sfChorusL += l * gain * zone.chorus;
      voice.sfChorusR += r * gain * zone.chorus;
    }
  }
  prepared.finished = !remaining;
  output[0] = left;
  output[1] = right;
  return output;
};
const sourceSample = (
  instrument: Instrument,
  voice: Voice,
  frequency: number,
  sampleRate: number,
  renderBlock = 0,
): Stereo => {
  if (instrument.type === "SoundFont") {
    return soundFontSample(instrument, voice, frequency, sampleRate, renderBlock);
  }
  if (instrument.type === "chip wave" && instrument.resourceId) {
    return sampleVoice(instrument, voice, frequency, sampleRate);
  }
  if (instrument.type === "FM (n-op)") {
    voice.evaluateParameter ??= (target, base): number =>
      voiceParameter(target, base, voice, voice.beatAge, voice.expression);
    return sampleFM(
      instrument,
      voice.fmState,
      frequency,
      sampleRate,
      required(voice.evaluateParameter),
      voice.parameterEnvelopes,
      renderBlock,
      voice.sourceOutput,
    );
  }
  const { phase } = voice;
  const value = finite(
    waveSample("custom", phase, frequency, sampleRate, 0.5, instrument.customWave),
  );
  voice.phase = (phase + frequency / sampleRate) % 1;
  return [value, value];
};
type NoteContour = { interval: number; volume: number };
const readNoteContour = (note: Note, beat: number, contour: NoteContour): void => {
  const time = beat - note.start;
  let previous = note.pins[0] ?? { time: 0, interval: 0, volume: 3 };
  for (let index = 1; index < note.pins.length; index++) {
    const next = required(note.pins[index]);
    if (time < next.time) {
      const progress = (time - previous.time) / Math.max(1e-9, next.time - previous.time);
      contour.interval = previous.interval + (next.interval - previous.interval) * progress;
      contour.volume = (previous.volume + (next.volume - previous.volume) * progress) / 3;
      return;
    }
    previous = next;
  }
  contour.interval = previous.interval;
  contour.volume = previous.volume / 3;
};
export type RendererClock = {
  bar: number;
  beat: number;
  seconds: number;
  elapsedBeat: number;
  visitTicks: number;
  barVisit: number;
  fired: string[];
  sampleFrame: number;
  sequenceIndex: number;
};
type RenderFrame = {
  bar: number;
  beat: number;
  seconds: number;
  elapsedBeat: number;
  barVisit: number;
  sequenceIndex: number;
  playing: boolean;
  globals: EffectiveGlobals;
};
export type RenderPlan = {
  frames: RenderFrame[];
  end: RendererClock;
  playing: boolean;
};
type PlayingWindow = { from: number; through: number };

const playingWindows = (plan: RenderPlan): ReadonlyMap<number, PlayingWindow> => {
  const windows = new Map<number, PlayingWindow>();
  for (const { bar, beat, playing } of plan.frames) {
    if (playing) {
      const window = windows.get(bar);
      if (window) {
        window.from = Math.min(window.from, beat);
        window.through = Math.max(window.through, beat);
      } else {
        windows.set(bar, { from: beat, through: beat });
      }
    }
  }
  return windows;
};
const nativeControlRuns = ({ frames }: RenderPlan): number[] => {
  const runs = [0];
  let [previous] = frames;
  for (let index = 1; index < frames.length; index++) {
    const frame = required(frames[index]);
    if (
      previous?.playing !== frame.playing ||
      previous.barVisit !== frame.barVisit ||
      previous.globals.tempo !== frame.globals.tempo ||
      previous.globals.detune !== frame.globals.detune
    ) {
      runs.push(index);
    }
    previous = frame;
  }
  runs.push(frames.length);
  return runs;
};
type StemPlan = {
  plan: RenderPlan;
  readonly windows: ReadonlyMap<number, PlayingWindow>;
  readonly nativeRuns: readonly number[];
};
// These queries are shared by all stems on a worker, and only built for tracks
// that have to inspect the score or run native synthesis.
export const prepareStemPlan = (plan: RenderPlan): StemPlan => {
  let windows: ReadonlyMap<number, PlayingWindow> | null = null;
  let nativeRuns: readonly number[] | null = null;
  return {
    plan,
    get windows(): ReadonlyMap<number, PlayingWindow> {
      return (windows ??= playingWindows(plan));
    },
    get nativeRuns(): readonly number[] {
      return (nativeRuns ??= nativeControlRuns(plan));
    },
  };
};
export type SongRendererOptions = {
  channelIds?: ReadonlySet<string>;
  master?: boolean;
};
type NativeCache = {
  signature: string;
  native: NativeSynth;
  barVisit: number;
  nextBeat: number;
};
type NativeBuffers = {
  left: Float64Array;
  right: Float64Array;
};
type NativeBlock = NativeBuffers & {
  channel: Channel;
  instrumentId: string;
  sounded: boolean;
};
type RenderChannel = {
  channel: Channel;
  note: Note | undefined;
  noteFrom: number;
  noteUntil: number;
  block: number;
};
export class SongRenderer {
  public song: Song;
  public readonly sampleRate: number;
  public recording = false;
  public bar = 0;
  public beat = 0;
  public seconds = 0;
  public playing = true;
  public muted: ReadonlySet<string> = new Set();
  private readonly voices = new Map<string, Voice>();
  private readonly effectNotes = new Map<string, EffectNote>();
  private readonly instrumentVoices = new Map<string, Map<string, Voice>>();
  private sampleFrame = 0;
  private activeVoiceCount = 0;
  private renderBlock = 0;
  private activeRenderBlock = 0;
  private barVisit = 0;
  private readonly scheduledNotes = new Map<
    string,
    {
      note: Note;
      bar: number;
      transition: string;
      visit: number;
      frame: number;
      beatOffset: number;
      slots: Map<number, VoiceSlot>;
    }
  >();
  private readonly live = new Map<number, Channel>();
  private liveNoteId = 0;
  private readonly liveNoteIds = new Map<number, number>();
  private readonly livePitches = new Map<string, number[]>();
  private effectiveTempo = 150;
  private elapsedBeat = 0;
  private readonly sequence: number[] | null = null;
  private sequenceIndex = 0;
  private readonly fired = new Set<string>();
  private visitTicks = 0;
  private readonly runtimeEffects = new Map<string, RuntimeEffect>();
  private readonly effectChains = new WeakMap<Effect[], RenderEffectChain>();
  private readonly soundFontSends = new Map<string, [SoundFontSend, SoundFontSend]>();
  private readonly upstreamRenderers = new Map<string, NativeCache>();
  private nativeBlock: NativeBlock | null = null;
  private nativeBuffers: NativeBuffers | null = null;
  private nativeBlockFrame = 0;
  private upstreamSong: Song | null = null;
  private pitchChannels: Channel[] = [];
  private readonly soundingChannels = new Set<string>();
  private readonly noteContour: NoteContour = { ...defaultNoteContour };
  private readonly automation = new Map<string, Channel[]>();
  private globalAutomation: Channel[] = [];
  private automationBlock: AutomationBlock | undefined;
  private readonly targetAutomation = new WeakMap<Channel | Instrument, Channel[]>();
  private readonly effectEnvelopes = new WeakMap<
    Instrument,
    {
      envelopes: Envelope[];
      bindings: Map<string, Array<{ envelope: Envelope; parameter: string }>>;
    }
  >();
  // Synchronous block rendering consumes each pair before the next sample.
  // Direct sample() calls still return independently owned output arrays.
  private readonly blockOutput: Stereo = [0, 0];
  private readonly blockInput: Stereo = [0, 0];
  private readonly channelMix: Stereo = [0, 0];
  private readonly instrumentMix: Stereo = [0, 0];
  private renderChannels: RenderChannel[] = [];
  private renderBar = -1;
  private renderPlaying = false;
  private readonly channelIds: ReadonlySet<string> | undefined;
  private readonly renderMaster: boolean;
  public constructor(
    song: Song,
    sampleRate = 44_100,
    startBar = 0,
    sequence?: number[],
    options: SongRendererOptions = {},
  ) {
    this.channelIds = options.channelIds;
    this.renderMaster = options.master ?? true;
    this.song = song;
    this.sampleRate = sampleRate;
    this.bar = startBar;
    if (sequence) {
      this.sequence = sequence;
      this.bar = sequence[0] ?? 0;
    }
  }
  public get transportClock(): RendererClock {
    return {
      bar: this.bar,
      beat: this.beat,
      seconds: this.seconds,
      elapsedBeat: this.elapsedBeat,
      visitTicks: this.visitTicks,
      barVisit: this.barVisit,
      fired: [...this.fired],
      sampleFrame: this.sampleFrame,
      sequenceIndex: this.sequenceIndex,
    };
  }
  public synchronizeClock(clock: RendererClock): void {
    this.bar = clock.bar;
    this.beat = clock.beat;
    this.seconds = clock.seconds;
    this.elapsedBeat = clock.elapsedBeat;
    this.visitTicks = clock.visitTicks;
    this.barVisit = clock.barVisit;
    this.sampleFrame = clock.sampleFrame;
    this.sequenceIndex = clock.sequenceIndex;
    this.fired.clear();
    for (const event of clock.fired) {
      this.fired.add(event);
    }
    this.renderBar = -1;
  }
  public audition(channel: Channel, pitch: number): void {
    this.live.set(pitch, channel);
    this.liveNoteIds.set(pitch, ++this.liveNoteId);
    this.refreshLivePitches();
    this.renderBar = -1;
  }
  public release(pitch: number): void {
    this.live.delete(pitch);
    this.liveNoteIds.delete(pitch);
    this.refreshLivePitches();
    this.renderBar = -1;
  }
  public releaseAll(): void {
    this.live.clear();
    this.liveNoteIds.clear();
    this.refreshLivePitches();
    for (const key of this.voices.keys()) {
      if (key.startsWith("live-")) {
        this.voices.delete(key);
        for (const voices of this.instrumentVoices.values()) {
          voices.delete(key);
        }
      }
    }
  }
  public seek(bar: number): void {
    this.bar = clamp(Math.floor(bar), 0, this.song.barCount - 1);
    this.beat = 0;
    this.voices.clear();
    this.instrumentVoices.clear();
    this.scheduledNotes.clear();
    this.effectNotes.clear();
    this.fired.clear();
    this.visitTicks = 0;
    this.reset();
  }
  public reset(): void {
    for (const effect of this.runtimeEffects.values()) {
      states.delete(effect);
      effect.render = undefined;
    }
    this.soundFontSends.clear();
    this.voices.clear();
    this.instrumentVoices.clear();
    this.scheduledNotes.clear();
    this.effectNotes.clear();
    this.upstreamRenderers.clear();
    this.nativeBuffers = null;
    this.soundingChannels.clear();
    this.renderBar = -1;
  }
  public sample(input?: Stereo, planned?: RenderFrame): Stereo {
    if (this.upstreamSong !== this.song) {
      this.refreshSong();
    }
    if (planned) {
      this.bar = planned.bar;
      this.beat = planned.beat;
      this.seconds = planned.seconds;
      this.elapsedBeat = planned.elapsedBeat;
      this.barVisit = planned.barVisit;
      this.sequenceIndex = planned.sequenceIndex;
      this.playing = planned.playing;
    }
    if (this.renderBar !== this.bar || this.renderPlaying !== this.playing) {
      this.renderChannels = [];
      for (const channel of this.pitchChannels) {
        if (
          (this.playing &&
            (channel.patterns[channel.cells[this.bar] ?? 0]?.notes.length ?? 0) > 0) ||
          this.soundingChannels.has(channel.id) ||
          this.livePitches.has(channel.id)
        ) {
          this.renderChannels.push({
            channel,
            note: undefined,
            noteFrom: 0,
            noteUntil: 0,
            block: 0,
          });
        }
      }
      this.renderBar = this.bar;
      this.renderPlaying = this.playing;
    }
    const globals = planned?.globals ?? this.frameGlobals();
    this.effectiveTempo = globals.tempo;
    const reuse = this.activeRenderBlock !== 0;
    let output: Stereo = input ?? (reuse ? this.blockOutput : [0, 0]);
    if (input === undefined) {
      output[0] = 0;
      output[1] = 0;
    }
    const frame = ++this.sampleFrame;
    this.activeVoiceCount = 0;
    for (const track of input === undefined ? this.renderChannels : []) {
      const { channel } = track;
      let [mixLeft, mixRight] = output;
      this.soundingChannels.add(channel.id);
      let note: Note | null | undefined = this.playing ? null : undefined;
      let contour: NoteContour | null = null;
      let channelOutput: Stereo = reuse ? this.channelMix : [0, 0];
      channelOutput[0] = 0;
      channelOutput[1] = 0;
      let hasChannelProcessing: boolean | null = null;
      const livePitches = this.livePitches.get(channel.id) ?? noPitches;
      for (const instrument of channel.instruments) {
        let instrumentOutput: Stereo = reuse ? this.instrumentMix : [0, 0];
        instrumentOutput[0] = 0;
        instrumentOutput[1] = 0;
        const nativeSource = usesUpstreamSynth(instrument);
        if (nativeSource) {
          hasChannelProcessing ??=
            channel.effects.some((effect) => effect.enabled) ||
            (this.targetAutomation.get(channel)?.some((auto) => auto.enabled) ?? false);
          let cached = this.upstreamRenderers.get(instrument.id);
          if (!cached) {
            if (
              (channel.patterns[channel.cells[this.bar] ?? 0]?.notes.length ?? 0) === 0 &&
              livePitches.length === 0
            ) {
              continue;
            }
            cached = this.nativeRenderer(channel, instrument);
          }
          const block = this.nativeBlock;
          if (block?.instrumentId === instrument.id) {
            instrumentOutput = [
              block.left[this.nativeBlockFrame] ?? 0,
              block.right[this.nativeBlockFrame] ?? 0,
            ];
          } else {
            this.synchronizeNativeBar(cached, this.barVisit, this.bar, this.sequenceIndex);
            instrumentOutput = cached.native.runtime.sample(
              this.playing,
              livePitches,
              globals.tempo,
              globals.detune,
            );
            cached.nextBeat = this.beat + globals.tempo / 60 / this.sampleRate;
          }
        } else {
          const activeBefore = this.activeVoiceCount;
          if (note === null) {
            note = this.findActiveNote(track);
          }
          if (note) {
            if (!contour) {
              contour = this.noteContour;
              readNoteContour(note, this.beat, contour);
            }
            let scheduled = this.scheduledNotes.get(instrument.id);
            if (
              scheduled?.note.id !== note.id ||
              scheduled.bar !== this.bar ||
              scheduled.visit !== this.barVisit ||
              scheduled.transition !== instrument.transition
            ) {
              const tied =
                scheduled?.visit === this.barVisit - 1 &&
                scheduled.frame === frame - 1 &&
                notesTie(scheduled.note, note, this.song.beatsPerBar);
              const slots = new Map<number, VoiceSlot>();
              let beatOffset = 0;
              if (tied && scheduled) {
                const interval = scheduled.note.pins.at(-1)?.interval ?? 0;
                for (const [pitch, slot] of scheduled.slots) {
                  slots.set(pitch + interval, slot);
                }
                beatOffset = scheduled.beatOffset + scheduled.note.end - scheduled.note.start;
              }
              scheduled = {
                note,
                bar: this.bar,
                visit: this.barVisit,
                frame,
                transition: instrument.transition,
                slots,
                beatOffset,
              };
              this.scheduledNotes.set(instrument.id, scheduled);
            }
            // Song edits clone note objects; their stable IDs preserve a tied
            // voice's inherited IDs and cumulative envelope beat offset.
            scheduled.note = note;
            scheduled.frame = frame;
            const { slots, beatOffset } = scheduled;
            let { pitches } = note;
            if (instrument.chords === "arpeggio" && pitches.length > 1) {
              const speed = instrument.arpeggioSpeed;
              const step = Math.floor(
                (beatOffset + this.beat - note.start) * this.song.rhythm * speed,
              );
              const index =
                pitches.length === 2 && !instrument.fastTwoNote
                  ? Math.floor(step / 2) % 2
                  : step % pitches.length;
              pitches = [pitches[index] ?? required(pitches[0])];
            }
            for (let index = 0; index < pitches.length; index++) {
              const pitch = required(pitches[index]);
              if (
                instrument.chords === "strum" &&
                beatOffset + this.beat - note.start < index / this.song.rhythm / 2
              ) {
                continue;
              }
              let slot = slots.get(pitch);
              if (slot === undefined) {
                const id =
                  instrument.transition === "continue" || instrument.transition === "slide"
                    ? `${channel.id}-${instrument.id}-connected-${pitch}`
                    : `${channel.id}-${instrument.id}-${this.barVisit}-${this.bar}-${note.id}-${pitch}`;
                slot = { id, voice: undefined };
                slots.set(pitch, slot);
              }
              const pair = this.synth(
                channel,
                instrument,
                pitch,
                slot.id,
                note,
                globals,
                beatOffset,
                contour,
                slot,
              );
              instrumentOutput[0] += pair[0];
              instrumentOutput[1] += pair[1];
            }
          }
          for (const pitch of livePitches) {
            const id = `live-${required(this.liveNoteIds.get(pitch))}-${pitch}-${instrument.id}`;
            const pair = this.synth(channel, instrument, pitch, id, undefined, globals);
            instrumentOutput[0] += pair[0];
            instrumentOutput[1] += pair[1];
          }
          const voices = this.instrumentVoices.get(instrument.id);
          // Held and live notes already rendered these voices. Scan only when
          // the instrument still has voices that could contribute release tails.
          if (voices && voices.size > this.activeVoiceCount - activeBefore) {
            for (const [id, voice] of voices) {
              if (
                voice.activeFrame === frame ||
                voice.soundFont?.finished === true ||
                (instrument.release < 0 && !voice.live)
              ) {
                continue;
              }
              voice.released ??= voice.age;
              const elapsed = voice.age - voice.released;
              const release = Math.max(0.003, instrument.release);
              if (elapsed >= release) {
                continue;
              }
              const { pitch } = voice;
              if (!Number.isFinite(pitch)) {
                continue;
              }
              const pair = this.synth(channel, instrument, pitch, id, undefined, globals);
              const fade = (1 - elapsed / release) ** 2;
              instrumentOutput[0] += pair[0] * fade;
              instrumentOutput[1] += pair[1] * fade;
            }
          }
          if (instrument.type === "SoundFont" && instrument.presetEffects) {
            let sends = this.soundFontSends.get(instrument.id);
            if (!sends) {
              const send = (type: "Chorus" | "Reverb"): SoundFontSend => ({
                input: [0, 0],
                effect: {
                  id: `sf2-${instrument.id}-${type}`,
                  type,
                  enabled: true,
                  parameters: type === "Chorus" ? { amount: 100 } : { decay: 2 },
                },
              });
              sends = [send("Reverb"), send("Chorus")];
              this.soundFontSends.set(instrument.id, sends);
            }
            const [reverb, chorus] = sends;
            reverb.input[0] = 0;
            reverb.input[1] = 0;
            chorus.input[0] = 0;
            chorus.input[1] = 0;
            for (const voice of voices?.values() ?? []) {
              reverb.input[0] += voice.sfReverbL;
              reverb.input[1] += voice.sfReverbR;
              chorus.input[0] += voice.sfChorusL;
              chorus.input[1] += voice.sfChorusR;
              voice.sfReverbL = 0;
              voice.sfReverbR = 0;
              voice.sfChorusL = 0;
              voice.sfChorusR = 0;
            }
            const gain = instrument.volume * 0.15;
            for (const { effect, input: sendInput } of sends) {
              if (!effect.render && sendInput[0] === 0 && sendInput[1] === 0) {
                continue;
              }
              effect.render ??= prepareEffectProcessor(effect, this.sampleRate);
              const processed = effect.render(sendInput, this.seconds);
              instrumentOutput[0] += (processed[0] - sendInput[0]) * gain;
              instrumentOutput[1] += (processed[1] - sendInput[1]) * gain;
            }
          }
        }
        if (instrument.effects.length > 0) {
          instrumentOutput = this.chain(
            instrumentOutput,
            instrument.effects,
            undefined,
            instrument,
            this.effectEnvelopeVoice(track, instrument, livePitches),
          );
        }
        instrumentOutput = this.auto(instrumentOutput, this.targetAutomation.get(instrument));
        // Upstream rounds the running stereo sum once per instrument, not
        // each instrument in isolation. Preserve the unrounded mix contribution.
        if (nativeSource && hasChannelProcessing === false) {
          mixLeft = Math.fround(mixLeft + instrumentOutput[0]);
          mixRight = Math.fround(mixRight + instrumentOutput[1]);
        } else {
          channelOutput[0] = Math.fround(channelOutput[0] + instrumentOutput[0]);
          channelOutput[1] = Math.fround(channelOutput[1] + instrumentOutput[1]);
        }
      }
      channelOutput = this.chain(channelOutput, channel.effects);
      channelOutput = this.auto(channelOutput, this.targetAutomation.get(channel));
      // Gate the mix after advancing the track's voices, native transport and effects.
      if (!this.muted.has(channel.id)) {
        output[0] = Math.fround(mixLeft + channelOutput[0]);
        output[1] = Math.fround(mixRight + channelOutput[1]);
      }
    }
    // Voices that rendered this frame remain in both indexes.
    if (this.voices.size > this.activeVoiceCount) {
      for (const [id, voice] of this.voices) {
        if (voice.activeFrame !== frame) {
          voice.released ??= voice.age;
          this.voices.delete(id);
          for (const [instrumentId, voices] of this.instrumentVoices) {
            voices.delete(id);
            if (voices.size === 0) {
              this.instrumentVoices.delete(instrumentId);
            }
          }
        }
      }
    }
    if (this.renderMaster) {
      output = this.auto(output, this.automation.get("song"));
      const gain = globals.volume / 100;
      const left = Math.fround(Math.fround(output[0]) * gain);
      const right = Math.fround(Math.fround(output[1]) * gain);
      if (reuse) {
        output[0] = left;
        output[1] = right;
      } else {
        output = [left, right];
      }
    }
    if (!planned) {
      this.advanceClock(globals.tempo);
    }
    return output;
  }
  // Prepare one shared clock/global-automation pass for every track worker.
  // Synth voices and effect histories remain untouched here.
  public preparePlan(frames: number, stopAtEnd = false): RenderPlan {
    if (this.upstreamSong !== this.song) {
      this.refreshSong();
    }
    const previous = this.automationBlock;
    this.automationBlock = this.prepareAutomationBlock();
    try {
      const planned: RenderFrame[] = [];
      const fixedGlobals = this.globalAutomation.length === 0 ? this.frameGlobals() : undefined;
      for (let frame = 0; frame < frames; frame++) {
        if (stopAtEnd && !this.playing) {
          break;
        }
        const globals = fixedGlobals ?? this.frameGlobals();
        planned.push({
          bar: this.bar,
          beat: this.beat,
          seconds: this.seconds,
          elapsedBeat: this.elapsedBeat,
          barVisit: this.barVisit,
          sequenceIndex: this.sequenceIndex,
          playing: this.playing,
          globals,
        });
        this.advanceClock(globals.tempo);
      }
      return { frames: planned, end: this.transportClock, playing: this.playing };
    } finally {
      this.automationBlock = previous;
    }
  }
  public process(left: Float32Array, right: Float32Array, plan?: RenderPlan): void {
    this.processBlock(left, right, false, plan);
  }
  // Apply song effects and volume once to the combined stems.
  public processMix(left: Float32Array, right: Float32Array, plan?: RenderPlan): void {
    this.processBlock(left, right, true, plan);
  }
  // Return false only when the entire block was known to produce silence.
  public processStem(left: Float32Array, right: Float32Array, block: StemPlan): boolean {
    return this.processBlock(left, right, false, block.plan, block);
  }
  public skipSilentStem(block: StemPlan): boolean {
    if (this.renderMaster || this.voices.size > 0 || this.livePitches.size > 0) {
      return false;
    }
    if (this.upstreamSong !== this.song) {
      this.refreshSong();
    }
    if (this.upstreamRenderers.size > 0 || this.pitchChannels.length !== 1) {
      return false;
    }
    const channel = required(this.pitchChannels[0]);
    const hasEffects = this.hasTrackEffects(channel);
    if (hasEffects && this.soundingChannels.has(channel.id)) {
      return false;
    }
    // Native runtimes start at the first frame of a populated bar. Effects
    // can also generate output before its first note or after its last one.
    const needsWholeBar = hasEffects || channel.instruments.some(usesUpstreamSynth);
    for (const [bar, { from, through }] of block.windows) {
      const notes = channel.patterns[channel.cells[bar] ?? 0]?.notes;
      if (notes && notes.length > 0) {
        if (needsWholeBar || notes.some((note) => note.start <= through && note.end > from)) {
          return false;
        }
        // The scalar renderer would visit this channel during the rest. Keep
        // that history in case an edit later adds an effect to the channel.
        this.soundingChannels.add(channel.id);
      }
    }
    this.finishRenderPlan(block.plan, block.plan.frames.length);
    return true;
  }
  private hasTrackEffects(channel: Channel): boolean {
    const hasEffects = (target: Channel | Instrument): boolean =>
      target.effects.length > 0 ||
      this.targetAutomation.get(target)?.some((auto) => auto.effects.length > 0) === true;
    return (
      hasEffects(channel) ||
      channel.instruments.some(
        (instrument) =>
          hasEffects(instrument) || (instrument.type === "SoundFont" && instrument.presetEffects),
      )
    );
  }
  private findActiveNote(track: RenderChannel): Note | undefined {
    const { beat, activeRenderBlock } = this;
    if (
      activeRenderBlock !== 0 &&
      track.block === activeRenderBlock &&
      beat >= track.noteFrom &&
      beat < track.noteUntil
    ) {
      return track.note;
    }
    const { channel } = track;
    const notes = channel.patterns[channel.cells[this.bar] ?? 0]?.notes;
    let until = Infinity;
    let active: Note | null = null;
    if (notes) {
      for (const note of notes) {
        if (beat >= note.start && beat < note.end) {
          active = note;
          until = Math.min(until, note.end);
          break;
        }
        // An earlier entry may become active before the current note ends.
        if (note.start > beat && note.start < until) {
          until = note.start;
        }
      }
    }
    track.note = active ?? undefined;
    track.noteFrom = beat;
    track.noteUntil = until;
    track.block = activeRenderBlock;
    return track.note;
  }
  private prepareAutomationBlock(): AutomationBlock | undefined {
    if (this.automation.size > 0) {
      return new AutomationBlock(
        this.automation.get("song") ?? [],
        this.globalAutomation,
        this.muted,
      );
    }
    return undefined;
  }
  private frameGlobals(): EffectiveGlobals {
    if (this.playing && this.globalAutomation.length > 0) {
      if (!this.automationBlock) {
        return evaluateAutomation(
          this.song,
          this.bar,
          this.beat,
          this.muted,
          this.globalAutomation,
        );
      }
      const result = initialGlobals(this.song);
      for (const { target, read } of this.automationBlock.forBar(this.bar).lanes) {
        const value = read(this.beat);
        if (value !== undefined) {
          applyGlobalLane(result, target, value);
        }
      }
      return result;
    }
    return initialGlobals(this.song);
  }
  private fireNextBar(lane: AutomationLane): boolean {
    let fired = false;
    for (const point of lane.points) {
      if (point.time <= this.beat && point.time >= 0) {
        const id = `${lane.id}-${point.time}`;
        if (!this.fired.has(id)) {
          this.fired.add(id);
          fired = true;
        }
      }
    }
    return fired;
  }
  private nextBarFromAutomation(): boolean {
    let nextBar = false;
    if (this.automationBlock) {
      for (const lane of this.automationBlock.forBar(this.bar).nextBar) {
        nextBar = this.fireNextBar(lane) || nextBar;
      }
    } else {
      for (const channel of this.automation.get("song") ?? []) {
        if (channel.enabled && !this.muted.has(channel.id)) {
          for (const lane of channel.patterns[channel.cells[this.bar] ?? 0]?.lanes ?? []) {
            if (lane.enabled && lane.target === "nextBar") {
              nextBar = this.fireNextBar(lane) || nextBar;
            }
          }
        }
      }
    }
    return nextBar;
  }
  private advanceClock(tempo: number): void {
    if (this.playing) {
      const nextBar =
        this.visitTicks >= (this.sampleRate * 60) / tempo / 24 && this.nextBarFromAutomation();
      this.beat += tempo / 60 / this.sampleRate;
      this.visitTicks++;
      if (nextBar || this.beat >= this.song.beatsPerBar - 1e-9) {
        this.advance();
      }
    }
    this.seconds += 1 / this.sampleRate;
    this.elapsedBeat += tempo / 60 / this.sampleRate;
  }
  private processBlock(
    left: Float32Array,
    right: Float32Array,
    mix: boolean,
    plan?: RenderPlan,
    stem?: StemPlan,
  ): boolean {
    if (plan && plan.frames.length !== left.length) {
      throw new Error("Audio render plan length does not match the output block.");
    }
    // Edits cannot interleave a synchronous block. Share graph preparation;
    // note scheduling, envelopes and target automation still advance every sample.
    if (this.upstreamSong !== this.song) {
      this.refreshSong();
    }
    const previousAutomation = this.automationBlock;
    this.automationBlock = this.prepareAutomationBlock();
    const previous = this.activeRenderBlock;
    const previousNative = this.nativeBlock;
    const previousNativeFrame = this.nativeBlockFrame;
    this.activeRenderBlock = ++this.renderBlock;
    try {
      // With no song effects, scale the mixed block directly from the volume plan.
      if (
        mix &&
        plan &&
        this.renderMaster &&
        this.pitchChannels.length === 0 &&
        this.voices.size === 0 &&
        this.automation
          .get("song")
          ?.some(
            (channel) =>
              channel.enabled && !this.muted.has(channel.id) && channel.effects.length > 0,
          ) !== true
      ) {
        for (let i = 0; i < left.length; i++) {
          const { globals } = required(plan.frames[i]);
          const gain = globals.volume / 100;
          left[i] = (left[i] ?? 0) * gain;
          right[i] = (right[i] ?? 0) * gain;
        }
        this.finishRenderPlan(plan, left.length);
        return true;
      }
      this.nativeBlock = !mix && plan ? this.prepareNativeBlock(plan, previous === 0, stem) : null;
      if (plan) {
        const sounded = this.copyNativeStem(left, right, plan);
        if (sounded !== null) {
          return sounded;
        }
      }
      for (let i = 0; i < left.length; i++) {
        this.nativeBlockFrame = i;
        const input = mix ? this.blockInput : undefined;
        if (input) {
          input[0] = left[i] ?? 0;
          input[1] = right[i] ?? 0;
        }
        const pair = this.sample(input, plan?.frames[i]);
        [left[i], right[i]] = pair;
      }
      if (plan) {
        this.finishRenderPlan(plan);
      }
      return true;
    } finally {
      this.automationBlock = previousAutomation;
      this.activeRenderBlock = previous;
      this.nativeBlock = previousNative;
      this.nativeBlockFrame = previousNativeFrame;
    }
  }
  private finishRenderPlan(plan: RenderPlan, skippedFrames = 0): void {
    // The clock plan advances no voices. Preserve the stem's sample counter
    // and account for frames that bypassed the per-sample renderer.
    const sampleFrame = this.sampleFrame + skippedFrames;
    this.synchronizeClock(plan.end);
    this.sampleFrame = sampleFrame;
    this.playing = plan.playing;
  }
  private nativeRenderer(
    channel: Channel,
    instrument: Instrument,
    bar = this.bar,
    beat = this.beat,
    sequenceIndex = this.sequenceIndex,
    barVisit = this.barVisit,
  ): NativeCache {
    let cached = this.upstreamRenderers.get(instrument.id);
    if (!cached) {
      const native = createNativeSynth(
        this.song,
        channel,
        instrument,
        this.sampleRate,
        envelopeValue,
        this.sequence ?? undefined,
      );
      native.runtime.seek((this.sequence ? sequenceIndex : bar) + beat / this.song.beatsPerBar);
      cached = {
        signature: this.nativeSignature(channel, instrument),
        native,
        barVisit,
        nextBeat: beat,
      };
      this.upstreamRenderers.set(instrument.id, cached);
    }
    return cached;
  }
  private synchronizeNativeBar(
    cached: NativeCache,
    barVisit: number,
    bar: number,
    sequenceIndex: number,
  ): void {
    if (cached.barVisit !== barVisit) {
      // The native score advances full bars itself. Only an early transport
      // transition needs a jump, including a loop back to the same source bar.
      if (cached.nextBeat < this.song.beatsPerBar - 1e-9) {
        cached.native.runtime.jumpToBar(this.sequence ? sequenceIndex : bar);
      }
      cached.barVisit = barVisit;
    }
  }
  private prepareNativeBlock(
    plan: RenderPlan,
    reuseBuffers: boolean,
    stem?: StemPlan,
  ): NativeBlock | null {
    if (this.upstreamSong !== this.song) {
      this.refreshSong();
    }
    // Independent track stems can batch their native source without changing
    // inter-instrument random draw order. Mixed/layered renderers stay scalar.
    if (this.renderMaster || this.pitchChannels.length !== 1) {
      return null;
    }
    const channel = required(this.pitchChannels[0]);
    const [instrument] = channel.instruments;
    if (channel.instruments.length !== 1 || !instrument || !usesUpstreamSynth(instrument)) {
      return null;
    }
    const pitches = this.livePitches.get(channel.id) ?? noPitches;
    const start = this.upstreamRenderers.has(instrument.id)
      ? 0
      : plan.frames.findIndex(
          (frame) =>
            pitches.length > 0 ||
            (frame.playing &&
              (channel.patterns[channel.cells[frame.bar] ?? 0]?.notes.length ?? 0) > 0),
        );
    if (start < 0 || start >= plan.frames.length) {
      return null;
    }
    const runs = stem?.nativeRuns ?? nativeControlRuns(plan);
    let firstRun = 0;
    while (required(runs[firstRun + 1]) <= start) {
      firstRun++;
    }
    // Continuous control ramps cannot share a fixed-control native run.
    if ((plan.frames.length - start) / (runs.length - 1 - firstRun) < 32) {
      return null;
    }
    const first = required(plan.frames[start]);
    const cached = this.nativeRenderer(
      channel,
      instrument,
      first.bar,
      first.beat,
      first.sequenceIndex,
      first.barVisit,
    );
    let buffers = reuseBuffers ? this.nativeBuffers : null;
    if (!buffers || buffers.left.length < plan.frames.length) {
      buffers = {
        left: new Float64Array(plan.frames.length),
        right: new Float64Array(plan.frames.length),
      };
      if (reuseBuffers) {
        this.nativeBuffers = buffers;
      }
    }
    const { left, right } = buffers;
    if (start > 0) {
      left.fill(0, 0, start);
      right.fill(0, 0, start);
    }
    let sounded = false;
    for (let run = firstRun; run < runs.length - 1; run++) {
      const from = run === firstRun ? start : required(runs[run]);
      const to = required(runs[run + 1]);
      const frame = required(plan.frames[from]);
      this.synchronizeNativeBar(cached, frame.barVisit, frame.bar, frame.sequenceIndex);
      sounded =
        cached.native.runtime.process(
          left.subarray(from, to),
          right.subarray(from, to),
          frame.playing,
          pitches,
          frame.globals.tempo,
          frame.globals.detune,
        ) || sounded;
      const last = required(plan.frames[to - 1]);
      cached.nextBeat = last.beat + last.globals.tempo / 60 / this.sampleRate;
    }
    return { channel, instrumentId: instrument.id, left, right, sounded };
  }
  private copyNativeStem(
    left: Float32Array,
    right: Float32Array,
    plan: RenderPlan,
  ): boolean | null {
    const block = this.nativeBlock;
    if (!block || block.channel.effects.length > 0 || this.voices.size > 0) {
      return null;
    }
    const cached = this.upstreamRenderers.get(block.instrumentId);
    const [instrument] = block.channel.instruments;
    if (!cached || !instrument || instrument.effects.length > 0) {
      return null;
    }
    for (const target of [block.channel, instrument]) {
      if (
        this.targetAutomation
          .get(target)
          ?.some(
            (channel) =>
              channel.enabled && !this.muted.has(channel.id) && channel.effects.length > 0,
          ) === true
      ) {
        return null;
      }
    }
    // The embedded synth already applies instrument gain and source envelopes.
    // A dry single-source stem needs no per-sample editor graph traversal.
    const audible = block.sounded && !this.muted.has(block.channel.id);
    if (audible) {
      for (let frame = 0; frame < left.length; frame++) {
        left[frame] = (block.left[frame] ?? 0) + 0;
        right[frame] = (block.right[frame] ?? 0) + 0;
      }
    } else {
      left.fill(0);
      right.fill(0);
    }
    this.finishRenderPlan(plan, left.length);
    this.soundingChannels.add(block.channel.id);
    return audible;
  }
  private nativeSignature(channel: Channel, instrument: Instrument): string {
    const { key, beatsPerBar, tempo, patternCount, barCount } = this.song;
    return JSON.stringify([
      key,
      beatsPerBar,
      tempo,
      patternCount,
      barCount,
      channel.cells,
      channel.patterns,
      instrument,
    ]);
  }
  private refreshSong(): void {
    this.pitchChannels = [];
    this.automation.clear();
    const retained = new Set<string>();
    for (const channel of this.song.channels) {
      if (channel.kind === "automation") {
        const { kind, channelId, instrumentId } = channel.target;
        const key =
          kind === "song" ? kind : `${kind}:${kind === "channel" ? channelId : instrumentId}`;
        const channels = this.automation.get(key) ?? [];
        channels.push(channel);
        this.automation.set(key, channels);
        continue;
      }
      if (this.channelIds !== undefined && !this.channelIds.has(channel.id)) {
        continue;
      }
      this.pitchChannels.push(channel);
      for (const instrument of channel.instruments) {
        const cached = this.upstreamRenderers.get(instrument.id);
        if (cached && usesUpstreamSynth(instrument)) {
          const signature = this.nativeSignature(channel, instrument);
          if (cached.signature !== signature) {
            createNativeSynth(
              this.song,
              channel,
              instrument,
              this.sampleRate,
              envelopeValue,
              this.sequence ?? undefined,
              cached.native,
            );
            cached.signature = signature;
          }
          cached.native.runtime.setLoop(
            this.sequence ? 0 : this.song.loopStart,
            this.sequence?.length ?? this.song.loopEnd,
          );
          retained.add(instrument.id);
        }
      }
    }
    for (const id of this.upstreamRenderers.keys()) {
      if (!retained.has(id)) {
        this.upstreamRenderers.delete(id);
      }
    }
    for (const channel of this.pitchChannels) {
      this.targetAutomation.set(channel, this.automation.get(`channel:${channel.id}`) ?? []);
      for (const instrument of channel.instruments) {
        this.targetAutomation.set(
          instrument,
          this.automation.get(`instrument:${instrument.id}`) ?? [],
        );
      }
    }
    this.globalAutomation = (this.automation.get("song") ?? []).filter((channel) =>
      Object.values(channel.patterns).some((pattern) =>
        pattern.lanes.some((lane) => lane.effectId === undefined || lane.effectId === ""),
      ),
    );
    this.upstreamSong = this.song;
    this.renderBar = -1;
  }
  private advance(): void {
    this.barVisit++;
    if (this.sequence) {
      this.sequenceIndex++;
      if (this.sequenceIndex >= this.sequence.length) {
        this.playing = false;
        return;
      }
      this.bar = this.sequence[this.sequenceIndex] ?? 0;
    } else {
      this.bar++;
      if (!this.recording && this.bar >= this.song.loopEnd) {
        this.bar = this.song.loopStart;
      }
    }
    this.beat = 0;
    this.fired.clear();
    this.visitTicks = 0;
  }
  private refreshLivePitches(): void {
    this.livePitches.clear();
    for (const [pitch, channel] of this.live) {
      let pitches = this.livePitches.get(channel.id);
      if (!pitches) {
        pitches = [];
        this.livePitches.set(channel.id, pitches);
      }
      pitches.push(pitch);
    }
    for (const channel of this.song.channels) {
      const pitches = this.livePitches.get(channel.id) ?? noPitches;
      const noteIds =
        pitches.length > 0
          ? pitches.map((pitch) => required(this.liveNoteIds.get(pitch)))
          : noPitches;
      for (const instrument of channel.instruments) {
        const effectNote = this.effectNotes.get(instrument.id);
        // Preserve each overlapping handoff when events arrive between render
        // calls, before the intermediate chord can disappear from the snapshot.
        if (effectNote?.liveNoteIds.some((id) => noteIds.includes(id)) === true) {
          effectNote.livePitches = pitches;
          effectNote.liveNoteIds = noteIds;
        }
        this.upstreamRenderers.get(instrument.id)?.native.runtime.setLivePitches(pitches);
      }
    }
  }
  private effectEnvelopeVoice(
    track: RenderChannel,
    instrument: Instrument,
    livePitches: number[],
  ): EnvelopeVoice | undefined {
    if (
      !instrument.envelopes.some(
        (envelope) => envelope.enabled && envelope.target.startsWith("effect:"),
      )
    ) {
      return undefined;
    }
    const livePitch = livePitches.at(-1);
    const note = this.playing && livePitch === undefined ? this.findActiveNote(track) : undefined;
    let state = this.effectNotes.get(instrument.id);
    const liveNoteIds =
      state?.livePitches === livePitches
        ? state.liveNoteIds
        : livePitches.map((pitch) => required(this.liveNoteIds.get(pitch)));
    const continuingLive =
      livePitch !== undefined &&
      (state?.liveNoteIds.some((id) => liveNoteIds.includes(id)) ?? false);
    const changed =
      livePitch !== undefined
        ? !continuingLive
        : (state?.liveNoteIds.length ?? 0) > 0 ||
          state?.note?.id !== note?.id ||
          state?.visit !== this.barVisit;
    const held = note !== undefined || livePitch !== undefined;
    if (held && (state === undefined || state.voice.released !== undefined || changed)) {
      const tied =
        note !== undefined &&
        state?.note !== undefined &&
        state.visit === this.barVisit - 1 &&
        state.frame === this.sampleFrame - 1 &&
        notesTie(state.note, note, this.song.beatsPerBar);
      const previous = tied ? required(state) : undefined;
      const voice: EnvelopeVoice = previous?.voice ?? {
        age: -1 / this.sampleRate,
        beatAge: 0,
        sharedTime: 0,
        sharedElapsedBeat: 0,
        tempo: this.effectiveTempo,
        expression: 1,
        sharedBeat: 0,
        released: undefined,
        midiKey: 60,
      };
      state = {
        voice,
        note,
        livePitches,
        liveNoteIds,
        visit: this.barVisit,
        frame: this.sampleFrame,
        beatOffset: previous
          ? previous.beatOffset + this.song.beatsPerBar - required(previous.note).start
          : 0,
      };
      this.effectNotes.set(instrument.id, state);
    }
    if (!state) {
      return undefined;
    }
    // Chord edits preserve a continuously held live envelope. Note identities
    // still distinguish a physical off/on pair between consecutive render calls.
    state.livePitches = livePitches;
    state.liveNoteIds = liveNoteIds;
    const { voice } = state;
    voice.age += 1 / this.sampleRate;
    if (!held) {
      voice.released ??= voice.age;
    }
    voice.sharedTime = this.seconds;
    voice.sharedElapsedBeat = this.elapsedBeat;
    voice.tempo = this.effectiveTempo;
    voice.sharedBeat = this.bar * this.song.beatsPerBar + this.beat;
    if (note) {
      readNoteContour(note, this.beat, this.noteContour);
      voice.expression = this.noteContour.volume;
      voice.midiKey = (note.pitches.at(-1) ?? 48) + this.song.key + 12;
      voice.beatAge = state.beatOffset + this.beat - note.start;
    } else {
      voice.beatAge += this.effectiveTempo / 60 / this.sampleRate;
      if (livePitch !== undefined) {
        voice.midiKey = livePitch + this.song.key + 12;
      }
    }
    state.frame = this.sampleFrame;
    return voice;
  }
  private effectEnvelopeBindings(
    instrument: Instrument,
    effect: Effect,
  ): ReadonlyArray<{ envelope: Envelope; parameter: string }> {
    // Editor changes replace instruments/envelope arrays. Enabled flags and values
    // stay live; only the stable target-to-parameter bindings are prepared here.
    let prepared = this.effectEnvelopes.get(instrument);
    if (prepared?.envelopes !== instrument.envelopes) {
      prepared = { envelopes: instrument.envelopes, bindings: new Map() };
      this.effectEnvelopes.set(instrument, prepared);
    }
    let bindings = prepared.bindings.get(effect.id);
    if (!bindings) {
      bindings = [];
      const prefix = `effect:${effect.id}:`;
      for (const envelope of instrument.envelopes) {
        if (envelope.target.startsWith(prefix)) {
          bindings.push({ envelope, parameter: envelope.target.slice(prefix.length) });
        }
      }
      prepared.bindings.set(effect.id, bindings);
    }
    return bindings;
  }
  private chain(
    input: Stereo,
    effects: Effect[],
    channel?: Channel,
    instrument?: Instrument,
    voice?: EnvelopeVoice,
  ): Stereo {
    if (effects.length === 0) {
      return input;
    }
    let prepared = this.effectChains.get(effects);
    const block = this.activeRenderBlock;
    const trusted =
      block !== 0 &&
      prepared?.block === block &&
      prepared.instrument === instrument &&
      prepared.envelopes === instrument?.envelopes;
    if (
      !trusted &&
      (prepared?.instrument !== instrument || prepared?.envelopes !== instrument?.envelopes)
    ) {
      prepared = undefined;
    }
    if (!prepared) {
      prepared = { instrument, envelopes: instrument?.envelopes, steps: [], block: 0 };
      this.effectChains.set(effects, prepared);
    }
    if (!trusted) {
      prepared.steps.length = effects.length;
      prepared.block = block;
    }
    const lanes = channel?.patterns[channel.cells[this.bar] ?? 0]?.lanes;
    let output = input;
    for (let index = 0; index < effects.length; index++) {
      const effect = required(effects[index]);
      let step = prepared.steps[index];
      if (!trusted) {
        if (step?.source !== effect || step.id !== effect.id) {
          let runtime = this.runtimeEffects.get(effect.id);
          if (!runtime) {
            runtime = { ...effect, parameters: effect.parameters };
            this.runtimeEffects.set(effect.id, runtime);
          }
          step = {
            source: effect,
            id: effect.id,
            runtime,
            bindings: instrument ? this.effectEnvelopeBindings(instrument, effect) : [],
            skipped: false,
            syncRate: undefined,
            syncPhase: 0,
          };
          prepared.steps[index] = step;
        }
        const { runtime } = step;
        step.skipped = !effect.enabled;
        if (!effect.enabled) {
          states.delete(runtime);
          runtime.render = undefined;
        }
        if (step.skipped) {
          continue;
        }
        if (runtime.type !== effect.type) {
          runtime.type = effect.type;
          runtime.render = undefined;
        }
        if (runtime.parameters !== effect.parameters) {
          runtime.parameters = effect.parameters;
        }
        runtime.enabled = true;
        runtime.render ??= prepareEffectProcessor(runtime, this.sampleRate);
        step.syncRate =
          effect.parameters["sync"] === "Cycles per beat" && editableEffectParameter(effect, "sync")
            ? numberParameter(effect, "rate", 2)
            : undefined;
        step.syncPhase = (numberParameter(effect, "phase", 0) * Math.PI) / 180;
      }
      step = required(step);
      if (step.skipped) {
        continue;
      }
      let overrides: Record<string, number> | null = null;
      if (lanes) {
        for (const lane of lanes) {
          if (lane.effectId === effect.id) {
            const value = this.automationBlock
              ? this.automationBlock.read(lane, this.beat)
              : evaluateLane(lane, this.beat);
            if (value !== undefined) {
              (overrides ??= {})[lane.target] = value;
            }
          }
        }
      }
      if (instrument && voice) {
        for (const { envelope, parameter } of step.bindings) {
          if (!envelope.enabled) {
            continue;
          }
          const base =
            typeof effect.parameters[parameter] === "number" ? effect.parameters[parameter] : 1;
          overrides ??= {};
          overrides[parameter] =
            (overrides[parameter] ?? base) *
            voiceEnvelopeValue(envelope, voice, voice.beatAge, voice.expression);
        }
      }
      if (step.syncRate !== undefined) {
        (overrides ??= {})["phaseRadians"] =
          (this.bar * this.song.beatsPerBar + this.beat) * step.syncRate * TAU + step.syncPhase;
      }
      output = required(step.runtime.render)(
        output,
        this.seconds,
        overrides ?? undefined,
        this.effectiveTempo,
      );
    }
    return output;
  }
  private auto(input: Stereo, channels: readonly Channel[] | undefined): Stereo {
    let output = input;
    if (channels) {
      for (const channel of channels) {
        if (channel.enabled && !this.muted.has(channel.id)) {
          output = this.chain(output, channel.effects, channel);
        }
      }
    }
    return output;
  }
  private synth(
    channel: Channel,
    instrument: Instrument,
    pitch: number,
    id: string,
    note: Note | undefined,
    globals: EffectiveGlobals,
    beatOffset = 0,
    contour = defaultNoteContour,
    slot?: VoiceSlot,
  ): Stereo {
    // Re-resolve a held note's voice after a gap in rendering.
    const cached = slot?.voice;
    let voice = cached && cached.activeFrame >= this.sampleFrame - 1 ? cached : this.voices.get(id);
    const alreadyActive = voice?.activeFrame === this.sampleFrame;
    if (!voice || (voice.released !== undefined && note !== undefined)) {
      voice = makeVoice(id, note === undefined);
      this.voices.set(id, voice);
      let voices = this.instrumentVoices.get(instrument.id);
      if (!voices) {
        voices = new Map();
        this.instrumentVoices.set(instrument.id, voices);
      }
      voices.set(id, voice);
    }
    if (slot) {
      slot.voice = voice;
    }
    if (!alreadyActive) {
      this.activeVoiceCount++;
    }
    voice.activeFrame = this.sampleFrame;
    voice.pitch = pitch;
    const midiKey = pitch + this.song.key + 12;
    voice.midiKey = midiKey;
    prepareVoiceParameters(instrument, voice);
    if (voice.parameterEnvelopes.size > 0) {
      voice.sharedTime = this.seconds;
      voice.sharedElapsedBeat = this.elapsedBeat;
      voice.tempo = globals.tempo;
      voice.sharedBeat = this.bar * this.song.beatsPerBar + this.beat;
      voice.expression = contour.volume;
      voice.beatAge = note ? beatOffset + this.beat - note.start : (voice.age * globals.tempo) / 60;
    }
    const tuning = midiKey + contour.interval - 69 + globals.detune / 100;
    if (voice.tuning !== tuning) {
      voice.tuning = tuning;
      voice.frequency = 440 * 2 ** (tuning / 12);
    }
    const output = sourceSample(
      instrument,
      voice,
      voice.frequency,
      this.sampleRate,
      this.activeRenderBlock,
    );
    const volume = voice.parameterEnvelopes.has("volume")
      ? voiceParameter("volume", instrument.volume, voice, voice.beatAge, contour.volume)
      : finite(instrument.volume, instrument.volume);
    let gain = clamp(volume, 0, MAX_INSTRUMENT_VOLUME) * 0.15 * contour.volume;
    gain *= Math.min(1, voice.age / Math.max(0.00001, instrument.attack));
    if (note && instrument.release < 0) {
      let nextBar: number | undefined = this.bar + 1;
      if (this.sequence) {
        nextBar = this.sequence[this.sequenceIndex + 1];
      } else if (!this.recording && nextBar >= this.song.loopEnd) {
        nextBar = this.song.loopStart;
      }
      const nextNote =
        nextBar === undefined
          ? undefined
          : channel.patterns[channel.cells[nextBar] ?? 0]?.notes.find((item) => item.start === 0);
      if (!(nextNote && notesTie(note, nextNote, this.song.beatsPerBar))) {
        gain *= Math.min(1, Math.max(0, (note.end - this.beat) / -instrument.release));
      }
    }
    output[0] *= gain;
    output[1] *= gain;
    voice.age += 1 / this.sampleRate;

    return output;
  }
}
// lib.dom does not declare the dedicated worker global.
declare const DedicatedWorkerGlobalScope: typeof EventTarget;
export const isDedicatedWorker = (): boolean =>
  typeof DedicatedWorkerGlobalScope !== "undefined" &&
  globalThis instanceof DedicatedWorkerGlobalScope;

type AudioState = {
  bar: number;
  beat: number;
  playing: boolean;
};

export type AudioCommand =
  | {
      type: "init";
      song: Song;
      sampleRate: number;
      threadCount: number;
      bar: number;
      beat: number;
      playing: boolean;
      recording: boolean;
      muted: string[];
      volume: number;
      output: SharedArrayBuffer;
      generation: number;
      time: number;
    }
  | { type: "audition"; channelId: string; pitch: number }
  | { type: "muted"; muted: string[] }
  | { type: "pause"; bar: number; generation: number }
  | { type: "play"; bar: number; recording: boolean; generation: number }
  | { type: "release"; pitch: number }
  | { type: "releaseAll" }
  | { type: "resource"; update: AudioResourceUpdate }
  | { type: "seek"; bar: number; beat: number; generation: number }
  | { type: "song"; song: Song }
  | { type: "threads"; threadCount: number }
  | { type: "volume"; volume: number };

export type AudioReply =
  | {
      type: "block";
      generation: number;
      block: AudioBlock;
      state: AudioState;
      time: number;
    }
  | { type: "consumed"; generation: number; id: number; time: number }
  | { type: "error"; message: string }
  | { type: "ready" };

// Playback repeats the loop indefinitely after any intro; seek beyond it to hear the outro.
// Pause releases held notes, clears effect tails and snaps to a bar boundary.
export class AudioEngine {
  public onPosition: ((bar: number, beat: number) => void) | undefined;
  public onError: ((error: Error) => void) | undefined;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private song: Song;
  private state: AudioState = { bar: 0, beat: 0, playing: false };
  private muted: string[] = [];
  private volume = 0.75;
  private threadCount = defaultAudioThreads();
  private frame = 0;
  private generation = 0;
  private readonly pendingAuditions = new Map<number, object>();
  private readonly playbackClock = new PlaybackClock();
  private readonly sentResources = new Set<string>();
  public constructor(song: Song) {
    this.song = song;
  }
  public get playing(): boolean {
    return this.state.playing;
  }
  public get bar(): number {
    return this.state.bar;
  }
  public get beat(): number {
    return this.state.beat;
  }
  public get position(): number {
    return this.bar + this.beat / this.song.beatsPerBar;
  }
  public get playhead(): number {
    return this.playing && this.context
      ? this.playbackClock.position(this.context.currentTime)
      : this.position;
  }
  public get absoluteBeat(): number {
    return this.playhead * this.song.beatsPerBar;
  }
  public setSong(song: Song): void {
    this.song = song;
    const ids = audioResourceIds(this.song);
    this.syncResources(ids);
    this.send({ type: "song", song });
    for (const id of this.sentResources) {
      if (!ids.has(id)) {
        this.send({ type: "resource", update: { type: "remove", id } });
        this.sentResources.delete(id);
      }
    }
    if (this.bar >= song.barCount) {
      this.seek(song.barCount - 1);
    }
  }
  public async play(startBar: number, recording = false): Promise<void> {
    const generation = ++this.generation;
    this.state.bar = clamp(Math.floor(startBar), 0, this.song.barCount - 1);
    this.state.beat = 0;
    await this.ensure();
    if (generation !== this.generation) {
      return;
    }
    this.state.playing = true;
    this.playbackClock.reset(this.position);
    this.send({
      type: "play",
      bar: this.bar,
      recording,
      generation,
    });
  }
  public pause(): void {
    // Use the audible cursor, rather than skipping over the worker's queued audio.
    this.state.bar = Math.floor(this.playhead);
    this.state.beat = 0;
    this.state.playing = false;
    this.playbackClock.reset(this.position);
    this.send({ type: "pause", bar: this.bar, generation: ++this.generation });
  }
  public seek(bar: number, beat = 0): void {
    this.state.bar = clamp(Math.floor(bar), 0, this.song.barCount - 1);
    this.state.beat = clamp(beat, 0, this.song.beatsPerBar - 1 / 24);
    this.playbackClock.reset(this.position);
    this.send({ type: "seek", bar: this.bar, beat: this.beat, generation: ++this.generation });
    this.onPosition?.(this.bar, this.beat);
  }
  public setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    this.send({ type: "volume", volume: this.volume });
  }
  public setThreadCount(count: number): void {
    const threadCount = normalizeAudioThreads(count);
    if (this.threadCount !== threadCount) {
      this.threadCount = threadCount;
      this.send({ type: "threads", threadCount });
    }
  }
  public setMuted(muted: ReadonlySet<string>): void {
    this.muted = [...muted];
    this.send({ type: "muted", muted: this.muted });
  }
  public async audition(channel: Channel, pitch: number): Promise<void> {
    const request = {};
    this.pendingAuditions.set(pitch, request);
    await this.ensure();
    if (this.pendingAuditions.get(pitch) === request) {
      this.pendingAuditions.delete(pitch);
      this.send({ type: "audition", channelId: channel.id, pitch });
    }
  }
  public release(pitch: number): void {
    this.pendingAuditions.delete(pitch);
    this.send({ type: "release", pitch });
  }
  public releaseAll(): void {
    this.pendingAuditions.clear();
    this.send({ type: "releaseAll" });
  }
  public async close(): Promise<void> {
    this.pendingAuditions.clear();
    this.generation++;
    resourceListeners.delete(this.sendResource);
    this.worker?.terminate();
    this.worker = null;
    this.sentResources.clear();
    this.node?.disconnect();
    this.node = null;
    if (this.context) {
      await this.context.close();
    }
    this.context = null;
    this.ready = null;
    this.state.playing = false;
  }
  private readonly sendResource = (update: AudioResourceUpdate): void => {
    if (!this.worker || !audioResourceIds(this.song).has(update.id)) {
      return;
    }
    if (update.type === "remove") {
      if (!this.sentResources.delete(update.id)) {
        return;
      }
    } else {
      this.sentResources.add(update.id);
    }
    this.send({ type: "resource", update });
  };
  private syncResources(ids: ReadonlySet<string>): void {
    if (!this.worker) {
      return;
    }
    const missing = new Set([...ids].filter((id) => !this.sentResources.has(id)));
    for (const update of snapshotAudioResources(missing)) {
      this.sendResource(update);
    }
  }
  private send(command: AudioCommand): void {
    this.worker?.postMessage(command);
  }
  private receive(reply: AudioReply): void {
    if (reply.type !== "block" && reply.type !== "consumed") {
      return;
    }
    if (reply.generation !== this.generation) {
      return;
    }
    if (reply.type === "consumed") {
      this.playbackClock.consumed(reply.id, reply.time);
      return;
    }
    this.state = reply.state;
    this.playbackClock.enqueue(reply.block, reply.time);
    if (++this.frame % 4 === 0) {
      const position = this.playhead;
      const bar = Math.floor(position);
      if (this.playing) {
        this.onPosition?.(bar, (position - bar) * this.song.beatsPerBar);
      }
    }
  }
  private async setup(): Promise<void> {
    if (typeof SharedArrayBuffer !== "function" || typeof Atomics.waitAsync !== "function") {
      throw new TypeError(
        "Audio playback requires a cross-origin isolated page and a current browser.",
      );
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    try {
      const { buffer: output } = AudioOutputBuffer.create(context.sampleRate, context.baseLatency);
      await context.audioWorklet.addModule(new URL("./audio-worklet.js", document.baseURI).href);
      const node = new AudioWorkletNode(context, "slope-output", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { output },
      });
      this.node = node;
      const worker = new Worker(new URL("./audio-worker.js", document.baseURI), { type: "module" });
      this.worker = worker;
      node.connect(context.destination);
      await new Promise<void>((resolve, reject) => {
        let initialized = false;
        const fail = (error: Error): void => {
          if (initialized) {
            this.onError?.(error);
            void this.close();
          } else {
            reject(error);
          }
        };
        worker.addEventListener("error", (event) => {
          fail(new Error(event.message || "Audio synthesis worker failed."));
        });
        node.addEventListener("processorerror", () => {
          fail(new Error("Audio output processor failed."));
        });
        worker.addEventListener("message", (event: MessageEvent<AudioReply>) => {
          if (event.data.type === "ready") {
            initialized = true;
            resolve();
          } else if (event.data.type === "error") {
            fail(new Error(event.data.message));
          } else {
            this.receive(event.data);
          }
        });
        resourceListeners.add(this.sendResource);
        this.syncResources(audioResourceIds(this.song));
        const command: AudioCommand = {
          type: "init",
          song: this.song,
          sampleRate: context.sampleRate,
          threadCount: this.threadCount,
          bar: this.bar,
          beat: this.beat,
          playing: this.playing,
          recording: false,
          muted: this.muted,
          volume: this.volume,
          generation: this.generation,
          time: context.currentTime,
          output,
        };
        this.send(command);
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private async ensure(): Promise<void> {
    this.ready ??= this.setup();
    await this.ready;
    if (this.context?.state === "suspended") {
      await this.context.resume();
    }
  }
}
export const getAudioResourceInfo = (
  id: string,
):
  | {
      frames: number;
      waveform: number[];
    }
  | undefined => {
  const resource = resources.get(id);
  if (!resource) {
    return undefined;
  }
  const waveform = Array.from({ length: 128 }, (_, index): number => {
    const start = Math.floor((index * resource.left.length) / 128);
    const end = Math.max(start + 1, Math.floor(((index + 1) * resource.left.length) / 128));
    let peak = 0;
    for (let i = start; i < end; i++) {
      peak = Math.max(peak, Math.abs(resource.left[i] ?? 0), Math.abs(resource.right[i] ?? 0));
    }
    return peak;
  });
  return { frames: resource.left.length, waveform };
};
