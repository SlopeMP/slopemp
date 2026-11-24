import { expect, test } from "bun:test";

import { envelopeValue } from "../../src/audio";
import { createInstrument } from "../../src/instruments";
import { createSong, required } from "../../src/model";
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
