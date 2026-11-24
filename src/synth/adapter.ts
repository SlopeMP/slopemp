// SlopeMP model adapter for the integrated UltraBox note and envelope engine.
// Adapted from UltraBox (MIT); see ../../license/ultrabox-MIT.txt.
import type { Envelope, Instrument } from "../instruments";
import type { Channel, Song } from "../model";
import type { EnvelopeTiming } from "./config";
import { createSynthRuntime } from "./runtime";
import type { InstrumentSettings, RuntimeSettings, SongSettings, SynthRuntime } from "./runtime";

type EvaluateEnvelope = (
  envelope: Envelope,
  seconds: number,
  beats: number,
  expression: number,
) => number;
export type NativeSynth = { runtime: SynthRuntime };
export const createNativeSynth = (
  song: Song,
  channel: Channel,
  instrument: Instrument,
  sampleRate: number,
  evaluate: EvaluateEnvelope,
  sequence?: number[],
  previous?: NativeSynth,
): NativeSynth => {
  const evaluateNativeEnvelope = (
    envelope: Envelope,
    seconds: number,
    beats: number,
    size: number,
    timing: EnvelopeTiming,
  ): number => {
    const periodic =
      envelope.type === "Sine" || envelope.type === "Square" || envelope.type === "Triangle";
    if (periodic && envelope.clock === "song synchronized") {
      const sourceBar = sequence?.[timing.songBar] ?? timing.songBar;
      const songBeats = (sourceBar - timing.songBar) * song.beatsPerBar + timing.songBeats;
      return evaluate(envelope, songBeats * timing.secondsPerBeat, songBeats, size / 6);
    }
    // Percussive and staged shapes restart their beat age for each note.
    return evaluate(envelope, seconds, periodic ? beats : timing.noteBeats, size / 6);
  };
  const upstreamType =
    {
      "chip wave": "chip",
      "basic noise": "noise",
      "pulse width": "PWM",
      "picked string": "Picked String",
    }[instrument.type] ?? instrument.type;
  const settings: InstrumentSettings = {
    type: upstreamType,
    wave: instrument.type === "basic noise" ? instrument.noise : instrument.wave,
    harmonics: instrument.harmonics.map((value) => value * 100),
    spectrum: instrument.spectrum.map((value) => value * 100),
    pulseWidth: instrument.pulseWidth * 100,
    dynamism: instrument.dynamism * 100,
    spread: instrument.spread * 100,
    shape: instrument.shape * 100,
    stringSustain: instrument.sustain * 100,
    drums: instrument.drums.map((drum) => ({
      spectrum: drum.spectrum.map((value) => value * 100),
    })),
    fadeInSeconds: instrument.type === "drumset" ? 0 : instrument.attack,
    fadeOutTicks: instrument.type === "drumset" ? -1 : instrument.release * 48,
    transition: instrument.transition,
    chord: instrument.chords,
    arpeggioSpeed: instrument.arpeggioSpeed * 12,
    fastTwoNoteArp: instrument.fastTwoNote,
  };
  const envelopes: RuntimeSettings["envelopes"] = [];
  for (const envelope of instrument.envelopes) {
    if (!envelope.enabled) {
      continue;
    }
    let { target } = envelope;
    if (target === "volume") {
      target = "noteVolume";
    } else if (!["pulseWidth", "sustain", "none", "dynamism", "spread", "shape"].includes(target)) {
      continue;
    }
    if (target === "sustain") {
      target = "stringSustain";
    }
    if (["dynamism", "spread", "shape"].includes(target)) {
      target = `supersaw${target[0]?.toUpperCase()}${target.slice(1)}`;
    }
    const speed = envelope.speed * ({ Twang: 8, Decay: 4 }[envelope.type] ?? 1);
    envelopes.push({
      target,
      index: 0,
      type: envelope.type,
      speed,
      evaluate: (seconds, beats, size, timing): number =>
        evaluateNativeEnvelope(envelope, seconds, beats, size, timing),
    });
  }
  const sequenceBars = sequence ?? Array.from({ length: song.barCount }, (_, i) => i);
  const data: SongSettings = {
    key: song.key,
    beatsPerBar: song.beatsPerBar,
    beatsPerMinute: song.tempo,
    introBars: sequence ? 0 : song.loopStart,
    loopBars: sequence ? sequence.length : song.loopEnd - song.loopStart,
    instrument: settings,
    patterns: Array.from({ length: song.patternCount }, (_, i) => ({
      notes: (channel.patterns[i + 1]?.notes ?? []).map((note) => ({
        pitches: note.pitches,
        continuesLastPattern: note.continues ?? false,
        points: note.pins.map((pin) => ({
          tick: (note.start + pin.time) * 24,
          pitchBend: pin.interval,
          volume: (pin.volume / 3) * 100,
        })),
      })),
    })),
    sequence: sequenceBars.map((bar) => channel.cells[bar] ?? 0),
  };
  const runtimeSettings: RuntimeSettings = {
    volume: instrument.volume,
    sampleRate,
    drums:
      instrument.type === "drumset"
        ? instrument.drums.map((drum) => ({
            type: drum.envelope.type,
            speed: drum.envelope.speed * ({ Twang: 8, Decay: 4 }[drum.envelope.type] ?? 1),
            evaluate: (seconds, beats, size, timing): number =>
              evaluateNativeEnvelope(drum.envelope, seconds, beats, size, timing),
          }))
        : [],
    envelopes,
  };
  if (previous) {
    previous.runtime.update(data, runtimeSettings);
    return previous;
  }
  return { runtime: createSynthRuntime(data, runtimeSettings) };
};

export const usesUpstreamSynth = (instrument: Instrument): boolean => {
  if (instrument.type === "chip wave" && instrument.resourceId) {
    return false;
  }
  return [
    "chip wave",
    "basic noise",
    "spectrum",
    "drumset",
    "harmonics",
    "pulse width",
    "picked string",
    "supersaw",
  ].includes(instrument.type);
};
