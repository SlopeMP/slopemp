import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import { createInstrument } from "../../src/instruments";
import { clone, createNote, createSong, notesTie, required } from "../../src/model";
import { cropNote } from "../../src/operations";
import { decodeSong, encodeSong } from "../../src/storage";

test("ties match the entire chord after its final bend", () => {
  const before = createNote(0, 1, [48, 52]);
  required(before.pins.at(-1)).interval = 2;
  const after = createNote(0, 1, [54, 50]);
  after.continues = true;
  expect(notesTie(before, after, 1)).toBe(true);
  after.pitches = [50];
  expect(notesTie(before, after, 1)).toBe(false);
  after.pitches = [54, 50];
  before.end = 0.9;
  expect(notesTie(before, after, 1)).toBe(false);
});

test("tied bars render like one sustained note, including envelopes and early release", () => {
  for (const release of [0.1, -0.1]) {
    const song = createSong();
    song.beatsPerBar = 1;
    song.barCount = 2;
    song.loopEnd = 2;
    song.tempo = 150;
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    channel.cells = [1, 2];
    channel.instruments = [createInstrument()];
    required(channel.instruments[0]).attack = 0.2;
    required(channel.instruments[0]).release = release;
    required(channel.patterns[1]).notes = [createNote(0, 1, [48, 52])];
    const second = createNote(0, 1, [48, 52]);
    second.continues = true;
    required(channel.patterns[2]).notes = [second];
    const long = clone(song);
    long.beatsPerBar = 2;
    long.barCount = 1;
    long.loopEnd = 1;
    const longChannel = required(long.channels[0]);
    longChannel.cells = [1];
    required(longChannel.patterns[1]).notes = [createNote(0, 2, [48, 52])];
    const tiedRenderer = new SongRenderer(song, 8000, 0, [0, 1]);
    const longRenderer = new SongRenderer(long, 8000, 0, [0]);
    let difference = 0;
    for (let frame = 0; frame < 6300; frame++) {
      difference = Math.max(
        difference,
        Math.abs(tiedRenderer.sample()[0] - longRenderer.sample()[0]),
      );
    }
    expect(difference).toBeLessThan(1e-7);
    expect(decodeSong(encodeSong(song)).channels[0]?.patterns[2]?.notes[0]?.continues).toBe(true);
  }
});

test("cropping preserves a tie only at the start of a bar", () => {
  const note = createNote(0, 1, 48);
  note.continues = true;
  expect(cropNote(note, 0, 0.5)?.continues).toBe(true);
  expect(cropNote(note, 0.5, 1)?.continues).toBe(false);
  expect(cropNote(note, 0, 1, 1)?.continues).toBe(false);
});

test("ties sustain through a repeated single-bar pattern and seek starts a fresh voice", () => {
  const song = createSong();
  song.channels = song.channels.slice(0, 1);
  song.beatsPerBar = 1;
  song.barCount = 1;
  song.loopStart = 0;
  song.loopEnd = 1;
  song.tempo = 150;
  const channel = required(song.channels[0]);
  channel.cells = [1];
  channel.instruments = [createInstrument()];
  const note = createNote(0, 1, 48);
  note.continues = true;
  required(channel.patterns[1]).notes = [note];
  const long = clone(song);
  long.beatsPerBar = 2;
  required(required(long.channels[0]).patterns[1]).notes = [createNote(0, 2, 48)];
  const loop = new SongRenderer(song, 8000);
  const sustained = new SongRenderer(long, 8000);
  for (let frame = 0; frame < 6000; frame++) {
    expect(loop.sample()[0]).toBeCloseTo(sustained.sample()[0], 7);
  }
  loop.seek(0);
  const fresh = new SongRenderer(song, 8000);
  for (let frame = 0; frame < 100; frame++) {
    expect(loop.sample()[0]).toBeCloseTo(fresh.sample()[0], 7);
  }
});
