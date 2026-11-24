// FM routing and feedback adapted from UltraBox (MIT), revision
// 91b4bc1988e605ba5f5009f557e52ccb33975754. See ../../license/ultrabox-MIT.txt.
// Carriers are independent stereo oscillators with linear levels.
import type { FMOperator, Instrument } from "../instruments";
import { required } from "../model";
import { classifyWave, prepareWaveform, sampleWaveform } from "./waves";
import type { Waveform } from "./waves";

type ParameterTargets = Pick<ReadonlySet<string>, "has">;
type Stereo = [number, number];
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
const advancePhase = (phase: number, step: number): number => {
  const next = phase + step;
  return next >= 0 && next < 1 ? next : next % 1;
};
export const fmAmplitudeCurve = (amplitude: number): number =>
  (16 ** clamp(amplitude, 0, 1) - 1) / 15;

type CompiledOperator = {
  operator: FMOperator;
  wave: string;
  waveform: Waveform;
  modulators: number[];
  feedback: number[];
  modulationSources: Stereo[];
  feedbackSources: Stereo[];
  phase: Stereo;
  raw: Stereo;
  scaled: Stereo;
  output: Stereo;
  random: number;
  preparedSign: number;
  targets: {
    coarse: string | undefined;
    fine: string | undefined;
    offset: string | undefined;
    ratio: string | undefined;
    stereoDetune: string | undefined;
    pulseWidth: string | undefined;
    amplitude: string | undefined;
    pan: string | undefined;
  };
  tuningCents: number;
  tuningMultiplier: number;
  baseFrequency: number;
  ratio: number;
  offset: number;
  ratioEnvelope: number;
  tuned: number;
  detune: number;
  detuneLeft: number;
  detuneRight: number;
  amplitude: number;
  amplitudeCurve: number;
  level: number;
  pan: number;
  panLeft: number;
  panRight: number;
};
type PreparedOperator = {
  compiled: CompiledOperator;
  initialPhase: number;
  stereoPhase: number;
  leftStep: number;
  rightStep: number;
  sampleLeft: (phase: number) => number;
  sampleRight: (phase: number) => number;
  sharesWaveform: boolean;
};
export type FMVoiceState = {
  instrument: Instrument | null;
  parameterTargets: ParameterTargets | undefined;
  feedbackEnvelope: boolean;
  operators: CompiledOperator[];
  order: number[];
  renderOrder: CompiledOperator[];
  phases: Stereo[];
  raw: Stereo[];
  scaled: Stereo[];
  output: Stereo[];
  random: number[];
  constantControls: boolean;
  preparedBlock: number;
  preparedFrequency: number;
  preparedSampleRate: number;
  preparedFeedback: number;
  preparedMono: boolean;
  preparedOperators: PreparedOperator[];
  preparedCarriers: CompiledOperator[];
};
export const createFMVoice = (random: number[] = []): FMVoiceState => ({
  instrument: null,
  parameterTargets: undefined,
  feedbackEnvelope: true,
  operators: [],
  order: [],
  renderOrder: [],
  phases: [],
  raw: [],
  scaled: [],
  output: [],
  random: [...random],
  constantControls: false,
  preparedBlock: 0,
  preparedFrequency: 0,
  preparedSampleRate: 0,
  preparedFeedback: 0,
  preparedMono: false,
  preparedOperators: [],
  preparedCarriers: [],
});

// Normal routes are a DAG. Feedback reads raw outputs in evaluation order:
// an already evaluated source supplies this sample, otherwise the previous one.
const compile = (
  instrument: Instrument,
  state: FMVoiceState,
  parameterTargets: ParameterTargets | undefined,
): void => {
  const target = (key: string): string | undefined =>
    parameterTargets === undefined || parameterTargets.has(key) ? key : undefined;
  const indices = new Map(instrument.operators.map((op, i) => [op.id, i]));
  const oldStates = new Map(
    state.operators.map((op, i) => [
      op.operator.id,
      {
        phase: state.phases[i],
        raw: state.raw[i],
        random: state.random[i],
      },
    ]),
  );
  const sources = (edges: Instrument["connections"], id: string): number[] =>
    edges
      .filter((edge) => edge.to === id)
      .flatMap((edge) => {
        const index = indices.get(edge.from);
        return index === undefined ? [] : [index];
      });
  // Retain phase, raw feedback and random seeds by identity; routing arrays are
  // rebound after every graph edit without changing the note-start draw order.
  const initialRandom = state.instrument === null ? state.random : [];
  state.operators = instrument.operators.map((operator, index) => ({
    operator,
    wave: operator.wave,
    waveform: classifyWave(operator.wave),
    modulators: sources(instrument.connections, operator.id),
    feedback: sources(instrument.feedback, operator.id),
    modulationSources: [],
    feedbackSources: [],
    phase: oldStates.get(operator.id)?.phase ?? [0, 0],
    raw: oldStates.get(operator.id)?.raw ?? [0, 0],
    scaled: [0, 0],
    output: [0, 0],
    random: oldStates.get(operator.id)?.random ?? initialRandom[index] ?? Math.random(),
    preparedSign: 1,
    targets: {
      coarse: target(`operator:${operator.id}:coarse`),
      fine: target(`operator:${operator.id}:fine`),
      offset: target(`operator:${operator.id}:offset`),
      ratio: target(`operator:${operator.id}:ratio`),
      stereoDetune: target(`operator:${operator.id}:stereoDetune`),
      pulseWidth: target(`operator:${operator.id}:pulseWidth`),
      amplitude: target(`operator:${operator.id}:amplitude`),
      pan: target(`operator:${operator.id}:pan`),
    },
    tuningCents: Number.NaN,
    tuningMultiplier: 0,
    baseFrequency: Number.NaN,
    ratio: Number.NaN,
    offset: Number.NaN,
    ratioEnvelope: Number.NaN,
    tuned: 0,
    detune: Number.NaN,
    detuneLeft: 0,
    detuneRight: 0,
    amplitude: Number.NaN,
    amplitudeCurve: 0,
    level: 0,
    pan: Number.NaN,
    panLeft: 0,
    panRight: 0,
  }));
  const visited = new Set<number>();
  state.order = [];
  const visit = (index: number): void => {
    if (visited.has(index)) {
      return;
    }
    visited.add(index);
    for (const source of required(state.operators[index]).modulators) {
      visit(source);
    }
    state.order.push(index);
  };
  for (let i = state.operators.length - 1; i >= 0; i--) {
    visit(i);
  }
  state.phases = state.operators.map((op) => op.phase);
  state.raw = state.operators.map((op) => op.raw);
  state.random = state.operators.map((op) => op.random);
  state.scaled = state.operators.map((op) => op.scaled);
  state.output = state.operators.map((op) => op.output);
  state.renderOrder = state.order.map((index) => required(state.operators[index]));
  for (const operator of state.operators) {
    operator.modulationSources = operator.modulators.map(
      (index) => required(state.operators[index]).scaled,
    );
    operator.feedbackSources = operator.feedback.map(
      (index) => required(state.operators[index]).raw,
    );
  }
  state.instrument = instrument;
  state.parameterTargets = parameterTargets;
  state.feedbackEnvelope = target("feedbackVolume") !== undefined;
  state.constantControls =
    !state.feedbackEnvelope &&
    state.operators.every((operator) =>
      Object.values(operator.targets).every((value) => value === undefined),
    );
  state.preparedBlock = 0;
  state.preparedOperators = [];
  state.preparedCarriers = [];
};

// A synchronous render block cannot receive saved-control edits. Dynamic pitch
// still invalidates this preparation, and any bound FM envelope uses sampleFM's
// general path. The oscillator arithmetic below stays identical to that path.
const prepareBlock = (
  instrument: Instrument,
  state: FMVoiceState,
  frequency: number,
  sampleRate: number,
  block: number,
  feedback: number,
): void => {
  state.preparedBlock = block;
  state.preparedFrequency = frequency;
  state.preparedSampleRate = sampleRate;
  state.preparedFeedback = feedback;
  state.preparedMono = true;
  for (let index = 0; index < state.renderOrder.length; index++) {
    const compiled = required(state.renderOrder[index]);
    const { operator, waveform } = compiled;
    const leftFrequency = compiled.tuned * compiled.detuneLeft;
    const rightFrequency = compiled.tuned * compiled.detuneRight;
    const sampleLeft = prepareWaveform(
      waveform,
      leftFrequency,
      sampleRate,
      operator.pulseWidth,
      operator.customWave,
    );
    const sampleRight =
      leftFrequency === rightFrequency
        ? sampleLeft
        : prepareWaveform(
            waveform,
            rightFrequency,
            sampleRate,
            operator.pulseWidth,
            operator.customWave,
          );
    let control = state.preparedOperators[index];
    if (!control) {
      control = {
        compiled,
        initialPhase: 0,
        stereoPhase: 0,
        leftStep: 0,
        rightStep: 0,
        sampleLeft,
        sampleRight,
        sharesWaveform: false,
      };
      state.preparedOperators[index] = control;
    }
    control.initialPhase = operator.phase / 360 + compiled.random * instrument.phaseRandomness;
    control.stereoPhase = operator.stereoPhase / 360;
    control.leftStep = leftFrequency / sampleRate;
    control.rightStep = rightFrequency / sampleRate;
    control.sampleLeft = sampleLeft;
    control.sampleRight = sampleRight;
    control.sharesWaveform = waveform !== "noise" && leftFrequency === rightFrequency;
    compiled.preparedSign = operator.invert ? -1 : 1;
    state.preparedMono &&=
      control.sharesWaveform &&
      control.stereoPhase === 0 &&
      compiled.phase[0] === compiled.phase[1];
  }
  state.preparedCarriers.length = 0;
  for (const compiled of state.operators) {
    if (compiled.operator.carrier) {
      state.preparedCarriers.push(compiled);
    }
  }
};
const mixPreparedCarriers = (state: FMVoiceState, result: Stereo, mono: boolean): Stereo => {
  let left = 0;
  let right = 0;
  for (const { raw, preparedSign, level, panLeft, panRight } of state.preparedCarriers) {
    const leftLevel = raw[0] * preparedSign * level;
    const rightLevel = mono ? leftLevel : raw[1] * preparedSign * level;
    left += leftLevel * panLeft;
    right += rightLevel * panRight;
  }
  result[0] = left;
  result[1] = right;
  return result;
};
const samplePreparedMono = (state: FMVoiceState, result: Stereo): Stereo => {
  for (const control of state.preparedOperators) {
    const { compiled } = control;
    const { phase, raw, scaled, preparedSign: sign } = compiled;
    let at = phase[0] + control.initialPhase;
    for (const source of compiled.modulationSources) {
      at += source[0];
    }
    for (const source of compiled.feedbackSources) {
      at += state.preparedFeedback * source[0];
    }
    const sample = control.sampleLeft(at);
    raw[0] = sample;
    raw[1] = sample;
    const modulation = sample * sign * compiled.amplitudeCurve * 1.5;
    scaled[0] = modulation;
    scaled[1] = modulation;
    const next = advancePhase(phase[0], control.leftStep);
    phase[0] = next;
    phase[1] = next;
  }
  return mixPreparedCarriers(state, result, true);
};
const samplePrepared = (state: FMVoiceState, result: Stereo): Stereo => {
  for (const control of state.preparedOperators) {
    const { compiled, initialPhase, stereoPhase, sampleLeft, sampleRight, sharesWaveform } =
      control;
    const { phase, raw, scaled, modulationSources, feedbackSources, preparedSign: sign } = compiled;
    let leftPhase = phase[0] + initialPhase;
    let rightPhase = phase[1] + initialPhase + stereoPhase;
    for (const source of modulationSources) {
      leftPhase += source[0];
      rightPhase += source[1];
    }
    for (const source of feedbackSources) {
      leftPhase += state.preparedFeedback * source[0];
      rightPhase += state.preparedFeedback * source[1];
    }
    const leftSample = sampleLeft(leftPhase);
    const rightSample =
      sharesWaveform && leftPhase === rightPhase ? leftSample : sampleRight(rightPhase);
    raw[0] = leftSample;
    raw[1] = rightSample;
    scaled[0] = raw[0] * sign * compiled.amplitudeCurve * 1.5;
    scaled[1] = raw[1] * sign * compiled.amplitudeCurve * 1.5;
    phase[0] = advancePhase(phase[0], control.leftStep);
    phase[1] = advancePhase(phase[1], control.rightStep);
  }
  return mixPreparedCarriers(state, result, false);
};

type Parameter = (target: string, base: number) => number;
export const sampleFM = (
  instrument: Instrument,
  state: FMVoiceState,
  frequency: number,
  sampleRate: number,
  parameter: Parameter = (_target, base) => base,
  parameterTargets?: ParameterTargets,
  block = 0,
  result: Stereo = [0, 0],
): Stereo => {
  if (state.instrument !== instrument || state.parameterTargets !== parameterTargets) {
    compile(instrument, state, parameterTargets);
  }
  const fixed = block > 0 && state.constantControls;
  if (
    fixed &&
    state.preparedBlock === block &&
    state.preparedFrequency === frequency &&
    state.preparedSampleRate === sampleRate
  ) {
    return state.preparedMono ? samplePreparedMono(state, result) : samplePrepared(state, result);
  }
  state.preparedBlock = 0;
  // Known bindings let saved controls bypass envelope lookup entirely. Callers
  // without bindings retain the general callback behavior for every control.
  const feedback =
    clamp(
      state.feedbackEnvelope
        ? parameter("feedbackVolume", instrument.feedbackVolume)
        : instrument.feedbackVolume,
      0,
      1,
    ) * 0.3;
  for (const compiled of state.renderOrder) {
    const { operator, modulationSources, feedbackSources, targets, phase, raw, scaled, output } =
      compiled;
    const coarse =
      targets.coarse === undefined ? operator.coarse : parameter(targets.coarse, operator.coarse);
    const fine =
      targets.fine === undefined ? operator.fine : parameter(targets.fine, operator.fine);
    const tuningCents = coarse + fine / 100;
    if (compiled.tuningCents !== tuningCents) {
      compiled.tuningCents = tuningCents;
      compiled.tuningMultiplier = 2 ** (tuningCents / 12);
    }
    const baseFrequency = frequency * compiled.tuningMultiplier;
    const offset =
      targets.offset === undefined ? operator.offset : parameter(targets.offset, operator.offset);
    const ratioEnvelope = targets.ratio === undefined ? 1 : parameter(targets.ratio, 1);
    // Evaluate envelopes every sample; reuse expensive transforms while their controls stay fixed.
    if (
      compiled.baseFrequency !== baseFrequency ||
      compiled.ratio !== operator.ratio ||
      compiled.offset !== offset ||
      compiled.ratioEnvelope !== ratioEnvelope
    ) {
      compiled.baseFrequency = baseFrequency;
      compiled.ratio = operator.ratio;
      compiled.offset = offset;
      compiled.ratioEnvelope = ratioEnvelope;
      const targetFrequency = baseFrequency * operator.ratio + offset;
      compiled.tuned =
        baseFrequency === 0
          ? Math.max(0, targetFrequency)
          : baseFrequency * Math.max(0, targetFrequency / baseFrequency) ** ratioEnvelope;
    }
    const detune =
      targets.stereoDetune === undefined
        ? operator.stereoDetune
        : parameter(targets.stereoDetune, operator.stereoDetune);
    if (compiled.detune !== detune) {
      compiled.detune = detune;
      const bounded = clamp(detune, -100, 100);
      compiled.detuneLeft = 2 ** (-bounded / 2400);
      compiled.detuneRight = 2 ** (bounded / 2400);
    }
    const width =
      targets.pulseWidth === undefined
        ? operator.pulseWidth
        : parameter(targets.pulseWidth, operator.pulseWidth);
    const amplitude =
      targets.amplitude === undefined
        ? operator.amplitude
        : parameter(targets.amplitude, operator.amplitude);
    if (compiled.amplitude !== amplitude) {
      compiled.amplitude = amplitude;
      const bounded = clamp(amplitude, 0, 1);
      compiled.amplitudeCurve = fmAmplitudeCurve(bounded);
      compiled.level = bounded / 3;
    }
    const sign = operator.invert ? -1 : 1;
    const initialPhase = operator.phase / 360 + compiled.random * instrument.phaseRandomness;
    const leftFrequency = compiled.tuned * compiled.detuneLeft;
    const rightFrequency = compiled.tuned * compiled.detuneRight;
    let leftPhase = phase[0] + initialPhase;
    let rightPhase = phase[1] + initialPhase + operator.stereoPhase / 360;
    for (const source of modulationSources) {
      leftPhase += source[0];
      rightPhase += source[1];
    }
    for (const source of feedbackSources) {
      leftPhase += feedback * source[0];
      rightPhase += feedback * source[1];
    }
    if (compiled.wave !== operator.wave) {
      compiled.wave = operator.wave;
      compiled.waveform = classifyWave(operator.wave);
    }
    const leftSample = sampleWaveform(
      compiled.waveform,
      leftPhase,
      leftFrequency,
      sampleRate,
      width,
      operator.customWave,
    );
    // Identical periodic oscillator inputs share one evaluation. Keep separate
    // noise draws and compare the actual phases so stereo edits retain history.
    const rightSample =
      leftPhase === rightPhase && leftFrequency === rightFrequency && compiled.waveform !== "noise"
        ? leftSample
        : sampleWaveform(
            compiled.waveform,
            rightPhase,
            rightFrequency,
            sampleRate,
            width,
            operator.customWave,
          );
    // Feedback taps the waveform before its level and polarity controls.
    raw[0] = leftSample;
    raw[1] = rightSample;
    // An operator can be audible and also modulate another operator. Use the
    // same phase depth regardless of whether its carrier switch is enabled.
    scaled[0] = raw[0] * sign * compiled.amplitudeCurve * 1.5;
    scaled[1] = raw[1] * sign * compiled.amplitudeCurve * 1.5;
    phase[0] = advancePhase(phase[0], leftFrequency / sampleRate);
    phase[1] = advancePhase(phase[1], rightFrequency / sampleRate);
    // Carrier gain and pan only affect the output, never modulation routing.
    output[0] = raw[0] * sign * compiled.level;
    output[1] = raw[1] * sign * compiled.level;
  }
  let left = 0;
  let right = 0;
  // Sum in operator order with fixed one-third headroom.
  for (const compiled of state.operators) {
    const { operator, targets, output } = compiled;
    if (!operator.carrier) {
      continue;
    }
    const pan = targets.pan === undefined ? operator.pan : parameter(targets.pan, operator.pan);
    if (compiled.pan !== pan) {
      compiled.pan = pan;
      const bounded = clamp(pan, -1, 1);
      compiled.panLeft = Math.cos((Math.max(0, bounded) * Math.PI) / 2);
      compiled.panRight = Math.cos((Math.max(0, -bounded) * Math.PI) / 2);
    }
    left += output[0] * compiled.panLeft;
    right += output[1] * compiled.panRight;
  }
  if (fixed) {
    // A continuous pitch bend never reuses a prepared oscillator step. Wait for
    // stable pitch before paying for block preparation instead of adding work
    // to every sample of a glide.
    if (state.preparedFrequency === frequency && state.preparedSampleRate === sampleRate) {
      prepareBlock(instrument, state, frequency, sampleRate, block, feedback);
    } else {
      state.preparedFrequency = frequency;
      state.preparedSampleRate = sampleRate;
    }
  }
  result[0] = left;
  result[1] = right;
  return result;
};
