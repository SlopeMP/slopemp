import { expect, test } from "bun:test";

import { envelopeValue } from "../../src/audio";
import { createEnvelope, createInstrument } from "../../src/instruments";
import type { Envelope } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { createNativeSynth } from "../../src/synth/adapter";
import type { SynthRuntime } from "../../src/synth/runtime";

type EnvelopeReading = { seconds: number; beats: number; value: number };
const synchronizedFixture = (
  type: string,
  timeBasis: string,
  sequence?: number[],
): { runtime: SynthRuntime; envelope: Envelope; readings: EnvelopeReading[] } => {
  const song = createSong();
  song.tempo = 120;
  song.beatsPerBar = 4;
  song.barCount = 2;
  song.loopEnd = 2;
  const channel = required(song.channels[0]);
  channel.cells = [1, 1];
  required(channel.patterns[1]).notes = [createNote(0, 4, 48)];
  const instrument = createInstrument(type);
  const envelope = { ...createEnvelope(), type: "Sine", speed: 0.3, timeBasis };
  if (type === "drumset") {
    for (const drum of instrument.drums) {
      drum.envelope = { ...envelope };
    }
  } else {
    instrument.envelopes = [envelope];
  }
  channel.instruments = [instrument];
  const readings: EnvelopeReading[] = [];
  const { runtime } = createNativeSynth(
    song,
    channel,
    instrument,
    8000,
    (shape, seconds, beats, expression) => {
      const value = envelopeValue(shape, seconds, beats, expression);
      readings.push({ seconds, beats, value });
      return value;
    },
    sequence,
  );
  return { runtime, envelope, readings };
};

for (const type of ["chip wave", "drumset"]) {
  test(`${type} beat envelopes restart for notes later in the bar and song`, () => {
    const song = createSong();
    song.tempo = 120;
    song.beatsPerBar = 4;
    song.barCount = 2;
    song.loopEnd = 2;
    const channel = required(song.channels[0]);
    channel.cells = [1, 1];
    required(channel.patterns[1]).notes = [
      createNote(0, 0.4, 48),
      createNote(1, 1.4, 48),
      createNote(2.5, 2.9, 48),
    ];
    const instrument = createInstrument(type);
    if (type !== "drumset") {
      instrument.envelopes = [{ ...createEnvelope(), type: "Decay", speed: 5 }];
    }
    channel.instruments = [instrument];
    const starts: number[] = [];
    const { runtime } = createNativeSynth(
      song,
      channel,
      instrument,
      8000,
      (envelope, seconds, beats, expression) => {
        if (seconds === 0) {
          starts.push(beats);
        }
        return envelopeValue(envelope, seconds, beats, expression);
      },
    );
    const noteFrames = [0, 4000, 10_000, 16_000, 20_000];
    const peaks = noteFrames.map(() => 0);

    for (let frame = 0; frame < 24_000; frame++) {
      const [left, right] = runtime.sample(true, [], song.tempo, 0);
      for (const [index, start] of noteFrames.entries()) {
        if (frame >= start && frame < start + 300) {
          peaks[index] = Math.max(required(peaks[index]), Math.abs(left), Math.abs(right));
        }
      }
    }
    expect(starts).toEqual([0, 0, 0, 0, 0]);
    for (const peak of peaks) {
      expect(peak).toBeGreaterThan(0.001);
    }
  });

  test(`${type} beat envelopes follow tempo changes during a held note`, () => {
    const song = createSong();
    song.tempo = 120;
    const channel = required(song.channels[0]);
    channel.cells.fill(1);
    required(channel.patterns[1]).notes = [createNote(0, 4, 48)];
    const instrument = createInstrument(type);
    if (type !== "drumset") {
      instrument.envelopes = [{ ...createEnvelope(), type: "Decay" }];
    }
    channel.instruments = [instrument];
    let elapsedSeconds = 0;
    let elapsedBeats = 0;
    const { runtime } = createNativeSynth(
      song,
      channel,
      instrument,
      8000,
      (envelope, seconds, beats, expression) => {
        elapsedSeconds = Math.max(elapsedSeconds, seconds);
        elapsedBeats = Math.max(elapsedBeats, beats);
        return envelopeValue(envelope, seconds, beats, expression);
      },
    );

    for (let frame = 0; frame < 2000; frame++) {
      runtime.sample(true, [], 120, 0);
    }
    expect(elapsedBeats).toBeCloseTo(0.5, 1);
    for (let frame = 0; frame < 2000; frame++) {
      runtime.sample(true, [], 240, 0);
    }
    expect(elapsedSeconds).toBeCloseTo(0.5, 1);
    expect(elapsedBeats).toBeCloseTo(1.5, 1);
  });

  for (const timeBasis of ["beats", "seconds"]) {
    test(`${type} synchronized ${timeBasis} envelopes follow bars, seeking and remapped sequences`, () => {
      const { runtime, envelope, readings } = synchronizedFixture(type, timeBasis);

      for (let frame = 0; frame < 16_001; frame++) {
        runtime.sample(true, [], 120, 0);
      }
      const barStart = required(readings.find(({ beats }) => beats === 4));
      expect(barStart.seconds).toBe(2);
      expect(barStart.value).toBeCloseTo(envelopeValue(envelope, 2, 4));

      runtime.seek(1);
      readings.length = 0;
      runtime.sample(true, [], 120, 0);
      expect(required(readings[0]).beats).toBe(4);
      expect(required(readings[0]).seconds).toBe(2);
      expect(required(readings[0]).value).toBeCloseTo(barStart.value);

      const remapped = synchronizedFixture(type, timeBasis, [1, 0]);

      for (let frame = 0; frame < 16_000; frame++) {
        remapped.runtime.sample(true, [], 120, 0);
      }
      expect(required(remapped.readings[0]).beats).toBe(4);
      expect(required(remapped.readings[0]).seconds).toBe(2);
      expect(required(remapped.readings.at(-1)).beats).toBe(8);
      remapped.readings.length = 0;
      remapped.runtime.sample(true, [], 120, 0);
      expect(required(remapped.readings[0]).beats).toBe(0);
      expect(required(remapped.readings[0]).seconds).toBe(0);
    });
  }
}
