import { expect, test } from "bun:test";

import { processEffect, SongRenderer } from "../../src/audio";
import { createEffect, createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";

for (const amount of [0, 1, 25, 33, 50, 67, 99, 100]) {
  test(`native instrument chorus at ${amount}% matches the shared processor`, () => {
    const song = createSong();
    song.volume = 100;
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    channel.cells.fill(1);
    required(channel.patterns[1]).notes = [createNote(0, 4, [48, 55])];
    const dryInstrument = createInstrument("chip wave");
    dryInstrument.volume = 1;
    dryInstrument.effects = [];
    const wetInstrument = structuredClone(dryInstrument);
    const chorus = createEffect("Chorus");
    chorus.parameters["amount"] = amount;
    wetInstrument.effects = [chorus];
    channel.instruments = [dryInstrument];
    const dry = new SongRenderer(song, 8000);
    const wetSong = structuredClone(song);
    required(wetSong.channels[0]).instruments = [wetInstrument];
    const wet = new SongRenderer(wetSong, 8000);
    let difference = 0;
    let energy = 0;

    for (let frame = 0; frame < 20_000; frame++) {
      const input = dry.sample();
      const expected = processEffect(input, chorus, 8000, frame / 8000);
      const actual = wet.sample();
      energy += actual[0] ** 2 + actual[1] ** 2;
      difference = Math.max(
        difference,
        Math.abs(actual[0] - expected[0]),
        Math.abs(actual[1] - expected[1]),
      );
    }
    expect(difference).toBeLessThan(1e-7);
    expect(energy).toBeGreaterThan(0);
  });
}
