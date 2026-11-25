import { expect, test } from "bun:test";

import { envelopeValue, SongRenderer } from "../../src/audio";
import { createEnvelope, createInstrument } from "../../src/instruments";
import { createSong, required } from "../../src/model";
import { createNativeSynth } from "../../src/synth/adapter";

for (const playing of [false, true]) {
  test(`native input starts and ends between ticks while playing=${playing}`, () => {
    const song = createSong();
    const channel = required(song.channels[0]);
    channel.cells.fill(0);
    const instrument = createInstrument("chip wave");
    instrument.release = 0;
    channel.instruments = [instrument];
    const { runtime } = createNativeSynth(song, channel, instrument, 8000, envelopeValue);
    runtime.sample(playing, [], 60, 0);
    const left = new Float64Array(16);
    const right = new Float64Array(16);
    runtime.process(left, right, playing, [48], 60, 0);
    expect(left.some((sample) => sample !== 0)).toBe(true);
    const sustained = createNativeSynth(song, channel, instrument, 8000, envelopeValue).runtime;
    sustained.sample(playing, [], 60, 0);
    sustained.process(new Float64Array(16), new Float64Array(16), playing, [48], 60, 0);
    const held = new Float64Array(16);
    sustained.process(held, new Float64Array(16), playing, [48], 60, 0);
    runtime.process(left, right, playing, [], 60, 0);
    expect(left).not.toEqual(held);
  });
}

for (const chords of ["arpeggio", "custom interval"]) {
  for (const transition of ["normal", "continue"]) {
    test(`native ${chords} ${transition} keeps its attack through overlapping held keys`, () => {
      const song = createSong();
      const channel = required(song.channels[0]);
      channel.cells.fill(0);
      const instrument = createInstrument("chip wave");
      instrument.chords = chords;
      instrument.transition = transition;
      instrument.release = 0;
      instrument.envelopes = [{ ...createEnvelope(), target: "volume", type: "Decay" }];
      channel.instruments = [instrument];
      const ages: number[] = [];
      const { runtime } = createNativeSynth(
        song,
        channel,
        instrument,
        8000,
        (envelope, seconds, beats, size) => {
          ages.push(seconds);
          return envelopeValue(envelope, seconds, beats, size);
        },
      );
      const render = (pitches: number[]): number => {
        ages.length = 0;
        runtime.process(
          new Float64Array(256),
          new Float64Array(256),
          false,
          pitches,
          song.tempo,
          0,
        );
        return required(ages[0]);
      };
      expect(render([48])).toBe(0);
      let previous = required(ages.at(-1));
      expect(render([48, 55])).toBeGreaterThanOrEqual(previous);
      previous = required(ages.at(-1));
      expect(render([48])).toBeGreaterThanOrEqual(previous);
      previous = required(ages.at(-1));

      // An overlapping handoff can arrive entirely between two render blocks.
      runtime.setLivePitches([48, 55]);
      runtime.setLivePitches([55]);
      expect(render([55])).toBeGreaterThanOrEqual(previous);

      // Replacing every held key, or releasing and pressing again, starts a note.
      runtime.setLivePitches([60]);
      expect(render([60])).toBe(0);
      runtime.setLivePitches([]);
      runtime.setLivePitches([60]);
      expect(render([60])).toBe(0);
    });
  }
}

for (const type of ["chip wave", "FM (n-op)"]) {
  for (const recording of [false, true]) {
    test(`${type} retriggers after an off/on pair between render blocks, recording=${recording}`, () => {
      const song = createSong();
      song.channels = song.channels.slice(0, 1);
      const channel = required(song.channels[0]);
      channel.cells.fill(0);
      const instrument = createInstrument(type);
      instrument.release = 0;
      channel.instruments = [instrument];
      const released = new SongRenderer(song, 8000);
      released.playing = recording;
      released.recording = recording;
      const renderer = new SongRenderer(song, 8000);
      renderer.playing = recording;
      renderer.recording = recording;
      const render = (frames: number): Float32Array => {
        const left = new Float32Array(frames);
        renderer.process(left, new Float32Array(frames));
        return left;
      };
      released.process(new Float32Array(1), new Float32Array(1));
      released.audition(channel, 48);
      render(1);
      renderer.audition(channel, 48);
      const attack = render(12);
      render(16);
      released.process(new Float32Array(28), new Float32Array(28));
      released.release(48);
      renderer.release(48);
      renderer.audition(channel, 48);
      const tail = new Float32Array(12);
      released.process(tail, new Float32Array(12));
      const retriggered = render(12);
      for (let frame = 0; frame < 12; frame++) {
        expect(required(retriggered[frame]) - required(tail[frame])).toBeCloseTo(
          required(attack[frame]),
          6,
        );
      }
    });
  }
}
