/*!
 * Adapted from UltraBox 91b4bc1988e605ba5f5009f557e52ccb33975754.
 * Copyright (c) 2012-2022 John Nesky and contributing authors.
 * SPDX-License-Identifier: MIT
 * See ../../license/ultrabox-MIT.txt for the full license.
 */
import { required } from "../model";
import { noises } from "./noise";
export type Dictionary<T> = Record<string, T>;
export type DictionaryArray<T> = T[] & {
  dictionary: Dictionary<T>;
};
export const InstrumentType = {
  chip: 0,
  noise: 1,
  spectrum: 2,
  drumset: 3,
  harmonics: 4,
  pwm: 5,
  pickedString: 6,
  supersaw: 7,
} as const;

export const EnvelopeComputeIndex = {
  noteVolume: 0,
  pulseWidth: 1,
  stringSustain: 2,
  supersawDynamism: 3,
  supersawSpread: 4,
  supersawShape: 5,
  length: 6,
} as const;
type IndexedOption = {
  readonly index: number;
  readonly name: string;
};

export type ChipWave = IndexedOption & {
  readonly expression: number;
  samples: Float32Array;
};

export type Transition = IndexedOption & {
  readonly isSeamless: boolean;
  readonly continues: boolean;
  readonly slides: boolean;
  readonly slideTicks: number;
  readonly includeAdjacentPatterns: boolean;
};
export type Chord = IndexedOption & {
  readonly customInterval: boolean;
  readonly arpeggiates: boolean;
  readonly strumParts: number;
  readonly singleTone: boolean;
};

export type EnvelopeTiming = {
  noteBeats: number;
  songBar: number;
  songBeats: number;
  secondsPerBeat: number;
};
export type Envelope = {
  evaluate: (seconds: number, beats: number, size: number, timing: EnvelopeTiming) => number;
  readonly type: string;
  readonly speed: number;
};
export type AutomationTarget = IndexedOption & {
  readonly computeIndex: number | null;
  readonly maxCount: number;
  readonly compatibleInstruments: number[] | null;
};

const centerWave = (wave: number[]): Float32Array => {
  let sum: number = 0;
  for (const element of wave) {
    sum += required(element);
  }
  const average: number = sum / wave.length;
  for (let i: number = 0; i < wave.length; i++) {
    wave[i] = required(wave[i]) - average;
  }
  wave.push(0);
  return new Float32Array(wave);
};
export const integrateWave = (wave: Float32Array): void => {
  let sum = 0;
  for (let i = 0; i < wave.length; i++) {
    const value = required(wave[i]);
    wave[i] = sum;
    sum += value;
  }
};
export const toNameMap = <T extends { readonly name: string }>(
  array: T[],
): DictionaryArray<T & { index: number }> => {
  const dictionary: Dictionary<T & { index: number }> = {};
  const result = array.map((item, index) => Object.assign(item, { index }));
  for (const item of result) {
    dictionary[item.name] = item;
  }
  return Object.assign(result, { dictionary });
};
export class Config {
  public static readonly tempoMin: number = 1;

  public static readonly tempoMax: number = 500;

  public static readonly beatsPerBarMin: number = 1;

  public static readonly beatsPerBarMax: number = 64;

  public static readonly partsPerBeat: number = 24;

  public static readonly ticksPerPart: number = 2;

  public static readonly ticksPerArpeggio: number = 3;

  public static readonly arpeggioPatterns: ReadonlyArray<readonly number[]> = [
    [0],
    [0, 1],
    [0, 1, 2, 1],
    [0, 1, 2, 3],
    [0, 1, 2, 3, 4],
    [0, 1, 2, 3, 4, 5],
    [0, 1, 2, 3, 4, 5, 6],
    [0, 1, 2, 3, 4, 5, 6, 7],
  ];

  public static readonly instrumentTypeNames: readonly string[] = [
    "chip",
    "noise",
    "spectrum",
    "drumset",
    "harmonics",
    "PWM",
    "Picked String",
    "supersaw",
  ];

  public static readonly chipBaseExpression: number = 0.03375;

  public static readonly noiseBaseExpression: number = 0.19;

  public static readonly spectrumBaseExpression: number = 0.3;

  public static readonly drumsetBaseExpression: number = 0.45;

  public static readonly harmonicsBaseExpression: number = 0.025;

  public static readonly pwmBaseExpression: number = 0.04725;

  public static readonly supersawBaseExpression: number = 0.061425;

  public static readonly pickedStringBaseExpression: number = 0.025;

  public static readonly chipWaves: DictionaryArray<ChipWave> = toNameMap(
    [
      {
        name: "rounded",
        expression: 0.94,
        samples: centerWave([
          0, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
          1, 1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.2, 0, -0.2, -0.4, -0.5, -0.6, -0.7,
          -0.8, -0.85, -0.9, -0.95, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -0.95, -0.9, -0.85,
          -0.8, -0.7, -0.6, -0.5, -0.4, -0.2,
        ]),
      },
      {
        name: "triangle",
        expression: 1,
        samples: centerWave([
          1 / 15,
          3 / 15,
          5 / 15,
          7 / 15,
          9 / 15,
          11 / 15,
          13 / 15,
          15 / 15,
          15 / 15,
          13 / 15,
          11 / 15,
          9 / 15,
          7 / 15,
          5 / 15,
          3 / 15,
          1 / 15,
          -1 / 15,
          -3 / 15,
          -5 / 15,
          -7 / 15,
          -9 / 15,
          -11 / 15,
          -13 / 15,
          -15 / 15,
          -15 / 15,
          -13 / 15,
          -11 / 15,
          -9 / 15,
          -7 / 15,
          -5 / 15,
          -3 / 15,
          -1 / 15,
        ]),
      },
      { name: "square", expression: 0.5, samples: centerWave([1, -1]) },
      { name: "1/4 pulse", expression: 0.5, samples: centerWave([1, -1, -1, -1]) },
      { name: "1/8 pulse", expression: 0.5, samples: centerWave([1, -1, -1, -1, -1, -1, -1, -1]) },
      {
        name: "sawtooth",
        expression: 0.65,
        samples: centerWave([
          1 / 31,
          3 / 31,
          5 / 31,
          7 / 31,
          9 / 31,
          11 / 31,
          13 / 31,
          15 / 31,
          17 / 31,
          19 / 31,
          21 / 31,
          23 / 31,
          25 / 31,
          27 / 31,
          29 / 31,
          31 / 31,
          -31 / 31,
          -29 / 31,
          -27 / 31,
          -25 / 31,
          -23 / 31,
          -21 / 31,
          -19 / 31,
          -17 / 31,
          -15 / 31,
          -13 / 31,
          -11 / 31,
          -9 / 31,
          -7 / 31,
          -5 / 31,
          -3 / 31,
          -1 / 31,
        ]),
      },
      {
        name: "double saw",
        expression: 0.5,
        samples: centerWave([
          0, -0.2, -0.4, -0.6, -0.8, -1, 1, -0.8, -0.6, -0.4, -0.2, 1, 0.8, 0.6, 0.4, 0.2,
        ]),
      },
      {
        name: "double pulse",
        expression: 0.4,
        samples: centerWave([1, 1, 1, 1, 1, -1, -1, -1, 1, 1, 1, 1, -1, -1, -1, -1]),
      },
      { name: "spiky", expression: 0.4, samples: centerWave([1, -1, 1, -1, 1, 0]) },
    ].map((wave) => {
      integrateWave(wave.samples);
      return wave;
    }),
  );

  public static readonly chipNoises = toNameMap(noises);

  public static readonly fadeInRange: number = 10;

  public static readonly fadeOutTicks: readonly number[] = [
    -24, -12, -6, -3, -1, 6, 12, 24, 48, 72, 96,
  ];

  public static readonly fadeOutNeutral: number = 4;

  public static readonly drumsetFadeOutTicks: number = 48;

  public static readonly transitions: DictionaryArray<Transition> = toNameMap([
    {
      name: "normal",
      isSeamless: false,
      continues: false,
      slides: false,
      slideTicks: 3,
      includeAdjacentPatterns: false,
    },
    {
      name: "interrupt",
      isSeamless: true,
      continues: false,
      slides: false,
      slideTicks: 3,
      includeAdjacentPatterns: true,
    },
    {
      name: "continue",
      isSeamless: true,
      continues: true,
      slides: false,
      slideTicks: 3,
      includeAdjacentPatterns: true,
    },
    {
      name: "slide",
      isSeamless: true,
      continues: false,
      slides: true,
      slideTicks: 3,
      includeAdjacentPatterns: true,
    },
    {
      name: "slide in pattern",
      isSeamless: true,
      continues: false,
      slides: true,
      slideTicks: 3,
      includeAdjacentPatterns: false,
    },
  ]);

  public static readonly arpSpeedScale: readonly number[] = [
    0,
    0.0625,
    0.125,
    0.2,
    0.25,
    1 / 3,
    0.4,
    0.5,
    2 / 3,
    0.75,
    0.8,
    0.9,
    1,
    1.1,
    1.2,
    1.3,
    1.4,
    1.5,
    1.6,
    1.7,
    1.8,
    1.9,
    2,
    2.1,
    2.2,
    2.3,
    2.4,
    2.5,
    2.6,
    2.7,
    2.8,
    2.9,
    3,
    3.1,
    3.2,
    3.3,
    3.4,
    3.5,
    3.6,
    3.7,
    3.8,
    3.9,
    4,
    4.15,
    4.3,
    4.5,
    4.8,
    5,
    5.5,
    6,
    8,
  ];

  public static readonly noteSizeMax: number = 6;

  public static readonly volumeRange: number = 50;

  public static readonly volumeLogScale: number = 0.1428;

  public static readonly chords: DictionaryArray<Chord> = toNameMap([
    {
      name: "simultaneous",
      customInterval: false,
      arpeggiates: false,
      strumParts: 0,
      singleTone: false,
    },
    { name: "strum", customInterval: false, arpeggiates: false, strumParts: 1, singleTone: false },
    { name: "arpeggio", customInterval: false, arpeggiates: true, strumParts: 0, singleTone: true },
    {
      name: "custom interval",
      customInterval: true,
      arpeggiates: false,
      strumParts: 0,
      singleTone: true,
    },
  ]);

  public static readonly maxChordSize: number = 9;

  public static readonly chipNoiseLength: number = 1 << 15;

  public static readonly spectrumNoiseLength: number = 1 << 15;

  public static readonly spectrumBasePitch: number = 24;

  public static readonly spectrumControlPoints: number = 30;

  public static readonly spectrumControlPointsPerOctave: number = 7;

  public static readonly spectrumControlPointBits: number = 3;

  public static readonly spectrumMax: number = (1 << Config.spectrumControlPointBits) - 1;

  public static readonly harmonicsControlPoints: number = 28;

  public static readonly harmonicsRendered: number = 64;

  public static readonly harmonicsRenderedForPickedString: number = 1 << 8;

  public static readonly harmonicsControlPointBits: number = 3;

  public static readonly harmonicsMax: number = (1 << Config.harmonicsControlPointBits) - 1;

  public static readonly harmonicsWavelength: number = 1 << 11;

  public static readonly pulseWidthRange: number = 50;

  public static readonly supersawVoiceCount: number = 7;

  public static readonly supersawDynamismMax: number = 6;

  public static readonly supersawSpreadMax: number = 12;

  public static readonly supersawShapeMax: number = 6;

  public static readonly pitchesPerOctave: number = 12;

  public static readonly drumCount: number = 12;

  public static readonly pitchOctaves: number = 8;

  public static readonly maxPitch: number = Config.pitchOctaves * Config.pitchesPerOctave;

  public static readonly maximumTonesPerChannel: number = Config.maxChordSize * 2;

  public static readonly pickedStringDispersionCenterFreq: number = 6000;

  public static readonly pickedStringDispersionFreqScale: number = 0.3;

  public static readonly pickedStringDispersionFreqMult: number = 4;

  public static readonly pickedStringShelfHz: number = 4000;

  public static readonly stringSustainRange: number = 15;

  public static readonly stringDecayRate: number = 0.12;

  public static readonly maxEnvelopeCount: number = 12;

  public static readonly instrumentAutomationTargets: DictionaryArray<AutomationTarget> = toNameMap(
    [
      {
        name: "none",
        computeIndex: null,
        maxCount: 1,
        compatibleInstruments: null,
      },
      {
        name: "noteVolume",
        computeIndex: EnvelopeComputeIndex.noteVolume,
        maxCount: 1,
        compatibleInstruments: null,
      },
      {
        name: "pulseWidth",
        computeIndex: EnvelopeComputeIndex.pulseWidth,
        maxCount: 1,
        compatibleInstruments: [InstrumentType.pwm, InstrumentType.supersaw],
      },
      {
        name: "stringSustain",
        computeIndex: EnvelopeComputeIndex.stringSustain,
        maxCount: 1,
        compatibleInstruments: [InstrumentType.pickedString],
      },
      {
        name: "supersawDynamism",
        computeIndex: EnvelopeComputeIndex.supersawDynamism,
        maxCount: 1,
        compatibleInstruments: [InstrumentType.supersaw],
      },
      {
        name: "supersawSpread",
        computeIndex: EnvelopeComputeIndex.supersawSpread,
        maxCount: 1,
        compatibleInstruments: [InstrumentType.supersaw],
      },
      {
        name: "supersawShape",
        computeIndex: EnvelopeComputeIndex.supersawShape,
        maxCount: 1,
        compatibleInstruments: [InstrumentType.supersaw],
      },
    ],
  );
}

export const getPulseWidthRatio = (pulseWidth: number): number => {
  return pulseWidth / (Config.pulseWidthRange * 2);
};

export const getArpeggioPitchIndex = (
  pitchCount: number,
  useFastTwoNoteArp: boolean,
  arpeggio: number,
): number => {
  let arpeggioPattern = Config.arpeggioPatterns.at(pitchCount - 1);
  if (arpeggioPattern !== undefined) {
    if (pitchCount === 2 && !useFastTwoNoteArp) {
      arpeggioPattern = [0, 0, 1, 1];
    }
    return required(arpeggioPattern[arpeggio % arpeggioPattern.length]);
  } else {
    return arpeggio % pitchCount;
  }
};
