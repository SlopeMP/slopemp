import { effectFilterPoints, setEffectFilterPoints } from "./filters";
import { uid } from "./identity";
import { PRESET_DEFINITIONS } from "./presets";
import { dictionary, matchesShape, optional } from "./shape";
import type { SFModulator } from "./soundfont-types";
const required = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) {
    throw new Error("Missing instrument configuration.");
  }
  return value;
};
export { PRESET_GROUPS } from "./presets";
export type { SFModulator } from "./soundfont-types";
export const MAX_INSTRUMENT_VOLUME = 2.5;
// Each instrument owns its sound settings and an ordered chain of independent effects.
// Transition and Chords control articulation outside the audio-effect chain.
export type ParameterValue = boolean | number | string;
export type Effect = {
  id: string;
  type: string;
  enabled: boolean;
  parameters: Record<string, ParameterValue>;
};
export type Envelope = {
  [key: string]: unknown;
  sf2Modulators?: SFModulator[];
  id: string;
  target: string;
  type: string;
  speed: number;
  a: number;
  b: number;
  timeBasis: string;
  clock: string;
  phase: number;
  duty: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  enabled: boolean;
  curve?: number;
  law?: string;
  delay?: number;
  hold?: number;
  initialLevel?: number;
  terminalLevel?: number;
  keyToHold?: number;
  keyToDecay?: number;
};
export type FMOperator = {
  id: string;
  ratio: number;
  offset: number;
  amplitude: number;
  coarse: number;
  fine: number;
  pan: number;
  phase: number;
  stereoPhase: number;
  stereoDetune: number;
  invert: boolean;
  carrier: boolean;
  wave: string;
  pulseWidth: number;
  customWave: number[];
};
export const CHIP_WAVES = [
  "rounded",
  "triangle",
  "square",
  "1/4 pulse",
  "1/8 pulse",
  "sawtooth",
  "double saw",
  "double pulse",
  "spiky",
];
export const FM_WAVES = [
  "sine",
  "triangle",
  "sawtooth",
  "square",
  "pulse width",
  "white noise",
  "ramp",
  "trapezoid",
  "quasi-sine",
  "Custom",
];
export type FMConnection = {
  from: string;
  to: string;
};
export type FilterPoint = {
  id: string;
  type: string;
  frequency: number;
  gain: number;
};
export type Instrument = {
  [key: string]: unknown;
  id: string;
  name: string;
  type: string;
  preset: string;
  volume: number;
  wave: string;
  noise: string;
  attack: number;
  release: number;
  sustain: number;
  transition: string;
  chords: string;
  arpeggioSpeed: number;
  fastTwoNote: boolean;
  effects: Effect[];
  envelopes: Envelope[];
  harmonics: number[];
  spectrum: number[];
  customWave: number[];
  operators: FMOperator[];
  connections: FMConnection[];
  feedback: FMConnection[];
  feedbackVolume: number;
  phaseRandomness: number;
  drums: Array<{
    spectrum: number[];
    envelope: Envelope;
  }>;
  dynamism: number;
  spread: number;
  pulseWidth: number;
  shape: number;
  presetEffects: boolean;
  resourceId: string;
  bank: number;
  program: number;
  rootKey?: number;
  sampleStart?: number;
  loopStart?: number;
  loopEnd?: number;
  loopMode?: string;
  backwards?: boolean;
};
export type ParameterDefinition = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit: string;
  options?: string[];
};
const authorId = uid().replace("-", "");
let serial = 0;
export const instrumentId = (prefix = "sound"): string => `${prefix}-${authorId}-${++serial}`;
export const INSTRUMENT_TYPES = [
  "chip wave",
  "FM (n-op)",
  "basic noise",
  "spectrum",
  "drumset",
  "harmonics",
  "pulse width",
  "picked string",
  "supersaw",
  "Custom chip wave",
  "SoundFont",
];
export const EFFECT_GROUPS: Record<string, string[]> = {
  Filters: [
    "Muffle",
    "Low Pass",
    "High Pass",
    "EQ",
    "Band Pass",
    "Notch",
    "Comb Filter",
    "Resonator",
    "Formant Filter",
    "Wah",
    "Auto Wah",
    "Filter Sweep",
    "Phaser",
  ],
  Dynamics: [
    "Gain",
    "Compressor",
    "Limiter",
    "Expander",
    "Noise Gate",
    "Transient Shaper",
    "De-Esser",
  ],
  Distortion: [
    "Overdrive",
    "Fuzz",
    "Soft Clipping",
    "Hard Clipping",
    "Wavefolding",
    "Rectification",
  ],
  "Lo-fi": ["Bitcrusher", "Sample Rate Reduction", "Aliasing", "Vinyl Simulation"],
  "Pitch/modulation": [
    "Detune",
    "Pitch Shift",
    "Vibrato",
    "Frequency Shifter",
    "Chorus",
    "Flanger",
    "Tremolo",
    "Ring Modulation",
    "Rotary Speaker",
    "Unison",
  ],
  "Delay/reverb": [
    "Echo",
    "Ping Pong Delay",
    "Multitap Delay",
    "Reverb",
    "Spring Reverb",
    "Gated Reverb",
  ],
  Stereo: [
    "Pan",
    "Monoize",
    "Auto Pan",
    "Stereo Width",
    "Stereo Rotation",
    "Mid/Side Processing",
    "3D Panning",
  ],
  Voice: ["Vocal Doubling"],
};
const parameter = (
  key: string,
  label: string,
  min: number,
  max: number,
  value: number,
  unit = "",
  step = 0.01,
): ParameterDefinition => ({ key, label, min, max, value, unit, step });
const rate = parameter("rate", "Rate", 0.01, 20, 2, "Hz");
const depth = parameter("depth", "Depth", 0, 100, 50, "%");
const frequency = parameter("frequency", "Frequency", 20, 20_000, 1200, "Hz", 1);
const feedback = parameter("feedback", "Feedback", 0, 95, 30, "%");
const drive = parameter("drive", "Drive", 0, 40, 6, "dB");
const threshold = parameter("threshold", "Threshold", -80, 0, -12, "dB");
const attack = parameter("attack", "Attack", 0, 1, 0.005, "s");
const release = parameter("release", "Release", 0.001, 5, 0.2, "s");
const time = parameter("time", "Time", 0.001, 4, 0.25, "s");
export const EFFECT_PARAMETERS: Record<string, ParameterDefinition[]> = {
  Gain: [parameter("gain", "Gain", -24, 24, 0, "dB", 0.1)],
  Muffle: [depth, frequency],
  "Low Pass": [frequency, parameter("resonance", "Resonance", 0.1, 20, 0.7)],
  "High Pass": [frequency, parameter("resonance", "Resonance", 0.1, 20, 0.7)],
  EQ: [],
  "Band Pass": [frequency],
  Notch: [frequency],
  "Comb Filter": [time, feedback],
  Resonator: [frequency, parameter("damping", "Damping", 0, 100, 40, "%")],
  "Formant Filter": [
    parameter("vowel", "Vowel", 0, 4, 0, "", 1),
    parameter("morph", "Morph", 0, 100, 0, "%"),
  ],
  Wah: [frequency],
  "Auto Wah": [
    parameter("sensitivity", "Sensitivity", 0, 100, 50, "%"),
    attack,
    release,
    frequency,
  ],
  "Filter Sweep": [
    frequency,
    parameter("endFrequency", "End cutoff", 20, 20_000, 200, "Hz", 1),
    time,
  ],
  Phaser: [rate, depth, frequency, feedback],
  Compressor: [
    threshold,
    parameter("ratio", "Ratio", 1, 20, 4),
    attack,
    release,
    parameter("makeup", "Makeup gain", 0, 24, 0, "dB"),
  ],
  Limiter: [parameter("ceiling", "Ceiling", -24, 0, -0.5, "dB"), drive],
  Expander: [threshold, parameter("ratio", "Ratio", 1, 20, 2), attack, release],
  "Noise Gate": [threshold, attack, release],
  "Transient Shaper": [
    parameter("attackAmount", "Attack amount", -100, 100, 0, "%"),
    parameter("sustainAmount", "Sustain amount", -100, 100, 0, "%"),
  ],
  "De-Esser": [frequency, threshold, depth],
  Overdrive: [drive],
  Fuzz: [drive, parameter("bias", "Bias", -1, 1, 0)],
  "Soft Clipping": [drive],
  "Hard Clipping": [drive, threshold],
  Wavefolding: [
    drive,
    parameter("folds", "Fold count", 1, 16, 2, "", 1),
    parameter("bias", "Bias", -1, 1, 0),
  ],
  Rectification: [{ ...parameter("mode", "Mode", 0, 1, 1), options: ["Half", "Full"] }],
  Bitcrusher: [parameter("bits", "Bit depth", 1, 24, 8, "bits", 1)],
  "Sample Rate Reduction": [parameter("sampleRate", "Effective rate", 100, 48_000, 8000, "Hz", 1)],
  Aliasing: [],
  "Vinyl Simulation": [parameter("noise", "Noise", 0, 100, 5, "%")],
  Detune: [parameter("cents", "Cents", -100, 100, 10, "cents")],
  Vibrato: [
    parameter("cents", "Depth", 0, 200, 20, "cents"),
    rate,
    parameter("delay", "Onset delay", 0, 4, 0, "s"),
  ],
  "Frequency Shifter": [parameter("shift", "Shift", -2000, 2000, 20, "Hz")],
  Chorus: [parameter("amount", "Chorus", 0, 100, 100, "%", 1)],
  Flanger: [time, rate, depth, feedback],
  Tremolo: [rate, depth, parameter("phase", "Phase", 0, 360, 0, "°")],
  "Ring Modulation": [frequency, depth],
  "Rotary Speaker": [rate, depth, parameter("spread", "Spread", 0, 100, 70, "%")],
  Unison: [
    parameter("voices", "Voices", 1, 8, 2, "", 1),
    parameter("cents", "Detune", 0, 100, 12, "cents"),
    parameter("interval", "Interval", -24, 24, 0, "semitones"),
    parameter("spread", "Spread", 0, 100, 70, "%"),
  ],
  Echo: [time, feedback, parameter("damping", "Damping", 20, 20_000, 5000, "Hz")],
  "Ping Pong Delay": [time, feedback, parameter("damping", "Damping", 20, 20_000, 5000, "Hz")],
  "Multitap Delay": [time, feedback, parameter("taps", "Taps", 1, 8, 3, "", 1)],
  Reverb: [
    parameter("decay", "Decay", 0.05, 15, 2, "s"),
    parameter("damping", "Damping", 20, 20_000, 5000, "Hz"),
  ],
  "Spring Reverb": [
    parameter("tension", "Tension", 0, 100, 50, "%"),
    parameter("decay", "Decay", 0.05, 15, 2, "s"),
  ],
  "Gated Reverb": [
    parameter("decay", "Decay", 0.05, 15, 2, "s"),
    parameter("hold", "Gate hold", 0.01, 2, 0.3, "s"),
  ],
  Pan: [
    parameter("position", "Position", -100, 100, 0, "%"),
    { ...parameter("mode", "Mode", 0, 2, 0), options: ["Stereo", "Split Stereo", "Mono"] },
  ],
  Monoize: [],
  "Auto Pan": [
    rate,
    depth,
    parameter("center", "Center", -100, 100, 0, "%"),
    parameter("phase", "Phase", 0, 360, 0, "°"),
  ],
  "Stereo Width": [parameter("width", "Width", 0, 200, 100, "%")],
  "Stereo Rotation": [parameter("angle", "Angle", -180, 180, 0, "°"), depth],
  "Mid/Side Processing": [
    parameter("midGain", "Mid gain", -24, 24, 0, "dB"),
    parameter("sideGain", "Side gain", -24, 24, 0, "dB"),
  ],
  "3D Panning": [parameter("azimuth", "Azimuth", -180, 180, 0, "°")],
  "Pitch Shift": [parameter("interval", "Interval", -12, 12, 0, "semitones")],
  "Vocal Doubling": [
    parameter("voices", "Copies", 1, 8, 2, "", 1),
    parameter("cents", "Detune", 0, 100, 10, "cents"),
  ],
};
export const TEMPO_DELAY_EFFECTS = new Set(["Echo", "Ping Pong Delay", "Multitap Delay"]);
for (const name of TEMPO_DELAY_EFFECTS) {
  required(EFFECT_PARAMETERS[name]).unshift({
    ...parameter("timeBasis", "Timing", 0, 1, 0),
    options: ["Seconds", "Beats"],
  });
}
// Low/high-pass filters expose cutoff, resonance and slope; rate effects support phase
// and tempo sync where applicable, and feedback effects retain tail level and damping.
for (const name of ["Low Pass", "High Pass"]) {
  required(EFFECT_PARAMETERS[name]).push(parameter("slope", "Slope", 12, 48, 12, "dB/oct", 12));
}
required(EFFECT_PARAMETERS["Phaser"]).push(parameter("stages", "Stages", 2, 12, 4, "", 1));
required(EFFECT_PARAMETERS["Formant Filter"]).push(parameter("width", "Width", 0.5, 20, 4));
required(EFFECT_PARAMETERS["Wah"]).push(parameter("resonance", "Resonance", 0.1, 20, 4));
required(EFFECT_PARAMETERS["Auto Wah"]).push(parameter("resonance", "Resonance", 0.1, 20, 4));
for (const name of ["Tremolo", "Vibrato", "Flanger", "Phaser", "Auto Pan", "Rotary Speaker"]) {
  required(EFFECT_PARAMETERS[name]).push({
    ...parameter("sync", "Clock", 0, 1, 0),
    options: ["Hz", "Cycles per beat"],
  });
  if (!required(EFFECT_PARAMETERS[name]).some((item) => item.key === "phase")) {
    required(EFFECT_PARAMETERS[name]).push(parameter("phase", "Phase", 0, 360, 0, "°"));
  }
}
for (const name of ["Pan", "Auto Pan", "3D Panning"]) {
  if (!required(EFFECT_PARAMETERS[name]).some((item) => item.key === "mode")) {
    required(EFFECT_PARAMETERS[name]).push({
      ...parameter("mode", "Mode", 0, 2, 0),
      options: ["Stereo", "Split Stereo", "Mono"],
    });
  }
  required(EFFECT_PARAMETERS[name]).push(
    parameter("left", "Left destination", -100, 100, -100, "%"),
    parameter("right", "Right destination", -100, 100, 100, "%"),
  );
}
export const createEffect = (type: string): Effect => {
  const parameters: Record<string, ParameterValue> = {};
  for (const item of EFFECT_PARAMETERS[type] ?? []) {
    parameters[item.key] = item.options?.[item.value] ?? item.value;
  }
  if (type === "EQ") {
    parameters["bandCount"] = 0;
  }
  return { id: instrumentId("effect"), type, enabled: true, parameters };
};
export const sineCycle = (): number[] =>
  Array.from({ length: 64 }, (_, i): number => Math.round(Math.sin((i * Math.PI) / 32) * 24));
export const createEnvelope = (): Envelope => {
  return {
    id: instrumentId("envelope"),
    target: "volume",
    type: "None",
    speed: 1,
    a: 1,
    b: 0,
    timeBasis: "beats",
    clock: "song synchronized",
    phase: 0,
    duty: 0.5,
    attack: 0.01,
    decay: 0.2,
    sustain: 0.7,
    release: 0.2,
    enabled: true,
  };
};
export const createFMOperator = (index = 0): FMOperator => ({
  id: instrumentId("operator"),
  ratio: index === 0 ? 1 : index + 1,
  offset: 0,
  amplitude: index === 0 ? 1 : 0.25,
  coarse: 0,
  fine: 0,
  pan: 0,
  phase: 0,
  stereoPhase: 0,
  stereoDetune: 0,
  invert: false,
  carrier: index === 0,
  wave: "sine",
  pulseWidth: 0.5,
  customWave: sineCycle(),
});
export const createInstrument = (type = "chip wave", preset = ""): Instrument => {
  const operators = Array.from({ length: 4 }, (_, index) => createFMOperator(index));
  return {
    id: instrumentId("instrument"),
    name: preset || type,
    type,
    preset,
    volume: 0.8,
    wave: "square",
    noise: "retro",
    attack: 0.003,
    release: 0.08,
    sustain: 0.7,
    transition: "normal",
    chords: "simultaneous",
    arpeggioSpeed: 1,
    fastTwoNote: false,
    effects: [],
    envelopes: [],
    harmonics: Array.from({ length: 28 }, (_, i): number => (i < 8 ? 1 / (i + 1) : 0)),
    spectrum: Array.from({ length: 30 }, (_, i): number => Math.max(0, 1 - i / 30)),
    customWave: sineCycle(),
    operators,
    connections: operators
      .slice(1)
      .map((operator) => ({ from: operator.id, to: required(operators[0]).id })),
    feedback: [],
    feedbackVolume: 0,
    phaseRandomness: 0,
    drums: Array.from({ length: 12 }, (): Instrument["drums"][number] => ({
      spectrum: Array.from({ length: 30 }, (_, i): number => Math.max(0, 1 - i / 30)),
      envelope: { ...createEnvelope(), type: "Decay", speed: 5 },
    })),
    dynamism: 0.5,
    spread: 0.2,
    pulseWidth: 0.5,
    shape: 0,
    presetEffects: true,
    resourceId: "",
    bank: 0,
    program: 0,
  };
};
const instantiatePreset = (definition: Partial<Instrument>): Partial<Instrument> => {
  const preset = structuredClone(definition);
  // Envelope targets and FM edges refer to IDs local to the preset definition.
  const ids = new Map<string, string>();
  const assignId = (item: Effect | FMOperator, prefix: "effect" | "operator"): void => {
    const id = instrumentId(prefix);
    ids.set(item.id, id);
    item.id = id;
  };

  for (const effect of preset.effects ?? []) {
    assignId(effect, "effect");
    if (effect.type === "EQ") {
      const points = effectFilterPoints(effect);
      for (const point of points) {
        point.id = crypto.randomUUID();
      }
      setEffectFilterPoints(effect, points);
    }
  }
  for (const operator of preset.operators ?? []) {
    assignId(operator, "operator");
  }
  for (const edge of [...(preset.connections ?? []), ...(preset.feedback ?? [])]) {
    edge.from = required(ids.get(edge.from));
    edge.to = required(ids.get(edge.to));
  }
  for (const envelope of [
    ...(preset.envelopes ?? []),
    ...(preset.drums ?? []).map((drum) => drum.envelope),
  ]) {
    envelope.id = instrumentId("envelope");
    const [kind, id, field] = envelope.target.split(":");
    if (kind === "effect" || kind === "operator") {
      envelope.target = `${kind}:${required(ids.get(required(id)))}:${required(field)}`;
    }
  }
  return preset;
};

export const presetInstrument = (name: string, previous?: Instrument): Instrument => {
  const result = createInstrument("chip wave", name);
  if (Object.hasOwn(PRESET_DEFINITIONS, name)) {
    Object.assign(result, instantiatePreset(required(PRESET_DEFINITIONS[name])));
  }
  if (previous) {
    result.id = previous.id;
    result.volume = previous.volume;
    result.presetEffects = previous.presetEffects;
  }
  return result;
};

export const validFMGraph = (operators: FMOperator[], connections: FMConnection[]): boolean => {
  if (
    operators.length === 0 ||
    operators.length > 10 ||
    !operators.some((operator) => operator.carrier)
  ) {
    return false;
  }
  const ids = new Set(operators.map((operator) => operator.id));
  if (
    ids.size !== operators.length ||
    ids.has("") ||
    new Set(connections.map((edge) => `${edge.from}:${edge.to}`)).size !== connections.length ||
    connections.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))
  ) {
    return false;
  }
  const active = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) {
      return false;
    }
    if (done.has(id)) {
      return true;
    }
    active.add(id);
    for (const edge of connections) {
      if (edge.to === id && !visit(edge.from)) {
        return false;
      }
    }
    active.delete(id);
    done.add(id);
    return true;
  };
  return operators.every((operator) => visit(operator.id));
};
const numberOrInfinity = (value: unknown): boolean =>
  typeof value === "number" && !Number.isNaN(value);

export const validateEffect = (effect: unknown): boolean =>
  matchesShape(effect, {
    id: "",
    type: "",
    enabled: true,
    parameters: dictionary(
      (value: unknown) =>
        typeof value === "string" || typeof value === "boolean" || Number.isFinite(value),
    ),
  });

const envelopeShape = {
  ...createEnvelope(),
  a: numberOrInfinity,
  b: numberOrInfinity,
  speed: (value: unknown): boolean => typeof value === "number" && value >= 0,
  curve: optional(0),
  law: optional(""),
  delay: optional(0),
  hold: optional(0),
  initialLevel: optional(0),
  terminalLevel: optional(0),
  keyToHold: optional(0),
  keyToDecay: optional(0),
  sf2Modulators: optional([
    { source: 0, destination: 0, amount: 0, amountSource: 0, transform: 0 },
  ]),
};
const instrumentShape = {
  ...createInstrument(),
  effects: [validateEffect],
  envelopes: [envelopeShape],
  drums: [{ spectrum: [0], envelope: envelopeShape }],
  feedback: [{ from: "", to: "" }],
  rootKey: optional(0),
  sampleStart: optional(0),
  loopStart: optional(0),
  loopEnd: optional(0),
  loopMode: optional(""),
  backwards: optional(false),
};

export const validateInstrument = (candidate: unknown): candidate is Instrument => {
  if (
    !matchesShape(candidate, instrumentShape) ||
    candidate === null ||
    typeof candidate !== "object"
  ) {
    return false;
  }
  const item: Record<string, unknown> = Object.fromEntries(Object.entries(candidate));
  if (
    typeof item["type"] !== "string" ||
    !INSTRUMENT_TYPES.includes(item["type"]) ||
    typeof item["volume"] !== "number" ||
    !Number.isFinite(item["volume"]) ||
    item["volume"] < 0 ||
    item["volume"] > MAX_INSTRUMENT_VOLUME
  ) {
    return false;
  }
  const cycle = (samples: unknown): boolean =>
    Array.isArray(samples) &&
    samples.length === 64 &&
    samples.every(
      (sample: unknown) =>
        typeof sample === "number" && Number.isFinite(sample) && sample >= -24 && sample <= 24,
    );
  if (!cycle(item["customWave"])) {
    return false;
  }
  if (
    !Array.isArray(item["operators"]) ||
    !Array.isArray(item["connections"]) ||
    !Array.isArray(item["feedback"])
  ) {
    return false;
  }
  const inRange = (value: unknown, min: number, max: number): boolean =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  const validOperator = (value: unknown): value is FMOperator => {
    if (value === null || typeof value !== "object") {
      return false;
    }
    const raw: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    return (
      typeof raw["id"] === "string" &&
      raw["id"].length > 0 &&
      typeof raw["carrier"] === "boolean" &&
      typeof raw["invert"] === "boolean" &&
      typeof raw["wave"] === "string" &&
      FM_WAVES.includes(raw["wave"]) &&
      inRange(raw["ratio"], 0, 100) &&
      inRange(raw["offset"], -20_000, 20_000) &&
      inRange(raw["amplitude"], 0, 1) &&
      inRange(raw["coarse"], -48, 48) &&
      inRange(raw["fine"], -100, 100) &&
      inRange(raw["pan"], -1, 1) &&
      inRange(raw["phase"], 0, 360) &&
      inRange(raw["stereoPhase"], -180, 180) &&
      inRange(raw["stereoDetune"], -100, 100) &&
      inRange(raw["pulseWidth"], 0.01, 0.99) &&
      cycle(raw["customWave"])
    );
  };
  const validConnection = (value: unknown): value is FMConnection => {
    if (value === null || typeof value !== "object") {
      return false;
    }
    const raw: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    return typeof raw["from"] === "string" && typeof raw["to"] === "string";
  };
  const operators: unknown[] = item["operators"];
  const connections: unknown[] = item["connections"];
  const feedbackEdges: unknown[] = item["feedback"];
  if (
    !operators.every(validOperator) ||
    !connections.every(validConnection) ||
    !feedbackEdges.every(validConnection)
  ) {
    return false;
  }
  const ids = new Set(operators.map((operator) => operator.id));
  return (
    validFMGraph(operators, connections) &&
    feedbackEdges.every((edge) => ids.has(edge.from) && ids.has(edge.to)) &&
    new Set(feedbackEdges.map((edge) => `${edge.from}:${edge.to}`)).size === feedbackEdges.length &&
    inRange(item["feedbackVolume"], 0, 1) &&
    inRange(item["phaseRandomness"], 0, 1) &&
    Array.isArray(item["effects"]) &&
    Array.isArray(item["envelopes"])
  );
};
