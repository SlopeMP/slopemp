/*!
 * Adapted from UltraBox 91b4bc1988e605ba5f5009f557e52ccb33975754.
 * Copyright (c) 2012-2022 John Nesky and contributing authors.
 * SPDX-License-Identifier: MIT
 * See ../../license/ultrabox-MIT.txt for the full license.
 */
import { required } from "../model";
import {
  type AutomationTarget,
  type Chord,
  Config,
  type Envelope,
  EnvelopeComputeIndex,
  type EnvelopeTiming,
  getArpeggioPitchIndex,
  getPulseWidthRatio,
  InstrumentType,
  integrateWave,
  type Transition,
} from "./config";
import { inverseRealFourierTransform, scaleElementsByFactor } from "./fft";
import { DynamicBiquadFilter, FilterCoefficients, FrequencyResponse } from "./filtering";
import { drawNoiseSpectrum, getDrumWave } from "./noise";
const epsilon = 1e-24;
type SongEnvelopeClock = Omit<EnvelopeTiming, "noteBeats">;
const envelopeTiming = (noteBeats: number, clock: SongEnvelopeClock): EnvelopeTiming => ({
  ...clock,
  noteBeats,
});
export const clamp = (min: number, max: number, val: number): number => {
  const upper = max - 1;
  return Math.max(min, Math.min(upper, val));
};
const fittingPowerOfTwo = (x: number): number => {
  return 1 << (32 - Math.clz32(Math.ceil(x) - 1));
};

const interpolateWaveIntegral = (
  wave: Float32Array,
  waveLength: number,
  waveMask: number,
  phase: number,
): number => {
  const whole = Math.trunc(phase);
  const index = waveMask !== 0 && whole >= 0 ? whole & waveMask : whole % waveLength;
  const start = required(wave[index]);
  return start + (required(wave[index + 1]) - start) * (phase - whole);
};

const wrapSawPhase = (phase: number): number => {
  // Supersaw phases start nonnegative and only advance by positive steps.
  if (phase < 1) {
    return phase;
  }
  return phase < 2 ? phase - 1 : phase % 1;
};

const samplePulse = (phase: number, width: number, step: number): number => {
  const start = phase % 1;
  const end = (phase + width) % 1;
  let sample = end - start;
  if (start < step) {
    const t = start / step;
    sample += (t + t - t * t - 1) * 0.5;
  } else if (start > 1 - step) {
    const t = (start - 1) / step;
    sample += (t + t + t * t + 1) * 0.5;
  }
  if (end < step) {
    const t = end / step;
    sample -= (t + t - t * t - 1) * 0.5;
  } else if (end > 1 - step) {
    const t = (end - 1) / step;
    sample -= (t + t + t * t + 1) * 0.5;
  }
  return sample;
};

const fadeInSettingToSeconds = (setting: number): number => {
  return 0.0125 * (0.95 * setting + 0.05 * setting * setting);
};

const fadeOutSettingToTicks = (setting: number): number => {
  return required(Config.fadeOutTicks[setting]);
};

const noteSizeToVolumeMult = (size: number): number => {
  return (Math.max(0, size) / Config.noteSizeMax) ** 1.5;
};

const instrumentVolumeToVolumeMult = (instrumentVolume: number): number => {
  return instrumentVolume === -Config.volumeRange / 2
    ? 0
    : 2 ** (Config.volumeLogScale * instrumentVolume);
};

const tempFilterStartCoefficients: FilterCoefficients = new FilterCoefficients();

const tempFilterEndCoefficients: FilterCoefficients = new FilterCoefficients();
export type NotePin = {
  interval: number;
  time: number;
  size: number;
};
export const makeNotePin = (interval: number, time: number, size: number): NotePin => {
  return { interval, time, size };
};
export class Note {
  public pitches: number[];

  public pins: NotePin[];

  public start: number;

  public end: number;

  public continuesLastPattern: boolean;

  public constructor(
    pitch: number,
    start: number,
    end: number,
    size: number,
    fadeout: boolean = false,
  ) {
    this.pitches = [pitch];
    this.pins = [makeNotePin(0, 0, size), makeNotePin(0, end - start, fadeout ? 0 : size)];
    this.start = start;
    this.end = end;
    this.continuesLastPattern = false;
  }

  public pickMainInterval(): number {
    let longestFlatIntervalDuration: number = 0;
    let mainInterval: number = 0;
    for (let pinIndex: number = 1; pinIndex < this.pins.length; pinIndex++) {
      const pinA: NotePin = required(this.pins[pinIndex - 1]);
      const pinB: NotePin = required(this.pins[pinIndex]);
      if (pinA.interval === pinB.interval) {
        const duration: number = pinB.time - pinA.time;
        if (longestFlatIntervalDuration < duration) {
          longestFlatIntervalDuration = duration;
          mainInterval = pinA.interval;
        }
      }
    }
    if (longestFlatIntervalDuration === 0) {
      let loudestSize: number = 0;
      for (const element of this.pins) {
        const pin: NotePin = required(element);
        if (loudestSize < pin.size) {
          loudestSize = pin.size;
          mainInterval = pin.interval;
        }
      }
    }
    return mainInterval;
  }

  public getEndPinIndex(part: number): number {
    let endPinIndex = 1;
    for (; endPinIndex < this.pins.length - 1; endPinIndex++) {
      if (required(this.pins[endPinIndex]).time + this.start > part) {
        break;
      }
    }
    return endPinIndex;
  }
}
export class Pattern {
  public notes: Note[] = [];
}
export class SpectrumWave {
  public spectrum: number[] = [];

  public hash: number = -1;

  public constructor(isNoiseChannel: boolean) {
    this.reset(isNoiseChannel);
  }

  public reset(isNoiseChannel: boolean): void {
    for (let i: number = 0; i < Config.spectrumControlPoints; i++) {
      if (isNoiseChannel) {
        this.spectrum[i] = Math.round(Config.spectrumMax * (1 / Math.sqrt(1 + i / 3)));
      } else {
        const isHarmonic: boolean =
          i === 0 ||
          i === 7 ||
          i === 11 ||
          i === 14 ||
          i === 16 ||
          i === 18 ||
          i === 21 ||
          i === 23 ||
          i >= 25;
        this.spectrum[i] = isHarmonic
          ? Math.max(0, Math.round(Config.spectrumMax * (1 - i / 30)))
          : 0;
      }
    }
    this.markCustomWaveDirty();
  }

  public markCustomWaveDirty(): void {
    const hashMult: number = fittingPowerOfTwo(Config.spectrumMax + 2) - 1;
    let hash: number = 0;
    for (const point of this.spectrum) {
      hash = (hash * hashMult + point) >>> 0;
    }
    this.hash = hash;
  }
}
export class SpectrumWaveState {
  public wave: Float32Array | null = null;

  private _hash: number = -1;

  public getCustomWave(settings: SpectrumWave, lowestOctave: number): Float32Array {
    if (this._hash === settings.hash) {
      return required(this.wave);
    }
    this._hash = settings.hash;
    const waveLength: number = Config.spectrumNoiseLength;
    if (this.wave?.length !== waveLength + 1) {
      this.wave = new Float32Array(waveLength + 1);
    }
    const wave: Float32Array = this.wave;
    for (let i: number = 0; i < waveLength; i++) {
      wave[i] = 0;
    }
    const highestOctave: number = 14;
    const falloffRatio: number = 0.25;
    const pitchTweak: number[] = [
      0,
      1 / 7,
      Math.log2(5 / 4),
      3 / 7,
      Math.log2(3 / 2),
      5 / 7,
      6 / 7,
    ];
    const controlPointToOctave = (point: number): number => {
      return (
        lowestOctave +
        Math.floor(point / Config.spectrumControlPointsPerOctave) +
        required(
          pitchTweak[
            (point + Config.spectrumControlPointsPerOctave) % Config.spectrumControlPointsPerOctave
          ],
        )
      );
    };
    let combinedAmplitude: number = 1;
    for (let i: number = 0; i < Config.spectrumControlPoints + 1; i++) {
      const value1: number = required(i <= 0 ? 0 : settings.spectrum[i - 1]);
      const value2: number = required(
        i >= Config.spectrumControlPoints
          ? settings.spectrum[Config.spectrumControlPoints - 1]
          : settings.spectrum[i],
      );
      const octave1: number = controlPointToOctave(i - 1);
      let octave2: number = controlPointToOctave(i);
      if (i >= Config.spectrumControlPoints) {
        octave2 = highestOctave + (octave2 - highestOctave) * falloffRatio;
      }
      if (value1 === 0 && value2 === 0) {
        continue;
      }
      combinedAmplitude +=
        0.02 *
        drawNoiseSpectrum(
          wave,
          waveLength,
          octave1,
          octave2,
          value1 / Config.spectrumMax,
          value2 / Config.spectrumMax,
          -0.5,
        );
    }
    if (required(settings.spectrum[Config.spectrumControlPoints - 1]) > 0) {
      combinedAmplitude +=
        0.02 *
        drawNoiseSpectrum(
          wave,
          waveLength,
          highestOctave +
            (controlPointToOctave(Config.spectrumControlPoints) - highestOctave) * falloffRatio,
          highestOctave,
          required(settings.spectrum[Config.spectrumControlPoints - 1]) / Config.spectrumMax,
          0,
          -0.5,
        );
    }
    inverseRealFourierTransform(wave, waveLength);
    scaleElementsByFactor(wave, 5 / (Math.sqrt(waveLength) * combinedAmplitude ** 0.75));
    wave[waveLength] = required(wave[0]);
    return wave;
  }
}
export class HarmonicsWave {
  public harmonics: number[] = [];

  public hash: number = -1;

  public constructor() {
    this.reset();
  }

  public reset(): void {
    for (let i: number = 0; i < Config.harmonicsControlPoints; i++) {
      this.harmonics[i] = 0;
    }
    this.harmonics[0] = Config.harmonicsMax;
    this.harmonics[3] = Config.harmonicsMax;
    this.harmonics[6] = Config.harmonicsMax;
    this.markCustomWaveDirty();
  }

  public markCustomWaveDirty(): void {
    const hashMult: number = fittingPowerOfTwo(Config.harmonicsMax + 2) - 1;
    let hash: number = 0;
    for (const point of this.harmonics) {
      hash = (hash * hashMult + point) >>> 0;
    }
    this.hash = hash;
  }
}
class HarmonicsWaveState {
  public wave: Float32Array | null = null;

  private _hash: number = -1;

  private _generatedForType: number = 0;

  public getCustomWave(settings: HarmonicsWave, instrumentType: number): Float32Array {
    if (this._hash === settings.hash && this._generatedForType === instrumentType) {
      return required(this.wave);
    }
    this._hash = settings.hash;
    this._generatedForType = instrumentType;
    const harmonicsRendered: number =
      instrumentType === InstrumentType.pickedString
        ? Config.harmonicsRenderedForPickedString
        : Config.harmonicsRendered;
    const waveLength: number = Config.harmonicsWavelength;
    const retroWave: Float32Array = getDrumWave(0);
    if (this.wave?.length !== waveLength + 1) {
      this.wave = new Float32Array(waveLength + 1);
    }
    const wave: Float32Array = this.wave;
    for (let i: number = 0; i < waveLength; i++) {
      wave[i] = 0;
    }
    const overallSlope: number = -0.25;
    let combinedControlPointAmplitude: number = 1;
    for (let harmonicIndex: number = 0; harmonicIndex < harmonicsRendered; harmonicIndex++) {
      const harmonicFreq: number = harmonicIndex + 1;
      let controlValue: number = required(
        harmonicIndex < Config.harmonicsControlPoints
          ? settings.harmonics[harmonicIndex]
          : settings.harmonics[Config.harmonicsControlPoints - 1],
      );
      if (harmonicIndex >= Config.harmonicsControlPoints) {
        controlValue *=
          1 -
          (harmonicIndex - Config.harmonicsControlPoints) /
            (harmonicsRendered - Config.harmonicsControlPoints);
      }
      const normalizedValue: number = controlValue / Config.harmonicsMax;
      let amplitude: number =
        2 ** (controlValue - Config.harmonicsMax + 1) * Math.sqrt(normalizedValue);
      if (harmonicIndex < Config.harmonicsControlPoints) {
        combinedControlPointAmplitude += amplitude;
      }
      amplitude *= harmonicFreq ** overallSlope;
      amplitude *= required(retroWave[harmonicIndex + 589]);
      wave[waveLength - harmonicFreq] = amplitude;
    }
    inverseRealFourierTransform(wave, waveLength);
    const mult: number = 1 / combinedControlPointAmplitude ** 0.7;
    for (let i: number = 0; i < wave.length; i++) {
      wave[i] = required(wave[i]) * mult;
    }
    integrateWave(wave);
    wave[waveLength] = required(wave[0]);
    return wave;
  }
}
const configureDrumFilter = (
  filter: FilterCoefficients,
  sampleRate: number,
  frequencyMultiplier: number,
): void => {
  const frequency = Math.max(
    8,
    Math.min(8000 * 2 ** 1.25, sampleRate * 0.49, frequencyMultiplier * 8000),
  );
  filter.lowPass2ndOrderButterworth((2 * Math.PI * frequency) / sampleRate, 0.5);
};
type EnvelopeSettings = { target: AutomationTarget; index: number; envelope: Envelope };
const noteSizeEnvelope: Envelope = {
  type: "Note Size",
  speed: 0,
  evaluate: (_seconds, _beats, size) => noteSizeToVolumeMult(size),
};
export class Instrument {
  public type: number = InstrumentType.chip;

  public chipWave: number = 2;

  public chipNoise: number = 1;

  public envelopes: EnvelopeSettings[] = [];

  public fadeIn: number = 0;

  public fadeOut: number = Config.fadeOutNeutral;

  public transition: number = required(Config.transitions.dictionary["normal"]).index;

  public songDetuneCents: number = 0;

  public chord: number = 1;

  public volume: number = 0;

  public arpeggioSpeed: number = 12;

  public fastTwoNoteArp: boolean = false;

  public pulseWidth: number = Config.pulseWidthRange;

  public supersawDynamism: number = Config.supersawDynamismMax;

  public supersawSpread: number = Math.ceil(Config.supersawSpreadMax / 2);

  public supersawShape: number = 0;

  public stringSustain: number = 10;

  public readonly spectrumWave: SpectrumWave;

  public readonly harmonicsWave: HarmonicsWave = new HarmonicsWave();

  public drumsetEnvelopes: Envelope[] = [];

  public readonly drumsetSpectrumWaves: SpectrumWave[] = [];

  public constructor() {
    this.spectrumWave = new SpectrumWave(false);
    for (let i: number = 0; i < Config.drumCount; i++) {
      this.drumsetSpectrumWaves[i] = new SpectrumWave(true);
    }
  }

  public static frequencyFromPitch(this: void, pitch: number): number {
    return 440 * 2 ** ((pitch - 69) / 12);
  }

  public addEnvelope(target: AutomationTarget, index: number, envelope: Envelope): void {
    if (this.envelopes.length >= Config.maxEnvelopeCount) {
      throw new Error("Invalid synthesis state.");
    }
    this.envelopes.push(
      this.supportsEnvelopeTarget(target, index)
        ? { target, index, envelope }
        : {
            target: required(Config.instrumentAutomationTargets.dictionary["none"]),
            index: 0,
            envelope,
          },
    );
  }

  public getTransition(): Transition {
    return required(Config.transitions[this.transition]);
  }

  public getFadeInSeconds(): number {
    return this.type === InstrumentType.drumset ? 0 : fadeInSettingToSeconds(this.fadeIn);
  }

  public getFadeOutTicks(): number {
    return this.type === InstrumentType.drumset
      ? Config.drumsetFadeOutTicks
      : fadeOutSettingToTicks(this.fadeOut);
  }

  public getChord(): Chord {
    return required(Config.chords[this.chord]);
  }

  public getDrumsetEnvelope(pitch: number): Envelope {
    if (this.type !== InstrumentType.drumset) {
      throw new Error("Can't getDrumsetEnvelope() for non-drumset.");
    }
    return required(this.drumsetEnvelopes[pitch]);
  }

  private supportsEnvelopeTarget(automationTarget: AutomationTarget, index: number): boolean {
    if (index >= automationTarget.maxCount) {
      return false;
    }
    if (automationTarget.compatibleInstruments?.includes(this.type) === false) {
      return false;
    }
    return true;
  }
}
export class Song {
  public key: number = 0;

  public tempo: number = 0;

  public beatsPerBar: number = 0;

  public barCount: number = 0;

  public loopStart: number = 0;

  public loopLength: number = 0;

  public readonly patterns: Pattern[] = [];

  public readonly instrument: Instrument;
  public readonly bars: number[];

  public constructor(instrument: Instrument, bars: number[]) {
    this.instrument = instrument;
    this.bars = bars;
  }

  public get partsPerPattern(): number {
    return this.beatsPerBar * Config.partsPerBeat;
  }

  public getPattern(bar: number): Pattern | null {
    if (bar < 0 || bar >= this.barCount) {
      return null;
    }
    const patternIndex: number = required(this.bars[bar]);
    if (patternIndex === 0) {
      return null;
    }
    return required(this.patterns[patternIndex - 1]);
  }
}
class PickedString {
  public delayLine: Float32Array | null = null;

  public delayIndex: number = 0;

  public allPassSample: number = 0;

  public allPassPrevInput: number = 0;

  public sustainFilterSample: number = 0;

  public sustainFilterPrevOutput2: number = 0;

  public sustainFilterPrevInput1: number = 0;

  public sustainFilterPrevInput2: number = 0;

  public fractionalDelaySample: number = 0;

  public prevDelayLength: number = 0;

  public delayLengthDelta: number = 0;

  public delayResetOffset: number = 0;

  public allPassG: number = 0;

  public allPassGDelta: number = 0;

  public sustainFilterA1: number = 0;

  public sustainFilterA1Delta: number = 0;

  public sustainFilterA2: number = 0;

  public sustainFilterA2Delta: number = 0;

  public sustainFilterB0: number = 0;

  public sustainFilterB0Delta: number = 0;

  public sustainFilterB1: number = 0;

  public sustainFilterB1Delta: number = 0;

  public sustainFilterB2: number = 0;

  public sustainFilterB2Delta: number = 0;

  public constructor() {
    this.reset();
  }

  public reset(): void {
    this.delayIndex = -1;
    this.allPassSample = 0;
    this.allPassPrevInput = 0;
    this.sustainFilterSample = 0;
    this.sustainFilterPrevOutput2 = 0;
    this.sustainFilterPrevInput1 = 0;
    this.sustainFilterPrevInput2 = 0;
    this.fractionalDelaySample = 0;
    this.prevDelayLength = -1;
    this.delayResetOffset = 0;
  }

  public update(
    synth: Synth,
    instrumentState: InstrumentState,
    tone: Tone,
    roundedSamplesPerTick: number,
    stringDecayStart: number,
    stringDecayEnd: number,
  ): void {
    const allPassCenter: number =
      (2 * Math.PI * Config.pickedStringDispersionCenterFreq) / synth.samplesPerSecond;
    const prevDelayLength: number = this.prevDelayLength;
    const phaseDeltaStart: number = required(tone.phaseDeltas[0]);
    const phaseDeltaScale: number = required(tone.phaseDeltaScales[0]);
    const phaseDeltaEnd: number = phaseDeltaStart * phaseDeltaScale ** roundedSamplesPerTick;
    const radiansPerSampleStart: number = Math.PI * 2 * phaseDeltaStart;
    const radiansPerSampleEnd: number = Math.PI * 2 * phaseDeltaEnd;
    const centerHarmonicStart: number = radiansPerSampleStart * 2;
    const centerHarmonicEnd: number = radiansPerSampleEnd * 2;
    const allPassRadiansStart: number = Math.min(
      Math.PI,
      radiansPerSampleStart *
        Config.pickedStringDispersionFreqMult *
        (allPassCenter / radiansPerSampleStart) ** Config.pickedStringDispersionFreqScale,
    );
    const allPassRadiansEnd: number = Math.min(
      Math.PI,
      radiansPerSampleEnd *
        Config.pickedStringDispersionFreqMult *
        (allPassCenter / radiansPerSampleEnd) ** Config.pickedStringDispersionFreqScale,
    );
    const shelfRadians: number =
      (2 * Math.PI * Config.pickedStringShelfHz) / synth.samplesPerSecond;
    const decayCurveStart: number = (100 ** stringDecayStart - 1) / 99;
    const decayCurveEnd: number = (100 ** stringDecayEnd - 1) / 99;

    const registerShelfCenter: number = 15.6;

    const decayRateStart: number =
      0.5 **
      (decayCurveStart *
        (shelfRadians / (radiansPerSampleStart * registerShelfCenter)) *
        registerShelfCenter);
    const decayRateEnd: number =
      0.5 **
      (decayCurveEnd *
        (shelfRadians / (radiansPerSampleEnd * registerShelfCenter)) *
        registerShelfCenter);
    const expressionDecayStart: number = decayRateStart ** 0.002;
    const expressionDecayEnd: number = decayRateEnd ** 0.002;
    tempFilterStartCoefficients.allPass1stOrderInvertPhaseAbove(allPassRadiansStart);
    synth.tempFrequencyResponse.analyze(tempFilterStartCoefficients, centerHarmonicStart);
    const allPassGStart: number = required(tempFilterStartCoefficients.b[0]);
    const allPassPhaseDelayStart: number =
      -synth.tempFrequencyResponse.angle() / centerHarmonicStart;
    tempFilterEndCoefficients.allPass1stOrderInvertPhaseAbove(allPassRadiansEnd);
    synth.tempFrequencyResponse.analyze(tempFilterEndCoefficients, centerHarmonicEnd);
    const allPassGEnd: number = required(tempFilterEndCoefficients.b[0]);
    const allPassPhaseDelayEnd: number = -synth.tempFrequencyResponse.angle() / centerHarmonicEnd;
    const shelfGainStart = decayRateStart ** Config.stringDecayRate;
    const shelfGainEnd = decayRateEnd ** Config.stringDecayRate;
    tempFilterStartCoefficients.highShelf2ndOrder(shelfRadians, shelfGainStart, 0.5);
    tempFilterEndCoefficients.highShelf2ndOrder(shelfRadians, shelfGainEnd, 0.5);
    synth.tempFrequencyResponse.analyze(tempFilterStartCoefficients, centerHarmonicStart);
    const sustainFilterA1Start: number = required(tempFilterStartCoefficients.a[1]);
    const sustainFilterA2Start: number = required(tempFilterStartCoefficients.a[2]);
    const sustainFilterB0Start: number =
      required(tempFilterStartCoefficients.b[0]) * expressionDecayStart;
    const sustainFilterB1Start: number =
      required(tempFilterStartCoefficients.b[1]) * expressionDecayStart;
    const sustainFilterB2Start: number =
      required(tempFilterStartCoefficients.b[2]) * expressionDecayStart;
    const sustainFilterPhaseDelayStart: number =
      -synth.tempFrequencyResponse.angle() / centerHarmonicStart;
    synth.tempFrequencyResponse.analyze(tempFilterEndCoefficients, centerHarmonicEnd);
    const sustainFilterA1End: number = required(tempFilterEndCoefficients.a[1]);
    const sustainFilterA2End: number = required(tempFilterEndCoefficients.a[2]);
    const sustainFilterB0End: number =
      required(tempFilterEndCoefficients.b[0]) * expressionDecayEnd;
    const sustainFilterB1End: number =
      required(tempFilterEndCoefficients.b[1]) * expressionDecayEnd;
    const sustainFilterB2End: number =
      required(tempFilterEndCoefficients.b[2]) * expressionDecayEnd;
    const sustainFilterPhaseDelayEnd: number =
      -synth.tempFrequencyResponse.angle() / centerHarmonicEnd;
    const periodLengthStart: number = 1 / phaseDeltaStart;
    const periodLengthEnd: number = 1 / phaseDeltaEnd;
    const minBufferLength: number = Math.ceil(Math.max(periodLengthStart, periodLengthEnd) * 2);
    const delayLength: number =
      periodLengthStart - allPassPhaseDelayStart - sustainFilterPhaseDelayStart;
    const delayLengthEnd: number =
      periodLengthEnd - allPassPhaseDelayEnd - sustainFilterPhaseDelayEnd;
    this.prevDelayLength = delayLength;
    this.delayLengthDelta = (delayLengthEnd - delayLength) / roundedSamplesPerTick;
    this.allPassG = allPassGStart;
    this.sustainFilterA1 = sustainFilterA1Start;
    this.sustainFilterA2 = sustainFilterA2Start;
    this.sustainFilterB0 = sustainFilterB0Start;
    this.sustainFilterB1 = sustainFilterB1Start;
    this.sustainFilterB2 = sustainFilterB2Start;
    this.allPassGDelta = (allPassGEnd - allPassGStart) / roundedSamplesPerTick;
    this.sustainFilterA1Delta = (sustainFilterA1End - sustainFilterA1Start) / roundedSamplesPerTick;
    this.sustainFilterA2Delta = (sustainFilterA2End - sustainFilterA2Start) / roundedSamplesPerTick;
    this.sustainFilterB0Delta = (sustainFilterB0End - sustainFilterB0Start) / roundedSamplesPerTick;
    this.sustainFilterB1Delta = (sustainFilterB1End - sustainFilterB1Start) / roundedSamplesPerTick;
    this.sustainFilterB2Delta = (sustainFilterB2End - sustainFilterB2Start) / roundedSamplesPerTick;
    const pitchChanged: boolean = Math.abs(Math.log2(delayLength / prevDelayLength)) > 0.01;
    const reinitializeImpulse: boolean = this.delayIndex === -1 || pitchChanged;
    if (this.delayLine === null || this.delayLine.length <= minBufferLength) {
      const likelyMaximumLength: number = Math.ceil(
        (2 * synth.samplesPerSecond) / Instrument.frequencyFromPitch(12),
      );
      const newDelayLine: Float32Array = new Float32Array(
        fittingPowerOfTwo(Math.max(likelyMaximumLength, minBufferLength)),
      );
      if (!reinitializeImpulse && this.delayLine !== null) {
        const oldDelayBufferMask: number = Math.trunc(this.delayLine.length - 1);
        const startCopyingFromIndex: number = this.delayIndex + this.delayResetOffset;
        this.delayIndex = this.delayLine.length - this.delayResetOffset;
        for (let i: number = 0; i < this.delayLine.length; i++) {
          newDelayLine[i] = required(
            this.delayLine[(startCopyingFromIndex + i) & oldDelayBufferMask],
          );
        }
      }
      this.delayLine = newDelayLine;
    }
    const delayLine: Float32Array = this.delayLine;
    const delayBufferMask: number = Math.trunc(delayLine.length - 1);
    if (reinitializeImpulse) {
      this.delayIndex = 0;
      this.allPassSample = 0;
      this.allPassPrevInput = 0;
      this.sustainFilterSample = 0;
      this.sustainFilterPrevOutput2 = 0;
      this.sustainFilterPrevInput1 = 0;
      this.sustainFilterPrevInput2 = 0;
      this.fractionalDelaySample = 0;
      const startImpulseFrom: number = -delayLength;
      const startZerosFrom: number = Math.floor(startImpulseFrom - periodLengthStart / 2);
      const stopZerosAt: number = Math.ceil(startZerosFrom + periodLengthStart * 2);
      this.delayResetOffset = stopZerosAt;
      for (let i: number = startZerosFrom; i <= stopZerosAt; i++) {
        delayLine[i & delayBufferMask] = 0;
      }
      const impulseWave: Float32Array = required(instrumentState.wave);
      const impulseWaveLength: number = impulseWave.length - 1;
      const impulsePhaseDelta: number = impulseWaveLength / periodLengthStart;
      const fadeDuration: number = Math.min(
        periodLengthStart * 0.2,
        synth.samplesPerSecond * 0.003,
      );
      const startImpulseFromSample: number = Math.ceil(startImpulseFrom);
      const stopImpulseAt: number = startImpulseFrom + periodLengthStart + fadeDuration;
      const stopImpulseAtSample: number = stopImpulseAt;
      let impulsePhase: number = (startImpulseFromSample - startImpulseFrom) * impulsePhaseDelta;
      let prevWaveIntegral: number = 0;
      for (let i: number = startImpulseFromSample; i <= stopImpulseAtSample; i++) {
        const impulsePhaseInt: number = Math.trunc(impulsePhase);
        const index: number = impulsePhaseInt % impulseWaveLength;
        let nextWaveIntegral: number = required(impulseWave[index]);
        const phaseRatio: number = impulsePhase - impulsePhaseInt;
        nextWaveIntegral += (required(impulseWave[index + 1]) - nextWaveIntegral) * phaseRatio;
        const sample: number = (nextWaveIntegral - prevWaveIntegral) / impulsePhaseDelta;
        const fadeIn: number = Math.min(1, (i - startImpulseFrom) / fadeDuration);
        const fadeOut: number = Math.min(1, (stopImpulseAt - i) / fadeDuration);
        const combinedFade: number = fadeIn * fadeOut;
        const curvedFade: number = combinedFade * combinedFade * (3 - 2 * combinedFade);
        delayLine[i & delayBufferMask] =
          required(delayLine[i & delayBufferMask]) + sample * curvedFade;
        prevWaveIntegral = nextWaveIntegral;
        impulsePhase += impulsePhaseDelta;
      }
    }
  }
}
class EnvelopeComputer {
  public noteSecondsStart: number = 0;

  public noteSecondsEnd: number = 0;

  public noteTicksStart: number = 0;

  public noteTicksEnd: number = 0;

  public noteSizeStart: number = Config.noteSizeMax;

  public noteSizeEnd: number = Config.noteSizeMax;

  public prevNoteSize: number = Config.noteSizeMax;

  public nextNoteSize: number = Config.noteSizeMax;

  public prevNoteSecondsStart: number = 0;

  public prevNoteSecondsEnd: number = 0;

  public prevNoteTicksStart: number = 0;

  public prevNoteTicksEnd: number = 0;

  public prevSlideStart: boolean = false;

  public prevSlideEnd: boolean = false;

  public nextSlideStart: boolean = false;

  public nextSlideEnd: boolean = false;

  public prevSlideRatioStart: number = 0;

  public prevSlideRatioEnd: number = 0;

  public nextSlideRatioStart: number = 0;

  public nextSlideRatioEnd: number = 0;

  public readonly envelopeStarts: number[] = [];

  public readonly envelopeEnds: number[] = [];

  private _noteSizeFinal: number = Config.noteSizeMax;

  private _prevNoteSizeFinal: number = Config.noteSizeMax;

  private readonly _modifiedEnvelopeIndices: number[] = [];

  private _modifiedEnvelopeCount: number = 0;

  public constructor() {
    const length: number = EnvelopeComputeIndex.length;
    for (let i: number = 0; i < length; i++) {
      this.envelopeStarts[i] = 1;
      this.envelopeEnds[i] = 1;
    }
    this.reset();
  }

  public static getLowpassCutoffDecayVolumeCompensation(this: void, envelope: Envelope): number {
    if (envelope.type === "Decay") {
      return 1.25 + 0.025 * envelope.speed;
    }
    if (envelope.type === "Twang") {
      return 1 + 0.02 * envelope.speed;
    }
    return 1;
  }

  public reset(): void {
    this.noteSecondsEnd = 0;
    this.noteTicksEnd = 0;
    this._noteSizeFinal = Config.noteSizeMax;
    this.prevNoteSecondsEnd = 0;
    this.prevNoteTicksEnd = 0;
    this._prevNoteSizeFinal = Config.noteSizeMax;
    this._modifiedEnvelopeCount = 0;
  }

  public computeEnvelopes(
    instrument: Instrument,
    currentPart: number,
    tickTimeStart: number,
    tickTimeStartReal: number,
    secondsPerTick: number,
    tone: Tone | null,
    songClockStart: SongEnvelopeClock,
    songClockEnd: SongEnvelopeClock,
  ): void {
    const transition: Transition = instrument.getTransition();
    if (tone !== null && tone.atNoteStart && !transition.continues && !tone.forceContinueAtStart) {
      this.prevNoteSecondsEnd = this.noteSecondsEnd;
      this.prevNoteTicksEnd = this.noteTicksEnd;
      this._prevNoteSizeFinal = this._noteSizeFinal;
      this.noteSecondsEnd = 0;
      this.noteTicksEnd = 0;
    }
    if (tone !== null) {
      if (tone.note !== null) {
        this._noteSizeFinal = required(tone.note.pins.at(-1)).size;
      } else {
        this._noteSizeFinal = Config.noteSizeMax;
      }
    }
    const tickTimeEnd: number = tickTimeStart + 1;
    const tickTimeEndReal: number = tickTimeStartReal + 1;
    const noteSecondsStart: number = this.noteSecondsEnd;
    const noteSecondsEnd: number = noteSecondsStart + secondsPerTick;
    const noteTicksStart: number = this.noteTicksEnd;
    const noteTicksEnd: number = noteTicksStart + 1;
    const prevNoteSecondsStart: number = this.prevNoteSecondsEnd;
    const prevNoteSecondsEnd: number = prevNoteSecondsStart + secondsPerTick;
    const prevNoteTicksStart: number = this.prevNoteTicksEnd;
    const prevNoteTicksEnd: number = prevNoteTicksStart + 1;
    const beatsPerTick: number = 1 / (Config.ticksPerPart * Config.partsPerBeat);
    const beatTimeStart: number = beatsPerTick * tickTimeStart;
    const beatTimeEnd: number = beatsPerTick * tickTimeEnd;
    let noteSizeStart: number = this._noteSizeFinal;
    let noteSizeEnd: number = this._noteSizeFinal;
    const prevNoteSize: number = this._prevNoteSizeFinal;
    let nextNoteSize: number = 0;
    let prevSlideStart: boolean = false;
    let prevSlideEnd: boolean = false;
    let nextSlideStart: boolean = false;
    let nextSlideEnd: boolean = false;
    let prevSlideRatioStart: number = 0;
    let prevSlideRatioEnd: number = 0;
    let nextSlideRatioStart: number = 0;
    let nextSlideRatioEnd: number = 0;
    if (tone?.note && !tone.passedEndOfNote) {
      const endPinIndex: number = tone.note.getEndPinIndex(currentPart);
      const startPin: NotePin = required(tone.note.pins[endPinIndex - 1]);
      const endPin: NotePin = required(tone.note.pins[endPinIndex]);
      const startPinTick: number = (tone.note.start + startPin.time) * Config.ticksPerPart;
      const endPinTick: number = (tone.note.start + endPin.time) * Config.ticksPerPart;
      const ratioStart: number = (tickTimeStartReal - startPinTick) / (endPinTick - startPinTick);
      const ratioEnd: number = (tickTimeEndReal - startPinTick) / (endPinTick - startPinTick);
      noteSizeStart = startPin.size + (endPin.size - startPin.size) * ratioStart;
      noteSizeEnd = startPin.size + (endPin.size - startPin.size) * ratioEnd;
      if (transition.slides) {
        const noteStartTick: number = tone.noteStartPart * Config.ticksPerPart;
        const noteEndTick: number = tone.noteEndPart * Config.ticksPerPart;
        const noteLengthTicks: number = noteEndTick - noteStartTick;
        const maximumSlideTicks: number = noteLengthTicks * 0.5;
        const slideTicks: number = Math.min(maximumSlideTicks, transition.slideTicks);
        if (tone.prevNote !== null && !tone.forceContinueAtStart) {
          if (tickTimeStartReal - noteStartTick < slideTicks) {
            prevSlideStart = true;
            prevSlideRatioStart = 0.5 * (1 - (tickTimeStartReal - noteStartTick) / slideTicks);
          }
          if (tickTimeEndReal - noteStartTick < slideTicks) {
            prevSlideEnd = true;
            prevSlideRatioEnd = 0.5 * (1 - (tickTimeEndReal - noteStartTick) / slideTicks);
          }
        }
        if (tone.nextNote !== null && !tone.forceContinueAtEnd) {
          nextNoteSize = required(tone.nextNote.pins[0]).size;
          if (noteEndTick - tickTimeStartReal < slideTicks) {
            nextSlideStart = true;
            nextSlideRatioStart = 0.5 * (1 - (noteEndTick - tickTimeStartReal) / slideTicks);
          }
          if (noteEndTick - tickTimeEndReal < slideTicks) {
            nextSlideEnd = true;
            nextSlideRatioEnd = 0.5 * (1 - (noteEndTick - tickTimeEndReal) / slideTicks);
          }
        }
      }
    }
    let usedNoteSize: boolean = false;
    for (
      let envelopeIndex: number = 0;
      envelopeIndex <= instrument.envelopes.length;
      envelopeIndex++
    ) {
      let automationTarget = required(Config.instrumentAutomationTargets.dictionary["noteVolume"]);
      let targetIndex = 0;
      let envelope = noteSizeEnvelope;
      if (envelopeIndex === instrument.envelopes.length) {
        if (usedNoteSize) {
          break;
        }
      } else {
        const envelopeSettings: EnvelopeSettings = required(instrument.envelopes[envelopeIndex]);
        ({ target: automationTarget, index: targetIndex, envelope } = envelopeSettings);
        if (envelope.type === "Note Size") {
          usedNoteSize = true;
        }
      }
      if (automationTarget.computeIndex !== null) {
        const computeIndex: number = automationTarget.computeIndex + targetIndex;
        let envelopeStart: number = envelope.evaluate(
          noteSecondsStart,
          beatTimeStart,
          noteSizeStart,
          envelopeTiming(noteTicksStart * beatsPerTick, songClockStart),
        );
        if (prevSlideStart) {
          const other: number = envelope.evaluate(
            prevNoteSecondsStart,
            beatTimeStart,
            prevNoteSize,
            envelopeTiming(prevNoteTicksStart * beatsPerTick, songClockStart),
          );
          envelopeStart += (other - envelopeStart) * prevSlideRatioStart;
        }
        if (nextSlideStart) {
          const other: number = envelope.evaluate(
            0,
            beatTimeStart,
            nextNoteSize,
            envelopeTiming(0, songClockStart),
          );
          envelopeStart += (other - envelopeStart) * nextSlideRatioStart;
        }
        let envelopeEnd = envelope.evaluate(
          noteSecondsEnd,
          beatTimeEnd,
          noteSizeEnd,
          envelopeTiming(noteTicksEnd * beatsPerTick, songClockEnd),
        );
        if (prevSlideEnd) {
          const other: number = envelope.evaluate(
            prevNoteSecondsEnd,
            beatTimeEnd,
            prevNoteSize,
            envelopeTiming(prevNoteTicksEnd * beatsPerTick, songClockEnd),
          );
          envelopeEnd += (other - envelopeEnd) * prevSlideRatioEnd;
        }
        if (nextSlideEnd) {
          const other: number = envelope.evaluate(
            0,
            beatTimeEnd,
            nextNoteSize,
            envelopeTiming(0, songClockEnd),
          );
          envelopeEnd += (other - envelopeEnd) * nextSlideRatioEnd;
        }
        this.envelopeStarts[computeIndex] =
          required(this.envelopeStarts[computeIndex]) * envelopeStart;
        this.envelopeEnds[computeIndex] = required(this.envelopeEnds[computeIndex]) * envelopeEnd;
        this._modifiedEnvelopeIndices[this._modifiedEnvelopeCount++] = computeIndex;
      }
    }
    this.noteSecondsStart = noteSecondsStart;
    this.noteSecondsEnd = noteSecondsEnd;
    this.noteTicksStart = noteTicksStart;
    this.noteTicksEnd = noteTicksEnd;
    this.prevNoteSecondsStart = prevNoteSecondsStart;
    this.prevNoteSecondsEnd = prevNoteSecondsEnd;
    this.prevNoteTicksStart = prevNoteTicksStart;
    this.prevNoteTicksEnd = prevNoteTicksEnd;
    this.prevNoteSize = prevNoteSize;
    this.nextNoteSize = nextNoteSize;
    this.noteSizeStart = noteSizeStart;
    this.noteSizeEnd = noteSizeEnd;
    this.prevSlideStart = prevSlideStart;
    this.prevSlideEnd = prevSlideEnd;
    this.nextSlideStart = nextSlideStart;
    this.nextSlideEnd = nextSlideEnd;
    this.prevSlideRatioStart = prevSlideRatioStart;
    this.prevSlideRatioEnd = prevSlideRatioEnd;
    this.nextSlideRatioStart = nextSlideRatioStart;
    this.nextSlideRatioEnd = nextSlideRatioEnd;
  }

  public clearEnvelopes(): void {
    for (
      let envelopeIndex: number = 0;
      envelopeIndex < this._modifiedEnvelopeCount;
      envelopeIndex++
    ) {
      const computeIndex: number = required(this._modifiedEnvelopeIndices[envelopeIndex]);
      this.envelopeStarts[computeIndex] = 1;
      this.envelopeEnds[computeIndex] = 1;
    }
    this._modifiedEnvelopeCount = 0;
  }
}
class Tone {
  public readonly pitches: number[] = Array<number>(Config.maxChordSize + 2).fill(0);

  public pitchCount: number = 0;

  public chordSize: number = 0;

  public drumsetPitch: number | null = null;

  public note: Note | null = null;

  public prevNote: Note | null = null;

  public nextNote: Note | null = null;

  public prevNotePitchIndex: number = 0;

  public nextNotePitchIndex: number = 0;

  public freshlyAllocated: boolean = true;

  public atNoteStart: boolean = false;

  public isOnLastTick: boolean = false;

  public passedEndOfNote: boolean = false;

  public forceContinueAtStart: boolean = false;

  public forceContinueAtEnd: boolean = false;

  public noteStartPart: number = 0;

  public noteEndPart: number = 0;

  public ticksSinceReleased: number = 0;

  public liveInputSamplesHeld: number = 0;

  public lastInterval: number = 0;

  public noiseSample: number = 0;

  public noiseSampleA: number = 0;

  public noiseSampleB: number = 0;

  public stringSustainStart: number = 0;

  public stringSustainEnd: number = 0;

  public readonly phases = new Float64Array(
    Math.max(Config.supersawVoiceCount, Config.maxChordSize),
  );

  public readonly phaseDeltas: number[] = [];

  public directions: number[] = [];

  public chipWaveCompletions: number[] = [];

  public chipWavePrevWaves: number[] = [];

  public chipWaveCompletionsLastWave: number[] = [];

  public readonly phaseDeltaScales: number[] = [];

  public expression: number = 0;

  public expressionDelta: number = 0;

  public readonly prevPitchExpressions: Array<number | null> = Array<null>(
    Config.maxChordSize,
  ).fill(null);

  public prevStringDecay: number | null = null;

  public pulseWidth: number = 0;

  public pulseWidthDelta: number = 0;

  public supersawDynamism: number = 0;

  public supersawDynamismDelta: number = 0;

  public readonly supersawUnisonDetunes = new Float64Array(Config.supersawVoiceCount);

  public supersawShape: number = 0;

  public supersawShapeDelta: number = 0;

  public supersawDelayLength: number = 0;

  public supersawDelayLengthDelta: number = 0;

  public supersawDelayLine: Float32Array | null = null;

  public supersawDelayIndex: number = -1;

  public supersawPrevPhaseDelta: number | null = null;

  public readonly pickedString = new PickedString();

  public readonly drumFilters: DynamicBiquadFilter[] = [];

  public drumFilterCount: number = 0;

  public drumFilterInput1: number = 0;

  public drumFilterInput2: number = 0;

  public specialIntervalExpressionMult: number = 1;

  public readonly envelopeComputer: EnvelopeComputer = new EnvelopeComputer();

  public constructor() {
    this.reset();
  }

  public reset(): void {
    this.noiseSample = 0;
    this.noiseSampleA = 0;
    this.noiseSampleB = 0;
    for (let i: number = 0; i < Config.maxChordSize; i++) {
      this.phases[i] = 0;
      this.directions[i] = 1;
      this.chipWaveCompletions[i] = 0;
      this.chipWavePrevWaves[i] = 0;
      this.chipWaveCompletionsLastWave[i] = 0;
      this.prevPitchExpressions[i] = null;
    }
    for (let i: number = 0; i < this.drumFilterCount; i++) {
      required(this.drumFilters[i]).resetOutput();
    }
    this.drumFilterCount = 0;
    this.drumFilterInput1 = 0;
    this.drumFilterInput2 = 0;
    this.liveInputSamplesHeld = 0;
    this.supersawDelayIndex = -1;
    this.pickedString.reset();
    this.envelopeComputer.reset();
    this.prevStringDecay = null;
    this.supersawPrevPhaseDelta = null;
    this.drumsetPitch = null;
  }
}
class InstrumentState {
  public awake: boolean = false;

  public computed: boolean = false;

  public tonesAddedInThisTick: boolean = false;

  public deactivateAfterThisTick: boolean = false;

  public readonly activeTones: Tone[] = [];

  public readonly releasedTones: Tone[] = [];

  public readonly liveInputTones: Tone[] = [];

  public type: number = InstrumentType.chip;

  public synthesizer: SynthFunction | null = null;

  public wave: Float32Array | null = null;

  public noisePitchFilterMult: number = 1;

  public chord: Chord | null = null;

  public arpTime: number = 0;

  public envelopeTime: number = 0;

  public inputFadeVolume: number = 1;

  public inputFadeVolumeDelta: number = 0;

  public mixVolume: number = 1;

  public mixVolumeDelta: number = 0;

  public readonly spectrumWave: SpectrumWaveState = new SpectrumWaveState();

  public readonly harmonicsWave: HarmonicsWaveState = new HarmonicsWaveState();

  public readonly drumsetSpectrumWaves: SpectrumWaveState[] = [];

  public constructor() {
    for (let i: number = 0; i < Config.drumCount; i++) {
      this.drumsetSpectrumWaves[i] = new SpectrumWaveState();
    }
  }

  public static drumsetIndexReferenceDelta(this: void, index: number): number {
    return Instrument.frequencyFromPitch(Config.spectrumBasePitch + index * 6) / 44_100;
  }

  private static _drumsetIndexToSpectrumOctave(this: void, index: number): number {
    return 15 + Math.log2(InstrumentState.drumsetIndexReferenceDelta(index));
  }

  public deactivate(): void {
    this.awake = false;
    this.deactivateAfterThisTick = false;
  }

  public reset(): void {
    this.deactivate();
    this.arpTime = 0;
    this.envelopeTime = 0;
  }

  public compute(synth: Synth, instrument: Instrument, roundedSamplesPerTick: number): void {
    this.computed = true;
    this.type = instrument.type;
    this.synthesizer = synth.getInstrumentSynthFunction(instrument);
    this.chord = instrument.getChord();
    this.noisePitchFilterMult = required(Config.chipNoises[instrument.chipNoise]).pitchFilterMult;
    this.updateWaves(instrument);
    const volume = instrumentVolumeToVolumeMult(instrument.volume);
    this.mixVolume = volume;
    this.mixVolumeDelta = 0;
    this.inputFadeVolume = 1;
    this.inputFadeVolumeDelta = this.tonesAddedInThisTick ? 0 : -1 / roundedSamplesPerTick;
    this.deactivateAfterThisTick = !this.tonesAddedInThisTick;
  }

  public updateWaves(instrument: Instrument): void {
    if (instrument.type === InstrumentType.chip) {
      this.wave = required(Config.chipWaves[instrument.chipWave]).samples;
    } else if (instrument.type === InstrumentType.noise) {
      this.wave = getDrumWave(instrument.chipNoise);
    } else if (
      instrument.type === InstrumentType.harmonics ||
      instrument.type === InstrumentType.pickedString
    ) {
      this.wave = this.harmonicsWave.getCustomWave(instrument.harmonicsWave, instrument.type);
    } else if (instrument.type === InstrumentType.spectrum) {
      this.wave = this.spectrumWave.getCustomWave(instrument.spectrumWave, 8);
    } else if (instrument.type === InstrumentType.drumset) {
      for (let i: number = 0; i < Config.drumCount; i++) {
        required(this.drumsetSpectrumWaves[i]).getCustomWave(
          required(instrument.drumsetSpectrumWaves[i]),
          InstrumentState._drumsetIndexToSpectrumOctave(i),
        );
      }
      this.wave = null;
    } else {
      this.wave = null;
    }
  }

  public getDrumsetWave(pitch: number): Float32Array {
    if (this.type === InstrumentType.drumset) {
      return required(required(this.drumsetSpectrumWaves[pitch]).wave);
    } else {
      throw new Error("Unhandled instrument type in getDrumsetWave");
    }
  }
}
type SynthFunction = (
  synth: Synth,
  bufferIndex: number,
  runLength: number,
  tone: Tone,
  instrumentState: InstrumentState,
) => void;
export class Synth {
  public samplesPerSecond: number = 44_100;

  public song: Song;

  public liveInputStarted: boolean = false;

  public liveInputPitches: number[] = [];

  public isAtStartOfTick: boolean = true;

  public tickSampleCountdown: number = 0;

  public tempFrequencyResponse: FrequencyResponse = new FrequencyResponse();

  public tempMonoInstrumentSampleBuffer: Float32Array | null = null;

  private prevBar: number | null = null;

  private nextBar: number | null = null;

  private bar: number = 0;

  private beat: number = 0;

  private part: number = 0;

  private tick: number = 0;

  private readonly instrumentState = new InstrumentState();

  private readonly tonePool: Tone[] = [];

  private readonly tempMatchedPitchTones: Array<Tone | null> = Array<null>(
    Config.maxChordSize,
  ).fill(null);

  public constructor(song: Song) {
    this.song = song;
  }

  public static adjacentNotesHaveMatchingPitches(
    this: void,
    firstNote: Note,
    secondNote: Note,
  ): boolean {
    if (firstNote.pitches.length !== secondNote.pitches.length) {
      return false;
    }
    const firstNoteInterval: number = required(firstNote.pins.at(-1)).interval;
    for (const pitch of firstNote.pitches) {
      if (!secondNote.pitches.includes(pitch + firstNoteInterval)) {
        return false;
      }
    }
    return true;
  }

  public static volumeMultToInstrumentVolume(this: void, volumeMult: number): number {
    if (volumeMult <= 0) {
      return -Config.volumeRange / 2;
    }
    const exponent = Math.log2(volumeMult);
    return Math.min(Config.volumeRange, exponent / Config.volumeLogScale);
  }

  public static secondsToFadeInSetting(this: void, seconds: number): number {
    return clamp(
      0,
      Config.fadeInRange,
      Math.round((-0.95 + Math.sqrt(0.9025 + (0.2 * seconds) / 0.0125)) / 0.1),
    );
  }

  public static ticksToFadeOutSetting(this: void, ticks: number): number {
    let lower: number = required(Config.fadeOutTicks[0]);
    if (ticks <= lower) {
      return 0;
    }
    for (let i: number = 1; i < Config.fadeOutTicks.length; i++) {
      const upper: number = required(Config.fadeOutTicks[i]);
      if (ticks <= upper) {
        return ticks < (lower + upper) / 2 ? i - 1 : i;
      }
      lower = upper;
    }
    return Config.fadeOutTicks.length - 1;
  }

  public static applyDrumFilter(
    this: void,
    initialSample: number,
    initialInput1: number,
    initialInput2: number,
    filterCount: number,
    filters: DynamicBiquadFilter[],
  ): number {
    let input1 = initialInput1;

    let input2 = initialInput2;

    let sample = initialSample;

    for (let i: number = 0; i < filterCount; i++) {
      const filter: DynamicBiquadFilter = required(filters[i]);
      const output1: number = filter.output1;
      const output2: number = filter.output2;
      const a1: number = filter.a1;
      const a2: number = filter.a2;
      const b0: number = filter.b0;
      const b1: number = filter.b1;
      const b2: number = filter.b2;
      sample = b0 * sample + b1 * input1 + b2 * input2 - a1 * output1 - a2 * output2;
      filter.a1 = a1 + filter.a1Delta;
      filter.a2 = a2 + filter.a2Delta;
      filter.b0 = b0 * filter.b0Delta;
      filter.b1 = b1 * filter.b1Delta;
      filter.b2 = b2 * filter.b2Delta;
      filter.output2 = output1;
      filter.output1 = sample;
      input2 = output2;
      input1 = output1;
    }
    return sample;
  }

  private static computeChordExpression(this: void, chordSize: number): number {
    return 1 / ((chordSize - 1) * 0.25 + 1);
  }

  private static integratedWaveSynth(
    this: void,
    synth: Synth,
    bufferIndex: number,
    runLength: number,
    tone: Tone,
    instrumentState: InstrumentState,
  ): void {
    const data = required(synth.tempMonoInstrumentSampleBuffer);
    const wave = required(instrumentState.wave);
    const waveLength = wave.length - 1;
    const waveMask = (waveLength & (waveLength - 1)) === 0 ? waveLength - 1 : 0;
    const intervalExpression = tone.specialIntervalExpressionMult;
    if (!required(instrumentState.chord).customInterval) {
      tone.phases[1] = required(tone.phases[0]);
    }
    let phaseDeltaA = required(tone.phaseDeltas[0]) * waveLength;
    let phaseDeltaB = required(tone.phaseDeltas[1]) * waveLength;
    const phaseDeltaScaleA = required(tone.phaseDeltaScales[0]);
    const phaseDeltaScaleB = required(tone.phaseDeltaScales[1]);
    let phaseA = (required(tone.phases[0]) % 1) * waveLength;
    let phaseB = (required(tone.phases[1]) % 1) * waveLength;
    const sharedPhase =
      phaseA === phaseB && phaseDeltaA === phaseDeltaB && phaseDeltaScaleA === phaseDeltaScaleB;
    let previousA = interpolateWaveIntegral(wave, waveLength, waveMask, phaseA);
    let previousB = sharedPhase
      ? previousA
      : interpolateWaveIntegral(wave, waveLength, waveMask, phaseB);
    let { expression } = tone;
    const { expressionDelta } = tone;
    const stopIndex = bufferIndex + runLength;
    for (let sampleIndex = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
      phaseA += phaseDeltaA;
      const nextA = interpolateWaveIntegral(wave, waveLength, waveMask, phaseA);
      const waveA = (nextA - previousA) / phaseDeltaA;
      previousA = nextA;
      phaseDeltaA *= phaseDeltaScaleA;
      let waveB = waveA;
      if (!sharedPhase) {
        phaseB += phaseDeltaB;
        const nextB = interpolateWaveIntegral(wave, waveLength, waveMask, phaseB);
        waveB = (nextB - previousB) / phaseDeltaB;
        previousB = nextB;
        phaseDeltaB *= phaseDeltaScaleB;
      }
      const input = waveA + waveB * intervalExpression;
      const sample = input;
      const output = sample * expression;
      expression += expressionDelta;
      data[sampleIndex] = required(data[sampleIndex]) + output;
    }
    tone.phases[0] = phaseA / waveLength;
    tone.phases[1] = (sharedPhase ? phaseA : phaseB) / waveLength;
    tone.phaseDeltas[0] = phaseDeltaA / waveLength;
    tone.phaseDeltas[1] = (sharedPhase ? phaseDeltaA : phaseDeltaB) / waveLength;
    tone.expression = expression;
  }

  private static pickedStringSynth(
    this: void,
    synth: Synth,
    bufferIndex: number,
    runLength: number,
    tone: Tone,
    _instrumentState: InstrumentState,
  ): void {
    const data = required(synth.tempMonoInstrumentSampleBuffer);
    let { expression } = tone;

    const { pickedString } = tone;
    const { length } = required(pickedString.delayLine);
    pickedString.delayIndex = (pickedString.delayIndex & (length - 1)) + length;

    for (let sampleIndex = bufferIndex; sampleIndex < bufferIndex + runLength; sampleIndex++) {
      const delayLine = required(pickedString.delayLine);
      const mask = Math.trunc(delayLine.length - 1);
      const targetSampleTime = pickedString.delayIndex - pickedString.prevDelayLength;
      const lowerIndex = Math.trunc(targetSampleTime + 0.125);
      const upperIndex = lowerIndex + 1;
      const fractionalDelay = upperIndex - targetSampleTime;
      const fractionalDelayG = (1 - fractionalDelay) / (1 + fractionalDelay);
      const prevInput = delayLine[lowerIndex & mask];
      const delayedInput = delayLine[upperIndex & mask];
      pickedString.fractionalDelaySample =
        fractionalDelayG * required(delayedInput) +
        required(prevInput) -
        fractionalDelayG * pickedString.fractionalDelaySample;
      pickedString.allPassSample =
        pickedString.fractionalDelaySample * pickedString.allPassG +
        pickedString.allPassPrevInput -
        pickedString.allPassG * pickedString.allPassSample;
      pickedString.allPassPrevInput = pickedString.fractionalDelaySample;
      const sustainFilterPrevOutput1 = pickedString.sustainFilterSample;
      pickedString.sustainFilterSample =
        pickedString.sustainFilterB0 * pickedString.allPassSample +
        pickedString.sustainFilterB1 * pickedString.sustainFilterPrevInput1 +
        pickedString.sustainFilterB2 * pickedString.sustainFilterPrevInput2 -
        pickedString.sustainFilterA1 * pickedString.sustainFilterSample -
        pickedString.sustainFilterA2 * pickedString.sustainFilterPrevOutput2;
      pickedString.sustainFilterPrevOutput2 = sustainFilterPrevOutput1;
      pickedString.sustainFilterPrevInput2 = pickedString.sustainFilterPrevInput1;
      pickedString.sustainFilterPrevInput1 = pickedString.allPassSample;
      delayLine[pickedString.delayIndex & mask] =
        required(delayLine[pickedString.delayIndex & mask]) + pickedString.sustainFilterSample;
      delayLine[(pickedString.delayIndex + pickedString.delayResetOffset) & mask] = 0;
      pickedString.delayIndex++;

      pickedString.prevDelayLength += pickedString.delayLengthDelta;
      pickedString.allPassG += pickedString.allPassGDelta;
      pickedString.sustainFilterA1 += pickedString.sustainFilterA1Delta;
      pickedString.sustainFilterA2 += pickedString.sustainFilterA2Delta;
      pickedString.sustainFilterB0 += pickedString.sustainFilterB0Delta;
      pickedString.sustainFilterB1 += pickedString.sustainFilterB1Delta;
      pickedString.sustainFilterB2 += pickedString.sustainFilterB2Delta;

      const input = tone.pickedString.fractionalDelaySample * expression;
      const sample = input;
      data[sampleIndex] = required(data[sampleIndex]) + sample;
      expression += tone.expressionDelta;
    }

    if (
      !Number.isFinite(pickedString.allPassSample) ||
      Math.abs(pickedString.allPassSample) < epsilon
    ) {
      pickedString.allPassSample = 0;
    }
    if (
      !Number.isFinite(pickedString.allPassPrevInput) ||
      Math.abs(pickedString.allPassPrevInput) < epsilon
    ) {
      pickedString.allPassPrevInput = 0;
    }
    if (
      !Number.isFinite(pickedString.sustainFilterSample) ||
      Math.abs(pickedString.sustainFilterSample) < epsilon
    ) {
      pickedString.sustainFilterSample = 0;
    }
    if (
      !Number.isFinite(pickedString.sustainFilterPrevOutput2) ||
      Math.abs(pickedString.sustainFilterPrevOutput2) < epsilon
    ) {
      pickedString.sustainFilterPrevOutput2 = 0;
    }
    if (
      !Number.isFinite(pickedString.sustainFilterPrevInput1) ||
      Math.abs(pickedString.sustainFilterPrevInput1) < epsilon
    ) {
      pickedString.sustainFilterPrevInput1 = 0;
    }
    if (
      !Number.isFinite(pickedString.sustainFilterPrevInput2) ||
      Math.abs(pickedString.sustainFilterPrevInput2) < epsilon
    ) {
      pickedString.sustainFilterPrevInput2 = 0;
    }
    if (
      !Number.isFinite(pickedString.fractionalDelaySample) ||
      Math.abs(pickedString.fractionalDelaySample) < epsilon
    ) {
      pickedString.fractionalDelaySample = 0;
    }

    tone.expression = expression;
  }

  private static mixInstrument(
    this: void,
    synth: Synth,
    outputDataL: Float64Array,
    outputDataR: Float64Array,
    bufferIndex: number,
    runLength: number,
    instrumentState: InstrumentState,
  ): void {
    const mono = required(synth.tempMonoInstrumentSampleBuffer);
    let { mixVolume, inputFadeVolume } = instrumentState;
    const { mixVolumeDelta, inputFadeVolumeDelta } = instrumentState;
    const stopIndex = bufferIndex + runLength;
    for (let sampleIndex = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
      const sample = required(mono[sampleIndex]) * inputFadeVolume * mixVolume;
      mono[sampleIndex] = 0;
      outputDataL[sampleIndex] = required(outputDataL[sampleIndex]) + sample;
      outputDataR[sampleIndex] = required(outputDataR[sampleIndex]) + sample;
      inputFadeVolume += inputFadeVolumeDelta;
      mixVolume += mixVolumeDelta;
    }
    instrumentState.mixVolume = mixVolume;
    instrumentState.inputFadeVolume = inputFadeVolume;
  }

  private static pulseWidthSynth(
    this: void,
    synth: Synth,
    bufferIndex: number,
    roundedSamplesPerTick: number,
    tone: Tone,
    instrumentState: InstrumentState,
  ): void {
    const data: Float32Array = required(synth.tempMonoInstrumentSampleBuffer);
    const intervalExpression: number = tone.specialIntervalExpressionMult;
    if (!required(instrumentState.chord).customInterval) {
      tone.phases[1] = required(tone.phases[0]);
    }
    let phaseDeltaA: number = required(tone.phaseDeltas[0]);
    let phaseDeltaB: number = required(tone.phaseDeltas[1]);
    const phaseDeltaScaleA: number = required(tone.phaseDeltaScales[0]);
    const phaseDeltaScaleB: number = required(tone.phaseDeltaScales[1]);
    let expression: number = tone.expression;
    const expressionDelta: number = tone.expressionDelta;
    let phaseA: number = required(tone.phases[0]) % 1;
    let phaseB: number = required(tone.phases[1]) % 1;
    const sharedPhase =
      Object.is(phaseA, phaseB) &&
      phaseDeltaA === phaseDeltaB &&
      phaseDeltaScaleA === phaseDeltaScaleB;
    let pulseWidth: number = tone.pulseWidth;
    const pulseWidthDelta: number = tone.pulseWidthDelta;
    const stopIndex: number = bufferIndex + roundedSamplesPerTick;
    for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
      const pulseA = samplePulse(phaseA, pulseWidth, phaseDeltaA);
      const pulseB = sharedPhase ? pulseA : samplePulse(phaseB, pulseWidth, phaseDeltaB);
      const inputSample = pulseA + pulseB * intervalExpression;
      const sample = inputSample;
      phaseA += phaseDeltaA;
      phaseDeltaA *= phaseDeltaScaleA;
      if (!sharedPhase) {
        phaseB += phaseDeltaB;
        phaseDeltaB *= phaseDeltaScaleB;
      }
      pulseWidth += pulseWidthDelta;
      const output: number = sample * expression;
      expression += expressionDelta;
      data[sampleIndex] = required(data[sampleIndex]) + output;
    }
    tone.phases[0] = phaseA;
    tone.phases[1] = sharedPhase ? phaseA : phaseB;
    tone.phaseDeltas[0] = phaseDeltaA;
    tone.phaseDeltas[1] = sharedPhase ? phaseDeltaA : phaseDeltaB;
    tone.expression = expression;
    tone.pulseWidth = pulseWidth;
  }

  private static supersawSynth(
    this: void,
    synth: Synth,
    bufferIndex: number,
    runLength: number,
    tone: Tone,
  ): void {
    const data: Float32Array = required(synth.tempMonoInstrumentSampleBuffer);
    const voiceCount = Config.supersawVoiceCount;
    let phaseDelta: number = required(tone.phaseDeltas[0]);
    const phaseDeltaScale: number = required(tone.phaseDeltaScales[0]);
    let expression: number = tone.expression;
    const expressionDelta: number = tone.expressionDelta;
    const { phases } = tone;
    let dynamism: number = tone.supersawDynamism;
    const dynamismDelta: number = tone.supersawDynamismDelta;
    const unisonDetunes = tone.supersawUnisonDetunes;
    let shape: number = tone.supersawShape;
    const shapeDelta: number = tone.supersawShapeDelta;
    const usesShape = shape !== 0 || shapeDelta !== 0;
    let delayLength: number = tone.supersawDelayLength;
    const delayLengthDelta: number = tone.supersawDelayLengthDelta;
    const delayLine: Float32Array = required(tone.supersawDelayLine);
    const delayBufferMask: number = Math.trunc(delayLine.length - 1);
    let delayIndex: number = Math.trunc(tone.supersawDelayIndex);
    delayIndex = (delayIndex & delayBufferMask) + delayLine.length;
    const stopIndex: number = bufferIndex + runLength;
    for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
      const phase: number = wrapSawPhase(required(phases[0]) + phaseDelta);
      let supersawSample: number = phase - 0.5 * (1 + (voiceCount - 1) * dynamism);
      if (phase < phaseDelta) {
        const t: number = phase / phaseDelta;
        supersawSample -= (t + t - t * t - 1) * 0.5;
      } else if (phase > 1 - phaseDelta) {
        const t: number = (phase - 1) / phaseDelta;
        supersawSample -= (t + t + t * t + 1) * 0.5;
      }

      phases[0] = phase;
      for (let i: number = 1; i < voiceCount; i++) {
        const detunedStep = phaseDelta * required(unisonDetunes[i]);
        const detunedPhase = wrapSawPhase(required(phases[i]) + detunedStep);
        supersawSample += detunedPhase * dynamism;
        if (detunedPhase < detunedStep) {
          const t = detunedPhase / detunedStep;
          supersawSample -= (t + t - t * t - 1) * 0.5 * dynamism;
        } else if (detunedPhase > 1 - detunedStep) {
          const t = (detunedPhase - 1) / detunedStep;
          supersawSample -= (t + t + t * t + 1) * 0.5 * dynamism;
        }

        phases[i] = detunedPhase;
      }
      // Retain history so enabling shape during playback has samples to read.
      delayLine[delayIndex & delayBufferMask] = supersawSample;
      let inputSample = supersawSample;
      if (usesShape) {
        const delaySampleTime = delayIndex - delayLength;
        const lowerIndex = Math.trunc(delaySampleTime);
        const delayRatio = delaySampleTime - lowerIndex;
        const prevDelaySample = required(delayLine[lowerIndex & delayBufferMask]);
        const nextDelaySample = required(delayLine[(lowerIndex + 1) & delayBufferMask]);
        const delaySample = prevDelaySample + (nextDelaySample - prevDelaySample) * delayRatio;
        inputSample -= delaySample * shape;
        shape += shapeDelta;
      }
      delayIndex++;
      const sample = inputSample;
      phaseDelta *= phaseDeltaScale;
      dynamism += dynamismDelta;
      delayLength += delayLengthDelta;
      const output: number = sample * expression;
      expression += expressionDelta;
      data[sampleIndex] = required(data[sampleIndex]) + output;
    }
    tone.phaseDeltas[0] = phaseDelta;
    tone.expression = expression;
    tone.supersawDynamism = dynamism;
    tone.supersawShape = shape;
    tone.supersawDelayLength = delayLength;
    tone.supersawDelayIndex = delayIndex;
  }

  private static noiseSynth(
    this: void,
    synth: Synth,
    bufferIndex: number,
    runLength: number,
    tone: Tone,
    instrumentState: InstrumentState,
  ): void {
    const data: Float32Array = required(synth.tempMonoInstrumentSampleBuffer);
    const wave: Float32Array = required(instrumentState.wave);
    const intervalExpression: number = tone.specialIntervalExpressionMult;
    if (!required(instrumentState.chord).customInterval) {
      tone.phases[1] = required(tone.phases[0]);
    }
    let phaseDeltaA: number = required(tone.phaseDeltas[0]);
    let phaseDeltaB: number = required(tone.phaseDeltas[1]);
    const phaseDeltaScaleA: number = required(tone.phaseDeltaScales[0]);
    const phaseDeltaScaleB: number = required(tone.phaseDeltaScales[1]);
    let expression: number = tone.expression;
    const expressionDelta: number = tone.expressionDelta;
    let phaseA: number = (required(tone.phases[0]) % 1) * Config.chipNoiseLength;
    let phaseB: number = (required(tone.phases[1]) % 1) * Config.chipNoiseLength;
    if (tone.phases[0] === 0) {
      phaseA = Math.random() * Config.chipNoiseLength;
      if (!required(instrumentState.chord).customInterval) {
        phaseB = phaseA;
      }
    }
    if (tone.phases[1] === 0 && required(instrumentState.chord).customInterval) {
      phaseB = Math.random() * Config.chipNoiseLength;
    }
    const phaseMask: number = Config.chipNoiseLength - 1;
    let noiseSampleA: number = tone.noiseSampleA;
    let noiseSampleB: number = tone.noiseSampleB;
    const pitchRelativefilterA: number = Math.min(
      1,
      phaseDeltaA * instrumentState.noisePitchFilterMult,
    );
    const pitchRelativefilterB: number = Math.min(
      1,
      phaseDeltaB * instrumentState.noisePitchFilterMult,
    );
    const stopIndex: number = bufferIndex + runLength;
    for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
      const waveSampleA: number = required(wave[phaseA & phaseMask]);
      const waveSampleB: number = required(wave[phaseB & phaseMask]);
      noiseSampleA += (waveSampleA - noiseSampleA) * pitchRelativefilterA;
      noiseSampleB += (waveSampleB - noiseSampleB) * pitchRelativefilterB;
      const inputSample: number = noiseSampleA + noiseSampleB * intervalExpression;
      const sample = inputSample;
      phaseA += phaseDeltaA;
      phaseB += phaseDeltaB;
      phaseDeltaA *= phaseDeltaScaleA;
      phaseDeltaB *= phaseDeltaScaleB;
      const output: number = sample * expression;
      expression += expressionDelta;
      data[sampleIndex] = required(data[sampleIndex]) + output;
    }
    tone.phases[0] = phaseA / Config.chipNoiseLength;
    tone.phases[1] = phaseB / Config.chipNoiseLength;
    tone.phaseDeltas[0] = phaseDeltaA;
    tone.phaseDeltas[1] = phaseDeltaB;
    tone.expression = expression;
    tone.noiseSampleA = noiseSampleA;
    tone.noiseSampleB = noiseSampleB;
  }

  private static spectrumSynth(
    this: void,
    synth: Synth,
    bufferIndex: number,
    runLength: number,
    tone: Tone,
    instrumentState: InstrumentState,
  ): void {
    const data: Float32Array = required(synth.tempMonoInstrumentSampleBuffer);
    const wave: Float32Array = required(instrumentState.wave);
    const samplesInPeriod: number = 1 << 7;
    const intervalExpression: number = tone.specialIntervalExpressionMult;
    if (!required(instrumentState.chord).customInterval) {
      tone.phases[1] = required(tone.phases[0]);
    }
    let phaseDeltaA: number = required(tone.phaseDeltas[0]) * samplesInPeriod;
    let phaseDeltaB: number = required(tone.phaseDeltas[1]) * samplesInPeriod;
    const phaseDeltaScaleA: number = required(tone.phaseDeltaScales[0]);
    const phaseDeltaScaleB: number = required(tone.phaseDeltaScales[1]);
    let expression: number = tone.expression;
    const expressionDelta: number = tone.expressionDelta;
    let noiseSampleA: number = tone.noiseSampleA;
    let noiseSampleB: number = tone.noiseSampleB;
    let phaseA: number = (required(tone.phases[0]) % 1) * Config.spectrumNoiseLength;
    let phaseB: number = (required(tone.phases[1]) % 1) * Config.spectrumNoiseLength;
    if (tone.phases[0] === 0) {
      phaseA = Synth.findRandomZeroCrossing(wave, Config.spectrumNoiseLength) + phaseDeltaA;
      if (!required(instrumentState.chord).customInterval) {
        phaseB = phaseA;
      }
    }
    if (tone.phases[1] === 0 && required(instrumentState.chord).customInterval) {
      phaseB = Synth.findRandomZeroCrossing(wave, Config.spectrumNoiseLength) + phaseDeltaB;
    }
    const phaseMask: number = Config.spectrumNoiseLength - 1;
    const pitchRelativefilterA: number = Math.min(1, phaseDeltaA);
    const pitchRelativefilterB: number = Math.min(1, phaseDeltaB);
    const stopIndex: number = bufferIndex + runLength;
    for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
      const phaseAInt: number = Math.trunc(phaseA);
      const phaseBInt: number = Math.trunc(phaseB);
      const indexA: number = phaseAInt & phaseMask;
      const indexB: number = phaseBInt & phaseMask;
      let waveSampleA: number = required(wave[indexA]);
      let waveSampleB: number = required(wave[indexB]);
      const phaseRatioA: number = phaseA - phaseAInt;
      const phaseRatioB: number = phaseB - phaseBInt;
      waveSampleA += (required(wave[indexA + 1]) - waveSampleA) * phaseRatioA;
      waveSampleB += (required(wave[indexB + 1]) - waveSampleB) * phaseRatioB;
      noiseSampleA += (waveSampleA - noiseSampleA) * pitchRelativefilterA;
      noiseSampleB += (waveSampleB - noiseSampleB) * pitchRelativefilterB;
      const inputSample: number = noiseSampleA + noiseSampleB * intervalExpression;
      const sample = inputSample;
      phaseA += phaseDeltaA;
      phaseB += phaseDeltaB;
      phaseDeltaA *= phaseDeltaScaleA;
      phaseDeltaB *= phaseDeltaScaleB;
      const output: number = sample * expression;
      expression += expressionDelta;
      data[sampleIndex] = required(data[sampleIndex]) + output;
    }
    tone.phases[0] = phaseA / Config.spectrumNoiseLength;
    tone.phases[1] = phaseB / Config.spectrumNoiseLength;
    tone.phaseDeltas[0] = phaseDeltaA / samplesInPeriod;
    tone.phaseDeltas[1] = phaseDeltaB / samplesInPeriod;
    tone.expression = expression;
    tone.noiseSampleA = noiseSampleA;
    tone.noiseSampleB = noiseSampleB;
  }

  private static drumsetSynth(
    this: void,
    synth: Synth,
    bufferIndex: number,
    runLength: number,
    tone: Tone,
    instrumentState: InstrumentState,
  ): void {
    const data: Float32Array = required(synth.tempMonoInstrumentSampleBuffer);
    const wave: Float32Array = instrumentState.getDrumsetWave(required(tone.drumsetPitch));
    const referenceDelta: number = InstrumentState.drumsetIndexReferenceDelta(
      required(tone.drumsetPitch),
    );
    let phaseDelta: number = required(tone.phaseDeltas[0]) / referenceDelta;
    const phaseDeltaScale: number = required(tone.phaseDeltaScales[0]);
    let expression: number = tone.expression;
    const expressionDelta: number = tone.expressionDelta;
    const filters: DynamicBiquadFilter[] = tone.drumFilters;
    const filterCount: number = Math.trunc(tone.drumFilterCount);
    let initialFilterInput1: number = tone.drumFilterInput1;
    let initialFilterInput2: number = tone.drumFilterInput2;
    const { applyDrumFilter } = Synth;
    let phase: number = (required(tone.phases[0]) % 1) * Config.spectrumNoiseLength;
    if (tone.phases[0] === 0) {
      phase = Synth.findRandomZeroCrossing(wave, Config.spectrumNoiseLength) + phaseDelta;
    }
    const phaseMask: number = Config.spectrumNoiseLength - 1;
    const stopIndex: number = bufferIndex + runLength;
    for (let sampleIndex: number = bufferIndex; sampleIndex < stopIndex; sampleIndex++) {
      const phaseInt: number = Math.trunc(phase);
      const index: number = phaseInt & phaseMask;
      let noiseSample: number = required(wave[index]);
      const phaseRatio: number = phase - phaseInt;
      noiseSample += (required(wave[index + 1]) - noiseSample) * phaseRatio;
      const inputSample: number = noiseSample;
      const sample: number = applyDrumFilter(
        inputSample,
        initialFilterInput1,
        initialFilterInput2,
        filterCount,
        filters,
      );
      initialFilterInput2 = initialFilterInput1;
      initialFilterInput1 = inputSample;
      phase += phaseDelta;
      phaseDelta *= phaseDeltaScale;
      const output: number = sample * expression;
      expression += expressionDelta;
      data[sampleIndex] = required(data[sampleIndex]) + output;
    }
    tone.phases[0] = phase / Config.spectrumNoiseLength;
    tone.phaseDeltas[0] = phaseDelta * referenceDelta;
    tone.expression = expression;
    synth.sanitizeDrumFilters(filters);
    tone.drumFilterInput1 = initialFilterInput1;
    tone.drumFilterInput2 = initialFilterInput2;
  }

  private static findRandomZeroCrossing(
    this: void,
    wave: Float32Array,
    waveLength: number,
  ): number {
    let phase: number = Math.random() * waveLength;
    const phaseMask: number = waveLength - 1;
    let indexPrev: number = phase & phaseMask;
    let wavePrev: number = required(wave[indexPrev]);
    const stride: number = 16;
    for (let attemptsRemaining: number = 128; attemptsRemaining > 0; attemptsRemaining--) {
      const indexNext: number = (indexPrev + stride) & phaseMask;
      const waveNext: number = required(wave[indexNext]);
      if (wavePrev * waveNext <= 0) {
        for (let i: number = 0; i < stride; i++) {
          const innerIndexNext: number = (indexPrev + 1) & phaseMask;
          const innerWaveNext: number = required(wave[innerIndexNext]);
          if (wavePrev * innerWaveNext <= 0) {
            const slope: number = innerWaveNext - wavePrev;
            phase = indexPrev;
            if (Math.abs(slope) > 0.00000001) {
              phase += -wavePrev / slope;
            }
            phase = Math.max(0, phase) % waveLength;
            break;
          } else {
            indexPrev = innerIndexNext;
            wavePrev = innerWaveNext;
          }
        }
        break;
      } else {
        indexPrev = indexNext;
        wavePrev = waveNext;
      }
    }
    return phase;
  }

  public getTicksIntoBar(): number {
    return (this.beat * Config.partsPerBeat + this.part) * Config.ticksPerPart + this.tick;
  }

  public seek(value: number): void {
    let remainder = Math.max(0, Math.min(this.song.barCount, value));
    this.bar = Math.floor(remainder);
    remainder = this.song.beatsPerBar * (remainder - this.bar);
    this.beat = Math.floor(remainder);
    remainder = Config.partsPerBeat * (remainder - this.beat);
    this.part = Math.floor(remainder);
    remainder = Config.ticksPerPart * (remainder - this.part);
    this.tick = Math.floor(remainder);
    this.tickSampleCountdown = 0;
    this.isAtStartOfTick = true;
    this.prevBar = null;
  }

  public getCurrentPart(): number {
    return this.beat * Config.partsPerBeat + this.part;
  }

  public getInstrumentSynthFunction(instrument: Instrument): SynthFunction {
    switch (instrument.type) {
      case InstrumentType.chip: {
        return Synth.integratedWaveSynth;
      }
      case InstrumentType.noise: {
        return Synth.noiseSynth;
      }
      case InstrumentType.spectrum: {
        return Synth.spectrumSynth;
      }
      case InstrumentType.drumset: {
        return Synth.drumsetSynth;
      }
      case InstrumentType.harmonics: {
        return Synth.integratedWaveSynth;
      }
      case InstrumentType.pwm: {
        return Synth.pulseWidthSynth;
      }
      case InstrumentType.pickedString: {
        return Synth.pickedStringSynth;
      }
      case InstrumentType.supersaw: {
        return Synth.supersawSynth;
      }
      default: {
        throw new Error("Unsupported instrument type.");
      }
    }
  }
  public reset(): void {
    this.freeAllTones();
    this.instrumentState.reset();
  }

  public synthesize(
    outputDataL: Float64Array,
    outputDataR: Float64Array,
    outputBufferLength: number,
    playSong: boolean = true,
  ): boolean {
    const { instrumentState } = this;
    const song: Song = this.song;
    const { instrument } = song;

    const samplesPerTick: number = this.getSamplesPerTick();
    let sounded = false;
    if (this.tickSampleCountdown <= 0 || this.tickSampleCountdown > samplesPerTick) {
      this.tickSampleCountdown = samplesPerTick;
      this.isAtStartOfTick = true;
    }
    if (playSong) {
      if (this.beat >= song.beatsPerBar) {
        this.beat = 0;
        this.part = 0;
        this.tick = 0;
        this.tickSampleCountdown = samplesPerTick;
        this.isAtStartOfTick = true;
        this.prevBar = this.bar;
        this.bar = this.getNextBar();
      }
      if (this.bar >= song.barCount) {
        this.bar = 0;
      }
    }
    if (
      this.tempMonoInstrumentSampleBuffer === null ||
      this.tempMonoInstrumentSampleBuffer.length < outputBufferLength
    ) {
      this.tempMonoInstrumentSampleBuffer = new Float32Array(outputBufferLength);
    }
    let bufferIndex: number = 0;
    while (bufferIndex < outputBufferLength) {
      this.nextBar = this.getNextBar();
      if (this.nextBar >= song.barCount) {
        this.nextBar = null;
      }
      const samplesLeftInBuffer: number = outputBufferLength - bufferIndex;
      const samplesLeftInTick: number = Math.ceil(this.tickSampleCountdown);
      const runLength: number = Math.min(samplesLeftInTick, samplesLeftInBuffer);
      if (this.isAtStartOfTick) {
        this.determineCurrentActiveTones(song, samplesPerTick, playSong);
        this.determineLiveInputTones(song, samplesPerTick);
        let tonesPlayedInThisInstrument: number =
          instrumentState.activeTones.length + instrumentState.liveInputTones.length;
        for (let i: number = 0; i < instrumentState.releasedTones.length; i++) {
          const tone: Tone = required(instrumentState.releasedTones[i]);
          if (tone.ticksSinceReleased >= Math.abs(instrument.getFadeOutTicks())) {
            this.freeReleasedTone(instrumentState, i);
            i--;
            continue;
          }
          const shouldFadeOutFast: boolean =
            tonesPlayedInThisInstrument >= Config.maximumTonesPerChannel;
          this.computeTone(song, samplesPerTick, tone, true, shouldFadeOutFast);
          tonesPlayedInThisInstrument++;
        }
        if (instrumentState.awake) {
          if (!instrumentState.computed) {
            instrumentState.compute(this, instrument, Math.ceil(samplesPerTick));
          }
          instrumentState.computed = false;
        }
      }
      for (const tone of instrumentState.activeTones) {
        this.playTone(bufferIndex, runLength, tone);
      }
      for (const tone of instrumentState.liveInputTones) {
        this.playTone(bufferIndex, runLength, tone);
      }
      for (const tone of instrumentState.releasedTones) {
        this.playTone(bufferIndex, runLength, tone);
      }
      if (instrumentState.awake) {
        sounded = true;
        Synth.mixInstrument(
          this,
          outputDataL,
          outputDataR,
          bufferIndex,
          runLength,
          instrumentState,
        );
      }
      bufferIndex += runLength;
      this.isAtStartOfTick = false;
      this.tickSampleCountdown -= runLength;
      if (this.tickSampleCountdown <= 0) {
        this.isAtStartOfTick = true;

        for (let i: number = 0; i < instrumentState.releasedTones.length; i++) {
          const tone: Tone = required(instrumentState.releasedTones[i]);
          if (tone.isOnLastTick) {
            this.freeReleasedTone(instrumentState, i);
            i--;
          } else {
            tone.ticksSinceReleased++;
          }
        }
        if (instrumentState.deactivateAfterThisTick) {
          instrumentState.deactivate();
        }
        instrumentState.tonesAddedInThisTick = false;
        const useArpeggioSpeed: number = instrument.arpeggioSpeed;
        instrumentState.arpTime += required(Config.arpSpeedScale[useArpeggioSpeed]);
        instrumentState.envelopeTime++;

        this.tick++;
        this.tickSampleCountdown += samplesPerTick;
        if (this.tick === Config.ticksPerPart) {
          this.tick = 0;
          this.part++;

          if (this.part === Config.partsPerBeat) {
            this.part = 0;
            if (playSong) {
              this.beat++;
              if (this.beat === song.beatsPerBar) {
                this.beat = 0;
                this.prevBar = this.bar;
                this.bar = this.getNextBar();
                if (this.bar >= song.barCount) {
                  this.bar = 0;
                }
              }
            }
          }
        }
      }
      instrumentState.arpTime %= 2520 * Config.ticksPerArpeggio;
      instrumentState.envelopeTime %=
        Config.partsPerBeat * Config.ticksPerPart * this.song.beatsPerBar;
    }
    return sounded;
  }

  public freeAllTones(): void {
    const { activeTones, releasedTones, liveInputTones } = this.instrumentState;
    for (const tones of [activeTones, releasedTones, liveInputTones]) {
      while (tones.length > 0) {
        this.freeTone(required(tones.pop()));
      }
    }
  }

  public sanitizeDrumFilters(filters: DynamicBiquadFilter[]): void {
    let reset: boolean = false;
    for (const filter of filters) {
      const output1: number = Math.abs(filter.output1);
      const output2: number = Math.abs(filter.output2);
      if (!(output1 < 100) || !(output2 < 100)) {
        reset = true;
        break;
      }
      if (output1 < epsilon) {
        filter.output1 = 0;
      }
      if (output2 < epsilon) {
        filter.output2 = 0;
      }
    }
    if (reset) {
      for (const filter of filters) {
        filter.output1 = 0;
        filter.output2 = 0;
      }
    }
  }

  private getNextBar(): number {
    const nextBar = this.bar + 1;
    return nextBar === this.song.loopStart + this.song.loopLength ? this.song.loopStart : nextBar;
  }

  private freeTone(tone: Tone): void {
    this.tonePool.push(tone);
  }

  private newTone(): Tone {
    const tone = this.tonePool.pop() ?? new Tone();
    tone.freshlyAllocated = true;
    return tone;
  }

  private releaseTone(instrumentState: InstrumentState, tone: Tone): void {
    // The newest releases keep priority when the instrument exceeds its tone limit.
    instrumentState.releasedTones.unshift(tone);
    tone.atNoteStart = false;
    tone.passedEndOfNote = true;
  }

  private freeReleasedTone(instrumentState: InstrumentState, toneIndex: number): void {
    const [tone] = instrumentState.releasedTones.splice(toneIndex, 1);
    this.freeTone(required(tone));
  }

  private determineLiveInputTones(song: Song, samplesPerTick: number): void {
    const { instrumentState } = this;
    const { instrument } = song;
    const pitches: number[] = this.liveInputPitches;
    const toneList = instrumentState.liveInputTones;
    let toneCount: number = 0;
    if (pitches.length > 0) {
      if (instrument.getChord().singleTone) {
        const tone = this.reuseTone(
          toneList,
          toneCount,
          instrumentState,
          !instrument.getTransition().isSeamless && this.liveInputStarted,
        );
        toneCount++;
        for (let i: number = 0; i < pitches.length; i++) {
          tone.pitches[i] = required(pitches[i]);
        }
        tone.pitchCount = pitches.length;
        tone.chordSize = 1;
        tone.nextNote = null;
        tone.prevNote = null;
        tone.note = null;
        tone.atNoteStart = this.liveInputStarted;
        tone.forceContinueAtStart = false;
        tone.forceContinueAtEnd = false;
        this.computeTone(song, samplesPerTick, tone, false, false);
      } else {
        this.matchTonesByPitch(toneList, pitches);
        for (const element of pitches) {
          let tone = this.tempMatchedPitchTones[toneCount];
          this.tempMatchedPitchTones[toneCount] = null;
          if (tone && (tone.pitchCount !== 1 || tone.pitches[0] !== element)) {
            this.releaseTone(instrumentState, tone);
            tone = null;
          }
          tone ??= this.newTone();
          toneList.push(tone);
          toneCount++;
          tone.pitches[0] = required(element);
          tone.pitchCount = 1;
          tone.chordSize = pitches.length;
          tone.nextNote = null;
          tone.prevNote = null;
          tone.note = null;
          tone.atNoteStart = this.liveInputStarted;
          tone.forceContinueAtStart = false;
          tone.forceContinueAtEnd = false;
          this.computeTone(song, samplesPerTick, tone, false, false);
        }
      }
    }

    while (toneList.length > toneCount) {
      this.releaseTone(instrumentState, required(toneList.pop()));
    }
    this.clearTempMatchedPitchTones(toneCount, instrumentState);

    this.liveInputStarted = false;
  }

  private matchTonesByPitch(toneList: Tone[], notePitches: number[]): void {
    let unmatched = 0;
    for (const tone of toneList) {
      const pitch = required(tone.pitches[0]) + tone.lastInterval;
      const match = notePitches.indexOf(pitch);
      if (match === -1) {
        toneList[unmatched++] = tone;
      } else {
        this.tempMatchedPitchTones[match] = tone;
      }
    }
    // Keep unmatched tones in their original order for reuse at the other pitches.
    for (let i = 0; i < unmatched; i++) {
      const slot = this.tempMatchedPitchTones.indexOf(null);
      if (slot === -1) {
        break;
      }
      this.tempMatchedPitchTones[slot] = required(toneList[i]);
    }
    toneList.length = 0;
  }

  private determineCurrentActiveTones(song: Song, samplesPerTick: number, playSong: boolean): void {
    const { instrumentState } = this;
    const { instrument } = song;
    const pattern: Pattern | null = song.getPattern(this.bar);
    const currentPart: number = this.getCurrentPart();
    const currentTick: number = this.tick + Config.ticksPerPart * currentPart;
    let note: Note | null = null;
    let prevNote: Note | null = null;
    let nextNote: Note | null = null;
    if (playSong && pattern !== null) {
      for (const element of pattern.notes) {
        if (required(element).end <= currentPart) {
          prevNote = required(element);
        } else if (required(element).start <= currentPart && required(element).end > currentPart) {
          note = required(element);
        } else if (required(element).start > currentPart) {
          nextNote = required(element);
          break;
        }
      }
      if (note !== null) {
        if (prevNote !== null && prevNote.end !== note.start) {
          prevNote = null;
        }
        if (nextNote !== null && nextNote.start !== note.end) {
          nextNote = null;
        }
      }
    }
    const toneList = instrumentState.activeTones;
    let toneCount: number = 0;
    if (note !== null) {
      let prevNoteForThisInstrument: Note | null = prevNote;
      let nextNoteForThisInstrument: Note | null = nextNote;
      const partsPerBar: number = Config.partsPerBeat * song.beatsPerBar;
      const transition: Transition = instrument.getTransition();
      const chord: Chord = instrument.getChord();
      let forceContinueAtStart: boolean = false;
      let forceContinueAtEnd: boolean = false;
      let tonesInPrevNote: number = 0;
      let tonesInNextNote: number = 0;
      if (note.start === 0) {
        const prevPattern: Pattern | null =
          this.prevBar === null ? null : song.getPattern(this.prevBar);
        if (prevPattern !== null) {
          const lastNote: Note | null =
            (prevPattern.notes.length <= 0 ? null : prevPattern.notes.at(-1)) ?? null;
          if (lastNote?.end === partsPerBar) {
            const patternForcesContinueAtStart: boolean =
              note.continuesLastPattern && Synth.adjacentNotesHaveMatchingPitches(lastNote, note);
            if (patternForcesContinueAtStart || transition.includeAdjacentPatterns) {
              prevNoteForThisInstrument = lastNote;
              tonesInPrevNote = chord.singleTone ? 1 : prevNoteForThisInstrument.pitches.length;
              forceContinueAtStart = patternForcesContinueAtStart;
            }
          }
        }
      } else if (prevNoteForThisInstrument !== null) {
        tonesInPrevNote = chord.singleTone ? 1 : prevNoteForThisInstrument.pitches.length;
      }
      if (note.end === partsPerBar) {
        const nextPattern: Pattern | null =
          this.nextBar === null ? null : song.getPattern(this.nextBar);
        if (nextPattern !== null) {
          const firstNote: Note | null =
            (nextPattern.notes.length <= 0 ? null : nextPattern.notes[0]) ?? null;
          if (firstNote?.start === 0) {
            const nextPatternForcesContinueAtStart: boolean =
              firstNote.continuesLastPattern &&
              Synth.adjacentNotesHaveMatchingPitches(note, firstNote);
            if (nextPatternForcesContinueAtStart || transition.includeAdjacentPatterns) {
              nextNoteForThisInstrument = firstNote;
              tonesInNextNote = chord.singleTone ? 1 : nextNoteForThisInstrument.pitches.length;
              forceContinueAtEnd = nextPatternForcesContinueAtStart;
            }
          }
        }
      } else if (nextNoteForThisInstrument !== null) {
        tonesInNextNote = chord.singleTone ? 1 : nextNoteForThisInstrument.pitches.length;
      }
      if (chord.singleTone) {
        const atNoteStart: boolean = Config.ticksPerPart * note.start === currentTick;
        const tone = this.reuseTone(
          toneList,
          toneCount,
          instrumentState,
          atNoteStart &&
            ((!transition.isSeamless && !forceContinueAtStart) ||
              prevNoteForThisInstrument === null),
        );
        toneCount++;
        for (let i: number = 0; i < note.pitches.length; i++) {
          tone.pitches[i] = required(note.pitches[i]);
        }
        tone.pitchCount = note.pitches.length;
        tone.chordSize = 1;
        tone.note = note;
        tone.noteStartPart = note.start;
        tone.noteEndPart = note.end;
        tone.prevNote = prevNoteForThisInstrument;
        tone.nextNote = nextNoteForThisInstrument;
        tone.prevNotePitchIndex = 0;
        tone.nextNotePitchIndex = 0;
        tone.atNoteStart = atNoteStart;
        tone.passedEndOfNote = false;
        tone.forceContinueAtStart = forceContinueAtStart;
        tone.forceContinueAtEnd = forceContinueAtEnd;
        this.computeTone(song, samplesPerTick, tone, false, false);
      } else {
        const transitionLocal2649: Transition = instrument.getTransition();
        if (
          ((transitionLocal2649.isSeamless &&
            !transitionLocal2649.slides &&
            chord.strumParts === 0) ||
            forceContinueAtStart) &&
          Config.ticksPerPart * note.start === currentTick &&
          prevNoteForThisInstrument !== null
        ) {
          this.matchTonesByPitch(toneList, note.pitches);
        }
        let strumOffsetParts: number = 0;
        for (let i: number = 0; i < note.pitches.length; i++) {
          let prevNoteForThisTone: Note | null =
            tonesInPrevNote > i ? prevNoteForThisInstrument : null;
          let noteForThisTone: Note = note;
          let nextNoteForThisTone: Note | null =
            tonesInNextNote > i ? nextNoteForThisInstrument : null;
          let noteStartPart: number = noteForThisTone.start + strumOffsetParts;
          let passedEndOfNote: boolean = false;
          if (noteStartPart > currentPart) {
            if (
              toneList.length > i &&
              (transitionLocal2649.isSeamless || forceContinueAtStart) &&
              prevNoteForThisTone !== null
            ) {
              nextNoteForThisTone = noteForThisTone;
              noteForThisTone = prevNoteForThisTone;
              prevNoteForThisTone = null;
              noteStartPart = noteForThisTone.start + strumOffsetParts;
              passedEndOfNote = true;
            } else {
              break;
            }
          }
          let noteEndPart: number = noteForThisTone.end;
          if (
            (transitionLocal2649.isSeamless || forceContinueAtStart) &&
            nextNoteForThisTone !== null
          ) {
            noteEndPart = Math.min(
              Config.partsPerBeat * required(this.song).beatsPerBar,
              noteEndPart + strumOffsetParts,
            );
          }
          if (
            (!transitionLocal2649.continues && !forceContinueAtStart) ||
            prevNoteForThisTone === null
          ) {
            strumOffsetParts += chord.strumParts;
          }
          const atNoteStart: boolean = Config.ticksPerPart * noteStartPart === currentTick;
          const matched = this.tempMatchedPitchTones[toneCount];
          const tone =
            matched ??
            this.reuseTone(
              toneList,
              toneCount,
              instrumentState,
              atNoteStart &&
                ((!transitionLocal2649.isSeamless && !forceContinueAtStart) ||
                  prevNoteForThisTone === null),
            );
          if (matched) {
            this.tempMatchedPitchTones[toneCount] = null;
            toneList.push(tone);
          }
          toneCount++;
          tone.pitches[0] = required(noteForThisTone.pitches[i]);
          tone.pitchCount = 1;
          tone.chordSize = noteForThisTone.pitches.length;
          tone.note = noteForThisTone;
          tone.noteStartPart = noteStartPart;
          tone.noteEndPart = noteEndPart;
          tone.prevNote = prevNoteForThisTone;
          tone.nextNote = nextNoteForThisTone;
          tone.prevNotePitchIndex = i;
          tone.nextNotePitchIndex = i;
          tone.atNoteStart = atNoteStart;
          tone.passedEndOfNote = passedEndOfNote;
          tone.forceContinueAtStart = forceContinueAtStart && prevNoteForThisTone !== null;
          tone.forceContinueAtEnd = forceContinueAtEnd && nextNoteForThisTone !== null;
          this.computeTone(song, samplesPerTick, tone, false, false);
        }
      }
    }
    while (toneList.length > toneCount) {
      const tone: Tone = required(toneList.pop());
      if (!tone.isOnLastTick) {
        this.releaseTone(instrumentState, tone);
      } else {
        this.freeTone(tone);
      }
    }
    this.clearTempMatchedPitchTones(toneCount, instrumentState);
  }

  private reuseTone(list: Tone[], index: number, state: InstrumentState, restart: boolean): Tone {
    const previous = list[index];
    if (previous) {
      if (!restart) {
        return previous;
      }
      if (previous.isOnLastTick) {
        this.freeTone(previous);
      } else {
        this.releaseTone(state, previous);
      }
    }
    const tone = this.newTone();
    list[index] = tone;
    return tone;
  }
  private clearTempMatchedPitchTones(toneCount: number, instrumentState: InstrumentState): void {
    for (let i: number = toneCount; i < this.tempMatchedPitchTones.length; i++) {
      const oldTone: Tone | null = this.tempMatchedPitchTones[i] ?? null;
      if (oldTone !== null) {
        if (oldTone.isOnLastTick) {
          this.freeTone(oldTone);
        } else {
          this.releaseTone(instrumentState, oldTone);
        }
        this.tempMatchedPitchTones[i] = null;
      }
    }
  }

  private playTone(bufferIndex: number, runLength: number, tone: Tone): void {
    const { instrumentState } = this;
    if (instrumentState.synthesizer !== null) {
      required(instrumentState.synthesizer)(this, bufferIndex, runLength, tone, instrumentState);
    }
    tone.envelopeComputer.clearEnvelopes();
  }

  private computeTone(
    song: Song,
    samplesPerTick: number,
    tone: Tone,
    released: boolean,
    shouldFadeOutFast: boolean,
  ): void {
    const { instrumentState } = this;
    const { instrument } = song;
    const roundedSamplesPerTick: number = Math.ceil(samplesPerTick);
    instrumentState.awake = true;
    instrumentState.tonesAddedInThisTick = true;
    if (!instrumentState.computed) {
      instrumentState.compute(this, instrument, roundedSamplesPerTick);
    }
    const transition: Transition = instrument.getTransition();
    const chord: Chord = instrument.getChord();
    const chordExpression: number = chord.singleTone
      ? 1
      : Synth.computeChordExpression(tone.chordSize);
    const sampleTime: number = 1 / this.samplesPerSecond;
    const beatsPerPart: number = 1 / Config.partsPerBeat;
    const beatsPerTick: number = beatsPerPart / Config.ticksPerPart;
    const ticksIntoBar: number = this.getTicksIntoBar();
    const partTimeStart: number = ticksIntoBar / Config.ticksPerPart;
    const partTimeEnd: number = (ticksIntoBar + 1) / Config.ticksPerPart;
    const songClockStart: SongEnvelopeClock = {
      songBar: this.bar,
      songBeats: this.bar * song.beatsPerBar + ticksIntoBar * beatsPerTick,
      secondsPerBeat: 60 / song.tempo,
    };
    const songClockEnd: SongEnvelopeClock = {
      ...songClockStart,
      songBeats: songClockStart.songBeats + beatsPerTick,
    };
    const currentPart: number = this.getCurrentPart();
    let specialIntervalMult: number = 1;
    tone.specialIntervalExpressionMult = 1;
    let toneIsOnLastTick: boolean = shouldFadeOutFast;
    let intervalStart: number = 0;
    let intervalEnd: number = 0;
    let fadeExpressionStart = 1;
    let fadeExpressionEnd = 1;
    let chordExpressionStart: number = chordExpression;
    let chordExpressionEnd: number = chordExpression;
    let expressionReferencePitch: number = 16;
    let basePitch: number = Config.pitchesPerOctave + song.key;
    let baseExpression = Config.chipBaseExpression;
    let pitchDamping: number = 48;
    if (instrument.type === InstrumentType.spectrum) {
      baseExpression = Config.spectrumBaseExpression;
      expressionReferencePitch = Config.spectrumBasePitch;
      pitchDamping = 28;
    } else if (instrument.type === InstrumentType.drumset) {
      basePitch = Config.spectrumBasePitch;
      baseExpression = Config.drumsetBaseExpression;
      expressionReferencePitch = basePitch;
    } else if (instrument.type === InstrumentType.noise) {
      basePitch += required(Config.chipNoises[instrument.chipNoise]).basePitch - 12;
      baseExpression = Config.noiseBaseExpression;
      expressionReferencePitch = basePitch;
      pitchDamping = required(Config.chipNoises[instrument.chipNoise]).isSoft ? 24 : 60;
    } else if (instrument.type === InstrumentType.harmonics) {
      baseExpression = Config.harmonicsBaseExpression;
    } else if (instrument.type === InstrumentType.pwm) {
      baseExpression = Config.pwmBaseExpression;
    } else if (instrument.type === InstrumentType.supersaw) {
      baseExpression = Config.supersawBaseExpression;
    } else if (instrument.type === InstrumentType.pickedString) {
      baseExpression = Config.pickedStringBaseExpression;
    } else if (instrument.type !== InstrumentType.chip) {
      throw new Error("Unknown instrument type in computeTone.");
    }
    if (
      (tone.atNoteStart && !transition.isSeamless && !tone.forceContinueAtStart) ||
      tone.freshlyAllocated
    ) {
      tone.reset();
    }
    tone.freshlyAllocated = false;
    for (let i: number = 0; i < Config.maxChordSize; i++) {
      tone.phaseDeltas[i] = 0;
      tone.phaseDeltaScales[i] = 0;
    }
    tone.expression = 0;
    tone.expressionDelta = 0;
    if (released) {
      const startTicksSinceReleased: number = tone.ticksSinceReleased;
      const endTicksSinceReleased: number = tone.ticksSinceReleased + 1;
      intervalEnd = tone.lastInterval;
      intervalStart = tone.lastInterval;
      const fadeOutTicks: number = Math.abs(instrument.getFadeOutTicks());
      fadeExpressionStart = noteSizeToVolumeMult(
        (1 - startTicksSinceReleased / fadeOutTicks) * Config.noteSizeMax,
      );
      fadeExpressionEnd = noteSizeToVolumeMult(
        (1 - endTicksSinceReleased / fadeOutTicks) * Config.noteSizeMax,
      );
      if (shouldFadeOutFast) {
        fadeExpressionEnd = 0;
      }
      if (tone.ticksSinceReleased + 1 >= fadeOutTicks) {
        toneIsOnLastTick = true;
      }
    } else if (tone.note === null) {
      tone.lastInterval = 0;
      tone.ticksSinceReleased = 0;
      tone.liveInputSamplesHeld += roundedSamplesPerTick;
    } else {
      const note: Note = tone.note;
      const nextNote: Note | null = tone.nextNote;
      const noteStartPart: number = tone.noteStartPart;
      const noteEndPart: number = tone.noteEndPart;
      const endPinIndex: number = note.getEndPinIndex(currentPart);
      const startPin: NotePin = required(note.pins[endPinIndex - 1]);
      const endPin: NotePin = required(note.pins[endPinIndex]);
      const noteStartTick: number = noteStartPart * Config.ticksPerPart;
      const noteEndTick: number = noteEndPart * Config.ticksPerPart;
      const pinStart: number = (note.start + startPin.time) * Config.ticksPerPart;
      const pinEnd: number = (note.start + endPin.time) * Config.ticksPerPart;
      tone.ticksSinceReleased = 0;
      const tickTimeStart: number = currentPart * Config.ticksPerPart + this.tick;
      const tickTimeEnd: number = tickTimeStart + 1;
      const noteTicksPassedTickStart: number = tickTimeStart - noteStartTick;
      const noteTicksPassedTickEnd: number = tickTimeEnd - noteStartTick;
      const pinRatioStart: number = Math.min(1, (tickTimeStart - pinStart) / (pinEnd - pinStart));
      const pinRatioEnd: number = Math.min(1, (tickTimeEnd - pinStart) / (pinEnd - pinStart));
      intervalStart = startPin.interval + (endPin.interval - startPin.interval) * pinRatioStart;
      intervalEnd = startPin.interval + (endPin.interval - startPin.interval) * pinRatioEnd;
      tone.lastInterval = intervalEnd;
      if ((!transition.isSeamless && !tone.forceContinueAtEnd) || nextNote === null) {
        const fadeOutTicks: number = -instrument.getFadeOutTicks();
        if (fadeOutTicks > 0) {
          const noteLengthTicks: number = noteEndTick - noteStartTick;
          fadeExpressionStart *= Math.min(
            1,
            (noteLengthTicks - noteTicksPassedTickStart) / fadeOutTicks,
          );
          fadeExpressionEnd *= Math.min(
            1,
            (noteLengthTicks - noteTicksPassedTickEnd) / fadeOutTicks,
          );
          if (tickTimeEnd >= noteStartTick + noteLengthTicks) {
            toneIsOnLastTick = true;
          }
        }
      }
    }
    tone.isOnLastTick = toneIsOnLastTick;
    const envelopeComputer: EnvelopeComputer = tone.envelopeComputer;
    envelopeComputer.computeEnvelopes(
      instrument,
      currentPart,
      instrumentState.envelopeTime,
      Config.ticksPerPart * partTimeStart,
      samplesPerTick / this.samplesPerSecond,
      tone,
      songClockStart,
      songClockEnd,
    );
    const envelopeStarts: number[] = tone.envelopeComputer.envelopeStarts;
    const envelopeEnds: number[] = tone.envelopeComputer.envelopeEnds;
    if (tone.note !== null && transition.slides) {
      const prevNote: Note | null = tone.prevNote;
      const nextNote: Note | null = tone.nextNote;
      if (prevNote !== null) {
        const intervalDiff: number =
          required(prevNote.pitches[tone.prevNotePitchIndex]) +
          required(prevNote.pins.at(-1)).interval -
          required(tone.pitches[0]);
        if (envelopeComputer.prevSlideStart) {
          intervalStart += intervalDiff * envelopeComputer.prevSlideRatioStart;
        }
        if (envelopeComputer.prevSlideEnd) {
          intervalEnd += intervalDiff * envelopeComputer.prevSlideRatioEnd;
        }
        if (!chord.singleTone) {
          const chordSizeDiff: number = prevNote.pitches.length - tone.chordSize;
          if (envelopeComputer.prevSlideStart) {
            chordExpressionStart = Synth.computeChordExpression(
              tone.chordSize + chordSizeDiff * envelopeComputer.prevSlideRatioStart,
            );
          }
          if (envelopeComputer.prevSlideEnd) {
            chordExpressionEnd = Synth.computeChordExpression(
              tone.chordSize + chordSizeDiff * envelopeComputer.prevSlideRatioEnd,
            );
          }
        }
      }
      if (nextNote !== null) {
        const intervalDiff: number =
          required(nextNote.pitches[tone.nextNotePitchIndex]) -
          (required(tone.pitches[0]) + required(tone.note.pins.at(-1)).interval);
        if (envelopeComputer.nextSlideStart) {
          intervalStart += intervalDiff * envelopeComputer.nextSlideRatioStart;
        }
        if (envelopeComputer.nextSlideEnd) {
          intervalEnd += intervalDiff * envelopeComputer.nextSlideRatioEnd;
        }
        if (!chord.singleTone) {
          const chordSizeDiff: number = nextNote.pitches.length - tone.chordSize;
          if (envelopeComputer.nextSlideStart) {
            chordExpressionStart = Synth.computeChordExpression(
              tone.chordSize + chordSizeDiff * envelopeComputer.nextSlideRatioStart,
            );
          }
          if (envelopeComputer.nextSlideEnd) {
            chordExpressionEnd = Synth.computeChordExpression(
              tone.chordSize + chordSizeDiff * envelopeComputer.nextSlideRatioEnd,
            );
          }
        }
      }
    }
    intervalStart += instrument.songDetuneCents / 100;
    intervalEnd += instrument.songDetuneCents / 100;
    if ((!transition.isSeamless && !tone.forceContinueAtStart) || tone.prevNote === null) {
      const fadeInSeconds: number = instrument.getFadeInSeconds();
      if (fadeInSeconds > 0) {
        fadeExpressionStart *= Math.min(1, envelopeComputer.noteSecondsStart / fadeInSeconds);
        fadeExpressionEnd *= Math.min(1, envelopeComputer.noteSecondsEnd / fadeInSeconds);
      }
    }
    if (instrument.type === InstrumentType.drumset && tone.drumsetPitch === null) {
      tone.drumsetPitch = required(tone.pitches[0]);
      if (tone.note !== null) {
        tone.drumsetPitch += tone.note.pickMainInterval();
      }
      tone.drumsetPitch = Math.max(0, Math.min(Config.drumCount - 1, required(tone.drumsetPitch)));
    }
    let drumFilterExpression = 1;
    tone.drumFilterCount = 0;
    if (instrument.type === InstrumentType.drumset) {
      const drumsetFilterEnvelope: Envelope = instrument.getDrumsetEnvelope(
        required(tone.drumsetPitch),
      );
      drumFilterExpression *=
        EnvelopeComputer.getLowpassCutoffDecayVolumeCompensation(drumsetFilterEnvelope);
      let drumsetFilterEnvelopeStart: number = drumsetFilterEnvelope.evaluate(
        envelopeComputer.noteSecondsStart,
        beatsPerPart * partTimeStart,
        envelopeComputer.noteSizeStart,
        envelopeTiming(envelopeComputer.noteTicksStart * beatsPerTick, songClockStart),
      );
      if (envelopeComputer.prevSlideStart) {
        const other: number = drumsetFilterEnvelope.evaluate(
          envelopeComputer.prevNoteSecondsStart,
          beatsPerPart * partTimeStart,
          envelopeComputer.prevNoteSize,
          envelopeTiming(envelopeComputer.prevNoteTicksStart * beatsPerTick, songClockStart),
        );
        drumsetFilterEnvelopeStart +=
          (other - drumsetFilterEnvelopeStart) * envelopeComputer.prevSlideRatioStart;
      }
      if (envelopeComputer.nextSlideStart) {
        const other: number = drumsetFilterEnvelope.evaluate(
          0,
          beatsPerPart * partTimeStart,
          envelopeComputer.nextNoteSize,
          envelopeTiming(0, songClockStart),
        );
        drumsetFilterEnvelopeStart +=
          (other - drumsetFilterEnvelopeStart) * envelopeComputer.nextSlideRatioStart;
      }
      let drumsetFilterEnvelopeEnd = drumsetFilterEnvelope.evaluate(
        envelopeComputer.noteSecondsEnd,
        beatsPerPart * partTimeEnd,
        envelopeComputer.noteSizeEnd,
        envelopeTiming(envelopeComputer.noteTicksEnd * beatsPerTick, songClockEnd),
      );
      if (envelopeComputer.prevSlideEnd) {
        const other: number = drumsetFilterEnvelope.evaluate(
          envelopeComputer.prevNoteSecondsEnd,
          beatsPerPart * partTimeEnd,
          envelopeComputer.prevNoteSize,
          envelopeTiming(envelopeComputer.prevNoteTicksEnd * beatsPerTick, songClockEnd),
        );
        drumsetFilterEnvelopeEnd +=
          (other - drumsetFilterEnvelopeEnd) * envelopeComputer.prevSlideRatioEnd;
      }
      if (envelopeComputer.nextSlideEnd) {
        const other: number = drumsetFilterEnvelope.evaluate(
          0,
          beatsPerPart * partTimeEnd,
          envelopeComputer.nextNoteSize,
          envelopeTiming(0, songClockEnd),
        );
        drumsetFilterEnvelopeEnd +=
          (other - drumsetFilterEnvelopeEnd) * envelopeComputer.nextSlideRatioEnd;
      }
      configureDrumFilter(
        tempFilterStartCoefficients,
        this.samplesPerSecond,
        drumsetFilterEnvelopeStart * (1 + drumsetFilterEnvelopeStart),
      );
      configureDrumFilter(
        tempFilterEndCoefficients,
        this.samplesPerSecond,
        drumsetFilterEnvelopeEnd * (1 + drumsetFilterEnvelopeEnd),
      );
      if (tone.drumFilters.length === tone.drumFilterCount) {
        tone.drumFilters[tone.drumFilterCount] = new DynamicBiquadFilter();
      }
      required(tone.drumFilters[tone.drumFilterCount]).loadCoefficientsWithGradient(
        tempFilterStartCoefficients,
        tempFilterEndCoefficients,
        1 / roundedSamplesPerTick,
      );
      tone.drumFilterCount++;
    }
    drumFilterExpression = Math.min(3, drumFilterExpression);
    const freqEndRatio: number = 2 ** ((intervalEnd - intervalStart) / 12);
    const basePhaseDeltaScale: number = freqEndRatio ** (1 / roundedSamplesPerTick);
    let pitch: number = required(tone.pitches[0]);
    if (tone.pitchCount > 1 && (chord.arpeggiates || chord.customInterval)) {
      const arpeggio: number = Math.floor(instrumentState.arpTime / Config.ticksPerArpeggio);
      if (chord.customInterval) {
        const intervalOffset: number =
          required(
            tone.pitches[
              1 + getArpeggioPitchIndex(tone.pitchCount - 1, instrument.fastTwoNoteArp, arpeggio)
            ],
          ) - required(tone.pitches[0]);
        specialIntervalMult = 2 ** (intervalOffset / 12);
        tone.specialIntervalExpressionMult = 2 ** (-intervalOffset / pitchDamping);
      } else {
        pitch = required(
          tone.pitches[getArpeggioPitchIndex(tone.pitchCount, instrument.fastTwoNoteArp, arpeggio)],
        );
      }
    }
    const startPitch: number = basePitch + (pitch + intervalStart);
    const endPitch: number = basePitch + (pitch + intervalEnd);
    const pitchExpressionStart =
      tone.prevPitchExpressions[0] ??
      2 ** (-(startPitch - expressionReferencePitch) / pitchDamping);
    const pitchExpressionEnd: number = 2 ** (-(endPitch - expressionReferencePitch) / pitchDamping);
    tone.prevPitchExpressions[0] = pitchExpressionEnd;
    let settingsExpressionMult: number = baseExpression * drumFilterExpression;
    if (instrument.type === InstrumentType.noise) {
      settingsExpressionMult *= required(Config.chipNoises[instrument.chipNoise]).expression;
    }
    if (instrument.type === InstrumentType.chip) {
      settingsExpressionMult *= required(Config.chipWaves[instrument.chipWave]).expression;
    }
    if (instrument.type === InstrumentType.pwm) {
      const basePulseWidth: number = getPulseWidthRatio(instrument.pulseWidth);
      const pulseWidthModStart: number = basePulseWidth;
      const pulseWidthModEnd: number = basePulseWidth;
      const pulseWidthStart: number =
        pulseWidthModStart * required(envelopeStarts[EnvelopeComputeIndex.pulseWidth]);
      const pulseWidthEnd: number =
        pulseWidthModEnd * required(envelopeEnds[EnvelopeComputeIndex.pulseWidth]);
      tone.pulseWidth = pulseWidthStart;
      tone.pulseWidthDelta = (pulseWidthEnd - pulseWidthStart) / roundedSamplesPerTick;
    }
    if (instrument.type === InstrumentType.pickedString) {
      const useSustainStart: number = instrument.stringSustain;
      const useSustainEnd: number = instrument.stringSustain;
      tone.stringSustainStart = useSustainStart;
      tone.stringSustainEnd = useSustainEnd;
      settingsExpressionMult *=
        2 ** (0.7 * (1 - useSustainStart / (Config.stringSustainRange - 1)));
    }
    const startFreq: number = Instrument.frequencyFromPitch(startPitch);
    if (
      instrument.type === InstrumentType.chip ||
      instrument.type === InstrumentType.harmonics ||
      instrument.type === InstrumentType.pickedString ||
      instrument.type === InstrumentType.spectrum ||
      instrument.type === InstrumentType.pwm ||
      instrument.type === InstrumentType.noise
    ) {
      settingsExpressionMult *= instrument.type === InstrumentType.pickedString ? 1.4 : 0.7;
      tone.phaseDeltas[0] = startFreq * sampleTime;
      tone.phaseDeltas[1] = startFreq * sampleTime * specialIntervalMult;
      tone.phaseDeltaScales[0] = basePhaseDeltaScale;
      tone.phaseDeltaScales[1] = basePhaseDeltaScale;
    } else {
      tone.phaseDeltas[0] = startFreq * sampleTime;
      tone.phaseDeltaScales[0] = basePhaseDeltaScale;
    }
    let supersawExpressionStart: number = 1;
    let supersawExpressionEnd: number = 1;
    if (instrument.type === InstrumentType.supersaw) {
      const minFirstVoiceAmplitude: number = 1 / Math.sqrt(Config.supersawVoiceCount);
      const useDynamismStart: number = instrument.supersawDynamism / Config.supersawDynamismMax;
      const useDynamismEnd: number = instrument.supersawDynamism / Config.supersawDynamismMax;
      const curvedDynamismStart: number =
        1 -
        Math.max(
          0,
          1 - useDynamismStart * required(envelopeStarts[EnvelopeComputeIndex.supersawDynamism]),
        ) **
          0.2;
      const curvedDynamismEnd: number =
        1 -
        Math.max(
          0,
          1 - useDynamismEnd * required(envelopeEnds[EnvelopeComputeIndex.supersawDynamism]),
        ) **
          0.2;
      const firstVoiceAmplitudeStart: number =
        2 ** (Math.log2(minFirstVoiceAmplitude) * curvedDynamismStart);
      const firstVoiceAmplitudeEnd: number =
        2 ** (Math.log2(minFirstVoiceAmplitude) * curvedDynamismEnd);
      const dynamismStart: number = Math.sqrt(
        (1 / firstVoiceAmplitudeStart ** 2 - 1) / (Config.supersawVoiceCount - 1),
      );
      const dynamismEnd: number = Math.sqrt(
        (1 / firstVoiceAmplitudeEnd ** 2 - 1) / (Config.supersawVoiceCount - 1),
      );
      tone.supersawDynamism = dynamismStart;
      tone.supersawDynamismDelta = (dynamismEnd - dynamismStart) / roundedSamplesPerTick;
      const initializeSupersaw: boolean = tone.supersawDelayIndex === -1;
      if (initializeSupersaw) {
        let accumulator: number = 0;
        for (let i: number = 0; i < Config.supersawVoiceCount; i++) {
          tone.phases[i] = accumulator;
          accumulator += -Math.log(Math.random());
        }
        const amplitudeSum: number = 1 + (Config.supersawVoiceCount - 1) * dynamismStart;
        const slope: number = amplitudeSum;
        let sample: number = 0;
        for (let i: number = 0; i < Config.supersawVoiceCount; i++) {
          const amplitude: number = i === 0 ? 1 : dynamismStart;
          const normalizedPhase: number = required(tone.phases[i]) / accumulator;
          tone.phases[i] = normalizedPhase;
          sample += (normalizedPhase - 0.5) * amplitude;
        }
        let zeroCrossingPhase: number = 1;
        let prevDrop: number = 0;
        for (let i: number = Config.supersawVoiceCount - 1; i >= 0; i--) {
          const nextDrop: number = 1 - required(tone.phases[i]);
          const phaseDelta: number = nextDrop - prevDrop;
          if (sample < 0) {
            const distanceToZeroCrossing: number = -sample / slope;
            if (distanceToZeroCrossing < phaseDelta) {
              zeroCrossingPhase = prevDrop + distanceToZeroCrossing;
              break;
            }
          }
          const amplitude: number = i === 0 ? 1 : dynamismStart;
          sample += phaseDelta * slope - amplitude;
          prevDrop = nextDrop;
        }
        for (let i: number = 0; i < Config.supersawVoiceCount; i++) {
          tone.phases[i] = required(tone.phases[i]) + zeroCrossingPhase;
        }
        for (let i: number = 1; i < Config.supersawVoiceCount - 1; i++) {
          const swappedIndex: number =
            i + Math.floor(Math.random() * (Config.supersawVoiceCount - i));
          const temp: number = required(tone.phases[i]);
          tone.phases[i] = required(tone.phases[swappedIndex]);
          tone.phases[swappedIndex] = temp;
        }
      }
      const baseSpreadSlider: number = instrument.supersawSpread / Config.supersawSpreadMax;
      const useSpreadStart: number = baseSpreadSlider;
      const useSpreadEnd: number = baseSpreadSlider;
      const spreadSliderStart: number =
        Math.max(0, useSpreadStart) * required(envelopeStarts[EnvelopeComputeIndex.supersawSpread]);
      const spreadSliderEnd: number =
        Math.max(0, useSpreadEnd) * required(envelopeEnds[EnvelopeComputeIndex.supersawSpread]);
      const averageSpreadSlider: number = (spreadSliderStart + spreadSliderEnd) * 0.5;
      const curvedSpread: number = (1 - Math.sqrt(Math.max(0, 1 - averageSpreadSlider))) ** 1.75;
      for (let i = 0; i < Config.supersawVoiceCount; i++) {
        const offset: number =
          i === 0
            ? 0
            : ((((i + 1) >> 1) - 0.5 + 0.025 * ((i & 2) - 1)) / (Config.supersawVoiceCount >> 1)) **
                1.1 *
              ((i & 1) * 2 - 1);
        tone.supersawUnisonDetunes[i] = 2 ** ((curvedSpread * offset) / 12);
      }
      const baseShape: number = instrument.supersawShape / Config.supersawShapeMax;
      const useShapeStart: number =
        baseShape * required(envelopeStarts[EnvelopeComputeIndex.supersawShape]);
      const useShapeEnd: number =
        baseShape * required(envelopeEnds[EnvelopeComputeIndex.supersawShape]);
      const shapeStart: number =
        useShapeStart * required(envelopeStarts[EnvelopeComputeIndex.supersawShape]);
      const shapeEnd: number =
        useShapeEnd * required(envelopeEnds[EnvelopeComputeIndex.supersawShape]);
      tone.supersawShape = shapeStart;
      tone.supersawShapeDelta = (shapeEnd - shapeStart) / roundedSamplesPerTick;
      const basePulseWidth: number = getPulseWidthRatio(instrument.pulseWidth);
      const pulseWidthModStart: number = basePulseWidth;
      const pulseWidthModEnd: number = basePulseWidth;
      const pulseWidthStart: number =
        pulseWidthModStart * required(envelopeStarts[EnvelopeComputeIndex.pulseWidth]);
      const pulseWidthEnd: number =
        pulseWidthModEnd * required(envelopeEnds[EnvelopeComputeIndex.pulseWidth]);
      const phaseDeltaStart: number = tone.supersawPrevPhaseDelta ?? startFreq * sampleTime;
      const phaseDeltaEnd: number = startFreq * sampleTime * freqEndRatio;
      tone.supersawPrevPhaseDelta = phaseDeltaEnd;
      const delayLengthStart = pulseWidthStart / phaseDeltaStart;
      const delayLengthEnd = pulseWidthEnd / phaseDeltaEnd;
      tone.supersawDelayLength = delayLengthStart;
      tone.supersawDelayLengthDelta = (delayLengthEnd - delayLengthStart) / roundedSamplesPerTick;
      const minBufferLength: number = Math.ceil(Math.max(delayLengthStart, delayLengthEnd)) + 2;
      if (tone.supersawDelayLine === null || tone.supersawDelayLine.length <= minBufferLength) {
        const likelyMaximumLength: number = Math.ceil(
          (0.5 * this.samplesPerSecond) / Instrument.frequencyFromPitch(24),
        );
        const newDelayLine: Float32Array = new Float32Array(
          fittingPowerOfTwo(Math.max(likelyMaximumLength, minBufferLength)),
        );
        if (!initializeSupersaw && tone.supersawDelayLine !== null) {
          const oldDelayBufferMask: number = Math.trunc(tone.supersawDelayLine.length - 1);
          const startCopyingFromIndex: number = tone.supersawDelayIndex;
          for (let i: number = 0; i < tone.supersawDelayLine.length; i++) {
            newDelayLine[i] = required(
              tone.supersawDelayLine[(startCopyingFromIndex + i) & oldDelayBufferMask],
            );
          }
        }
        tone.supersawDelayLine = newDelayLine;
        tone.supersawDelayIndex = tone.supersawDelayLine.length;
      } else if (initializeSupersaw) {
        tone.supersawDelayLine.fill(0);
        tone.supersawDelayIndex = tone.supersawDelayLine.length;
      }
      const pulseExpressionRatio: number = Config.pwmBaseExpression / Config.supersawBaseExpression;
      supersawExpressionStart *=
        (1 + (pulseExpressionRatio - 1) * shapeStart) /
        Math.sqrt(1 + (Config.supersawVoiceCount - 1) * dynamismStart * dynamismStart);
      supersawExpressionEnd *=
        (1 + (pulseExpressionRatio - 1) * shapeEnd) /
        Math.sqrt(1 + (Config.supersawVoiceCount - 1) * dynamismEnd * dynamismEnd);
    }
    const expressionStart: number =
      settingsExpressionMult *
      fadeExpressionStart *
      chordExpressionStart *
      pitchExpressionStart *
      required(envelopeStarts[EnvelopeComputeIndex.noteVolume]) *
      supersawExpressionStart;
    const expressionEnd: number =
      settingsExpressionMult *
      fadeExpressionEnd *
      chordExpressionEnd *
      pitchExpressionEnd *
      required(envelopeEnds[EnvelopeComputeIndex.noteVolume]) *
      supersawExpressionEnd;
    tone.expression = expressionStart;
    tone.expressionDelta = (expressionEnd - expressionStart) / roundedSamplesPerTick;
    if (instrument.type === InstrumentType.pickedString) {
      let stringDecayStart = tone.prevStringDecay ?? 0;
      if (tone.prevStringDecay === null) {
        const sustainEnvelopeStart: number = required(
          tone.envelopeComputer.envelopeStarts[EnvelopeComputeIndex.stringSustain],
        );
        stringDecayStart =
          1 -
          Math.min(
            1,
            (sustainEnvelopeStart * tone.stringSustainStart) / (Config.stringSustainRange - 1),
          );
      }
      const sustainEnvelopeEnd: number = required(
        tone.envelopeComputer.envelopeEnds[EnvelopeComputeIndex.stringSustain],
      );
      const stringDecayEnd: number =
        1 -
        Math.min(1, (sustainEnvelopeEnd * tone.stringSustainEnd) / (Config.stringSustainRange - 1));
      tone.prevStringDecay = stringDecayEnd;
      if (tone.atNoteStart && !transition.continues && !tone.forceContinueAtStart) {
        tone.pickedString.delayIndex = -1;
      }
      tone.pickedString.update(
        this,
        instrumentState,
        tone,
        roundedSamplesPerTick,
        stringDecayStart,
        stringDecayEnd,
      );
    }
  }

  private getSamplesPerTick(): number {
    const beatsPerMinute: number = this.song.tempo;
    return this.getSamplesPerTickSpecificBPM(beatsPerMinute);
  }

  private getSamplesPerTickSpecificBPM(beatsPerMinute: number): number {
    const beatsPerSecond: number = beatsPerMinute / 60;
    const partsPerSecond: number = Config.partsPerBeat * beatsPerSecond;
    const tickPerSecond: number = Config.ticksPerPart * partsPerSecond;
    return this.samplesPerSecond / tickPerSecond;
  }
}
