import { expect, test } from "bun:test";

import { createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { createNativeSynth } from "../../src/synth/adapter";

test("native drum filters stay finite below their initial cutoff frequency", () => {
  const song = createSong();
  song.barCount = 1;
  song.beatsPerBar = 1;
  song.loopEnd = 1;
  song.tempo = 300;
  const channel = required(song.channels[0]);
  channel.cells = [1];
  required(channel.patterns[1]).notes = [createNote(0, 0.8, 48)];
  const instrument = createInstrument("drumset");
  for (const sampleRate of [8000, 16_000, 24_000, 44_100, 48_000, 96_000]) {
    const { runtime } = createNativeSynth(
      song,
      channel,
      instrument,
      sampleRate,
      (envelope, seconds) => Math.exp(-seconds * envelope.speed),
    );

    const samples = Array.from({ length: 4096 }, () => runtime.sample(true, [], song.tempo, 0)[0]);
    expect(samples.every(Number.isFinite), `${sampleRate} Hz`).toBe(true);
    expect(
      samples.some((sample) => sample !== 0),
      `${sampleRate} Hz`,
    ).toBe(true);
  }
});
