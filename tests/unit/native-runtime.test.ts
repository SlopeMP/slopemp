import { expect, test } from "bun:test";

import { envelopeValue } from "../../src/audio";
import { createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { createNativeSynth } from "../../src/synth/adapter";

test("native live input detects array mutations and sustains equal replacement pitches", () => {
  const song = createSong();
  const channel = required(song.channels[0]);
  const instrument = createInstrument("chip wave");
  channel.cells.fill(0);
  channel.instruments = [instrument];
  const actual = createNativeSynth(song, channel, instrument, 8000, envelopeValue).runtime;
  const reference = createNativeSynth(song, channel, instrument, 8000, envelopeValue).runtime;
  let pitches = [60];

  for (let frame = 0; frame < 4096; frame++) {
    if (frame === 512) {
      pitches[0] = 72;
    } else if (frame === 1024) {
      pitches = pitches.slice();
    } else if (frame === 1536) {
      pitches.push(67);
    } else if (frame === 2048) {
      pitches.length = 0;
    }
    expect(actual.sample(false, pitches, 150, 0)).toEqual(
      reference.sample(false, [...pitches], 150, 0),
    );
  }
});

for (const chords of ["simultaneous", "strum", "arpeggio", "custom interval"]) {
  for (const count of [5, 12, 32]) {
    test(`native ${chords} playback retains all ${count} chord pitches`, () => {
      const render = (lastPitchOffset: number): Float64Array => {
        const song = createSong();
        const channel = required(song.channels[0]);
        const instrument = createInstrument("chip wave");
        instrument.chords = chords;
        channel.instruments = [instrument];
        channel.cells.fill(1);
        const pitches = Array.from({ length: count }, (_, i) => 24 + i);
        pitches[count - 1] = required(pitches[count - 1]) + lastPitchOffset;
        required(channel.patterns[1]).notes = [createNote(0, song.beatsPerBar, pitches)];
        const { runtime } = createNativeSynth(song, channel, instrument, 8000, envelopeValue);
        const left = new Float64Array(32_768);
        const right = new Float64Array(left.length);
        runtime.process(left, right, true, [], song.tempo, 0);
        expect(left.every(Number.isFinite)).toBe(true);
        expect(left.some((sample) => sample !== 0)).toBe(true);
        return left;
      };
      // A pitch beyond either former limit must still affect the rendered audio.
      expect(render(12)).not.toEqual(render(0));
    });
  }
}
