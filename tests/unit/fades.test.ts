import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import { createEnvelope, createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";

const sampleRate = 8000;
const render = (type: string, tempo: number, release: number): Float32Array => {
  const song = createSong();
  song.tempo = tempo;
  song.beatsPerBar = 4;
  song.barCount = 1;
  song.loopEnd = 1;
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  channel.id = "live-channel";
  channel.cells = [1];
  const instrument = createInstrument(type);
  instrument.attack = 0;
  instrument.release = release;
  channel.instruments = [instrument];
  required(channel.patterns[1]).notes = [createNote(0, 2, 48)];
  const renderer = new SongRenderer(song, sampleRate);
  const samples = new Float32Array(Math.ceil((120 / tempo + 0.1) * sampleRate));
  renderer.process(samples, new Float32Array(samples.length));
  expect(samples.every(Number.isFinite)).toBe(true);
  return samples;
};
const rms = (samples: Float32Array, start: number, end: number): number => {
  const window = samples.subarray(start, end);
  return Math.sqrt(window.reduce((sum, sample) => sum + sample * sample, 0) / window.length);
};
for (const type of ["chip wave", "FM (n-op)", "Custom chip wave"]) {
  for (const tempo of [30, 300]) {
    test(`${type} negative fade ramps over the final beats at ${tempo} BPM and stays silent afterward`, () => {
      const baseline = render(type, tempo, 0);
      const faded = render(type, tempo, -0.5);
      const framesPerBeat = (60 / tempo) * sampleRate;
      const end = 2 * framesPerBeat;
      expect(rms(faded, framesPerBeat, 1.5 * framesPerBeat)).toBeGreaterThan(0.001);
      expect(rms(faded, 1.8 * framesPerBeat, end)).toBeLessThan(
        rms(baseline, 1.8 * framesPerBeat, end) * 0.5,
      );
      expect(rms(faded, end + 0.025 * sampleRate, faded.length)).toBe(0);
      if (type === "Custom chip wave") {
        for (let frame = 0; frame < end; frame++) {
          const gain = Math.min(1, (2 - frame / framesPerBeat) / 0.5);
          expect(faded[frame]).toBeCloseTo(required(baseline[frame]) * gain, 6);
        }
        // A negative fade must not restart at full volume as a release tail.
        expect(rms(faded, end + 1, faded.length)).toBe(0);
      }
    });
  }
}

const longFadeSong = (): ReturnType<typeof createSong> => {
  const song = createSong();
  song.tempo = 120;
  song.beatsPerBar = 8;
  song.barCount = 1;
  song.loopEnd = 1;
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  channel.cells = [1];
  const instrument = createInstrument("FM (n-op)");
  instrument.attack = 0;
  instrument.release = 1.4;
  channel.instruments = [instrument];
  return song;
};
const stereo = (renderer: SongRenderer, frames: number): [Float32Array, Float32Array] => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  renderer.process(left, right);
  expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true);
  return [left, right];
};

test("overlapping FM chords retain each note's full stereo release tail", () => {
  const song = longFadeSong();
  const channel = required(song.channels[0]);
  const instrument = required(channel.instruments[0]);
  const carrier = required(instrument.operators[0]);
  carrier.wave = "sawtooth";
  carrier.pan = -0.3;
  carrier.stereoDetune = 12;
  required(instrument.operators[1]).wave = "pulse width";
  instrument.envelopes = [
    { ...createEnvelope(), target: `operator:${carrier.id}:offset`, type: "Flare", a: 0.4 },
  ];
  carrier.offset = 11;
  const notes = Array.from({ length: 6 }, (_, index) =>
    createNote(index / 8, index / 8 + 1 / 16, [48 + index, 55 + index]),
  );
  required(channel.patterns[1]).notes = notes;
  const frames = Math.round(sampleRate * 1.85);
  const combined = stereo(new SongRenderer(song, sampleRate), frames);
  const expected = [new Float64Array(frames), new Float64Array(frames)];
  for (const note of notes) {
    const isolated = structuredClone(song);
    required(required(isolated.channels[0]).patterns[1]).notes = [note];
    const solo = stereo(new SongRenderer(isolated, sampleRate), frames);
    for (let side = 0; side < 2; side++) {
      const sum = required(expected[side]);
      const samples = required(solo[side]);
      for (let frame = 0; frame < frames; frame++) {
        sum[frame] = required(sum[frame]) + required(samples[frame]);
      }
      // A quiet final portion of every fade remains audible, even with many voices.
      const end = (note.end / 2 + instrument.release) * sampleRate;
      expect(rms(samples, end - 0.1 * sampleRate, end - 0.05 * sampleRate)).toBeGreaterThan(1e-6);
    }
  }
  let error = 0;
  for (let side = 0; side < 2; side++) {
    const actual = required(combined[side]);
    const sum = required(expected[side]);
    for (let frame = 0; frame < frames; frame++) {
      error = Math.max(error, Math.abs(required(actual[frame]) - required(sum[frame])));
    }
    expect(rms(actual, frames - 0.05 * sampleRate, frames)).toBe(0);
  }
  expect(error, "maximum stereo error against the sum of isolated notes").toBeLessThan(1e-7);
  expect(combined[0]).not.toEqual(combined[1]);
});

test("envelope edits rebuild FM control bindings while a long release is sounding", () => {
  const song = longFadeSong();
  const channel = required(song.channels[0]);
  const instrument = required(channel.instruments[0]);
  instrument.operators = instrument.operators.slice(0, 1);
  instrument.connections = [];
  required(channel.patterns[1]).notes = [createNote(0, 0.25, 48)];
  const edited = new SongRenderer(song, sampleRate);
  const reference = new SongRenderer(structuredClone(song), sampleRate);
  expect(stereo(edited, 2000)).toEqual(stereo(reference, 2000));
  const carrier = required(instrument.operators[0]);
  for (const { target, enabled, amplitude } of [
    { target: `operator:${carrier.id}:amplitude`, enabled: true, amplitude: 0.5 },
    { target: `operator:${carrier.id}:amplitude`, enabled: false, amplitude: 1 },
    { target: `operator:${carrier.id}:pan`, enabled: true, amplitude: 1 },
  ]) {
    edited.song = structuredClone(edited.song);
    required(required(edited.song.channels[0]).instruments[0]).envelopes = [
      { ...createEnvelope(), target, enabled, a: 0.5, b: 0.5 },
    ];
    reference.song = structuredClone(reference.song);
    required(required(required(reference.song.channels[0]).instruments[0]).operators[0]).amplitude =
      amplitude;
    const actual = stereo(edited, 1024);
    expect(actual).toEqual(stereo(reference, 1024));
    expect(actual[0].some((sample) => Math.abs(sample) > 1e-5)).toBe(true);
  }
});
