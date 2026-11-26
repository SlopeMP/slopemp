/*!
 * Adapted from UltraBox 91b4bc1988e605ba5f5009f557e52ccb33975754.
 * Copyright (c) 2012-2022 John Nesky and contributing authors.
 * SPDX-License-Identifier: MIT
 * See ../../license/ultrabox-MIT.txt for the full license.
 */
import { required } from "../model";
import { Config } from "./config";
import type { Envelope } from "./config";
import { clamp, Instrument, Note, Pattern, Song, Synth } from "./engine";

export type RuntimeSettings = {
  volume: number;
  sampleRate: number;
  drums: Envelope[];
  envelopes: RuntimeEnvelope[];
};
type RuntimeEnvelope = Envelope & {
  target: string;
  index: number;
};
export type SynthRuntime = {
  sample: (playing: boolean, pitches: number[], tempo: number, detune: number) => [number, number];
  process: (
    left: Float64Array,
    right: Float64Array,
    playing: boolean,
    pitches: number[],
    tempo: number,
    detune: number,
  ) => boolean;
  setLivePitches: (pitches: number[]) => void;
  setLoop: (start: number, end: number) => void;
  update: (data: SongSettings, settings: RuntimeSettings) => void;
  seek: (bar: number) => void;
  jumpToBar: (bar: number) => void;
};
export type InstrumentSettings = {
  type: string;
  wave: string;
  harmonics: number[];
  spectrum: number[];
  pulseWidth: number;
  dynamism: number;
  spread: number;
  shape: number;
  stringSustain: number;
  drums: Array<{ spectrum: number[] }>;
  fadeInSeconds: number;
  fadeOutTicks: number;
  transition: string;
  chord: string;
  arpeggioSpeed: number;
  fastTwoNoteArp: boolean;
};
export type SongSettings = {
  key: number;
  beatsPerBar: number;
  beatsPerMinute: number;
  introBars: number;
  loopBars: number;
  instrument: InstrumentSettings;
  patterns: Array<{
    notes: Array<{
      pitches: number[];
      continuesLastPattern: boolean;
      points: Array<{ tick: number; pitchBend: number; volume: number }>;
    }>;
  }>;
  sequence: number[];
};

// Control quantization is part of the original instrument sound. Keep it here
// when translating the editor's continuous controls into synthesis settings.
const applyInstrumentSettings = (input: InstrumentSettings, previous?: Instrument): Instrument => {
  const instrument = previous ?? new Instrument();
  instrument.type = Config.instrumentTypeNames.indexOf(input.type);
  instrument.transition = required(Config.transitions.dictionary[input.transition]).index;
  instrument.chord = required(Config.chords.dictionary[input.chord]).index;
  instrument.fadeIn = Synth.secondsToFadeInSetting(input.fadeInSeconds);
  instrument.fadeOut = Synth.ticksToFadeOutSetting(input.fadeOutTicks);
  instrument.arpeggioSpeed = input.arpeggioSpeed;
  instrument.fastTwoNoteArp = input.fastTwoNoteArp;
  instrument.pulseWidth = clamp(1, Config.pulseWidthRange + 1, Math.round(input.pulseWidth));
  instrument.supersawDynamism = clamp(
    0,
    Config.supersawDynamismMax + 1,
    Math.round((Config.supersawDynamismMax * Math.trunc(input.dynamism)) / 100),
  );
  instrument.supersawSpread = clamp(
    0,
    Config.supersawSpreadMax + 1,
    Math.round((Config.supersawSpreadMax * Math.trunc(input.spread)) / 100),
  );
  instrument.supersawShape = clamp(
    0,
    Config.supersawShapeMax + 1,
    Math.round((Config.supersawShapeMax * Math.trunc(input.shape)) / 100),
  );
  const updateWave = (
    points: number[],
    inputPoints: number[],
    count: number,
    max: number,
  ): boolean => {
    let changed = false;
    for (let i = 0; i < count; i++) {
      const value = Math.max(0, Math.min(max, Math.round((max * required(inputPoints[i])) / 100)));
      changed ||= points[i] !== value;
      points[i] = value;
    }
    return changed;
  };
  if (
    updateWave(
      instrument.harmonicsWave.harmonics,
      input.harmonics,
      Config.harmonicsControlPoints,
      Config.harmonicsMax,
    )
  ) {
    instrument.harmonicsWave.markCustomWaveDirty();
  }
  if (
    updateWave(
      instrument.spectrumWave.spectrum,
      input.spectrum,
      Config.spectrumControlPoints,
      Config.spectrumMax,
    )
  ) {
    instrument.spectrumWave.markCustomWaveDirty();
  }
  instrument.stringSustain = clamp(
    0,
    Config.stringSustainRange,
    Math.round(((Config.stringSustainRange - 1) * Math.trunc(input.stringSustain)) / 100),
  );
  instrument.chipNoise = Config.chipNoises.findIndex((wave) => wave.name === input.wave);
  if (instrument.chipNoise < 0) {
    instrument.chipNoise = 1;
  }
  instrument.chipWave = Config.chipWaves.findIndex((wave) => wave.name === input.wave);
  if (instrument.chipWave < 0) {
    instrument.chipWave = 1;
  }
  for (const [index, drum] of input.drums.entries()) {
    const dest = instrument.drumsetSpectrumWaves[index];
    if (!dest) {
      break;
    }
    if (
      updateWave(dest.spectrum, drum.spectrum, Config.spectrumControlPoints, Config.spectrumMax)
    ) {
      dest.markCustomWaveDirty();
    }
  }
  return instrument;
};

export const resetSynthNoiseTables = (): void => {
  for (const noise of Config.chipNoises) {
    noise.samples = null;
  }
};
const prepareRuntimeSong = (
  data: SongSettings,
  settings: RuntimeSettings,
  previous?: Instrument,
): { song: Song; instrument: Instrument } => {
  const instrument = applyInstrumentSettings(data.instrument, previous);
  const song = new Song(instrument, data.sequence);
  song.key = data.key;
  song.tempo = clamp(Config.tempoMin, Config.tempoMax + 1, Math.trunc(data.beatsPerMinute));
  song.beatsPerBar = Math.max(
    Config.beatsPerBarMin,
    Math.min(Config.beatsPerBarMax, Math.trunc(data.beatsPerBar)),
  );
  song.barCount = data.sequence.length;
  song.loopStart = clamp(0, song.barCount, Math.trunc(data.introBars));
  song.loopLength = clamp(1, song.barCount - song.loopStart + 1, Math.trunc(data.loopBars));
  for (const input of data.patterns) {
    const pattern = new Pattern();
    for (const source of input.notes) {
      if (source.pitches.length === 0 || source.points.length < 2) {
        continue;
      }
      const note = new Note(0, 0, 0, 0);
      note.pitches = [...new Set(source.pitches.map((p) => Math.trunc(p)))];
      note.pins = [];
      const start = required(source.points[0]);
      note.start = Math.round(start.tick);
      const interval = Math.trunc(start.pitchBend);
      for (const point of source.points) {
        const time = Math.round(point.tick);
        if (time > song.partsPerPattern) {
          continue;
        }
        note.pins.push({
          interval: Math.trunc(point.pitchBend) - interval,
          time: time - note.start,
          size: Math.max(
            0,
            Math.min(
              Config.noteSizeMax,
              Math.round((Math.trunc(point.volume) * Config.noteSizeMax) / 100),
            ),
          ),
        });
      }
      if (note.pins.length < 2) {
        continue;
      }
      note.end = required(note.pins.at(-1)).time + note.start;
      note.pitches = note.pitches
        .map((p) => p + interval)
        .filter((p) => p >= 0 && p <= Config.maxPitch);
      if (note.pitches.length === 0) {
        continue;
      }
      const lowest = Math.min(...note.pitches);
      const highest = Math.max(...note.pitches);
      for (let k = 0; k < note.pins.length; k++) {
        const pin = required(note.pins[k]);
        pin.interval = Math.max(-lowest, Math.min(Config.maxPitch - highest, pin.interval));
        if (k >= 2) {
          const prev = required(note.pins[k - 1]);
          const before = required(note.pins[k - 2]);
          if (
            pin.interval === prev.interval &&
            pin.interval === before.interval &&
            pin.size === prev.size &&
            pin.size === before.size
          ) {
            note.pins.splice(k - 1, 1);
            k--;
          }
        }
      }
      note.continuesLastPattern = note.start === 0 && source.continuesLastPattern;
      pattern.notes.push(note);
    }
    song.patterns.push(pattern);
  }
  instrument.volume = Synth.volumeMultToInstrumentVolume(settings.volume);
  instrument.envelopes.length = 0;
  for (const env of settings.envelopes) {
    const target = Config.instrumentAutomationTargets.dictionary[env.target];
    if (!target) {
      throw new Error(`Unsupported envelope: ${env.target}`);
    }
    instrument.addEnvelope(target, env.index, env);
  }
  instrument.drumsetEnvelopes = settings.drums;
  return { song, instrument };
};
export const createSynthRuntime = (data: SongSettings, settings: RuntimeSettings): SynthRuntime => {
  let { song, instrument } = prepareRuntimeSong(data, settings);
  const synth = new Synth(song);
  synth.samplesPerSecond = settings.sampleRate;
  const left = new Float64Array(1);
  const right = new Float64Array(1);
  let live: number[] = [];
  const setLivePitches = (pitches: number[]): void => {
    if (pitches.length === live.length && pitches.every((pitch, index) => pitch === live[index])) {
      return;
    }
    live = [...pitches];
    synth.setLiveInputPitches(live);
  };
  const applyControls = (pitches: number[], tempo: number, detune: number): void => {
    if (song.tempo !== tempo) {
      synth.tickSampleCountdown *= song.tempo / tempo;
      song.tempo = tempo;
    }
    instrument.songDetuneCents = detune;
    setLivePitches(pitches);
  };
  return {
    setLivePitches,
    update: (nextData, nextSettings): void => {
      // Replace score/settings while keeping the synth's tones,
      // fractional tick position and oscillator phases alive across editor edits.
      const previousTempo = song.tempo;
      ({ song, instrument } = prepareRuntimeSong(nextData, nextSettings, instrument));
      // sample() applies the next effective tempo, including automation, while
      // preserving the fraction of the current tick that remains.
      song.tempo = previousTempo;
      synth.song = song;
    },
    setLoop: (start, end): void => {
      song.loopStart = start;
      song.loopLength = end - start;
    },
    // An automated bar jump changes the score position while existing tones
    // remain available for releases and the next note's transition.
    jumpToBar: (bar): void => {
      synth.seek(bar);
    },
    sample: (playing, pitches, tempo, detune): [number, number] => {
      applyControls(pitches, tempo, detune);
      right[0] = 0;
      left[0] = 0;
      synth.synthesize(left, right, 1, playing);
      return [required(left[0]), required(right[0])];
    },
    process: (outputLeft, outputRight, playing, pitches, tempo, detune): boolean => {
      if (outputLeft.length !== outputRight.length) {
        throw new Error("Native synthesis requires equal stereo buffer lengths.");
      }
      applyControls(pitches, tempo, detune);
      outputLeft.fill(0);
      outputRight.fill(0);
      return synth.synthesize(outputLeft, outputRight, outputLeft.length, playing);
    },
    seek: (bar): void => {
      synth.seek(bar);
      const ticks = bar * song.beatsPerBar * Config.partsPerBeat * Config.ticksPerPart;
      synth.tickSampleCountdown =
        ((1 - (ticks - Math.floor(ticks))) * settings.sampleRate * 60) /
        (song.tempo * Config.partsPerBeat * Config.ticksPerPart);
      synth.reset();
    },
  };
};
