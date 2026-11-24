import { expect, test } from "bun:test";

import { createEffect, createEnvelope, createInstrument } from "../../src/instruments";
import { createSong, required } from "../../src/model";
import {
  loadClipboard,
  readStoredSession,
  saveClipboard,
  saveStoredSession,
} from "../../src/storage";

test("unavailable storage reports failure and keeps the latest snapshots in memory", async () => {
  const song = createSong();
  const instrument = createInstrument();
  const savingSong = saveStoredSession(song);
  const copying = saveClipboard(instrument, "instrument");
  song.tempo = 200;
  instrument.volume = 0.5;
  expect(required(await readStoredSession()).tempo).toBe(150);
  expect(required(await loadClipboard("instrument")).volume).toBe(0.8);
  expect(await savingSong).toBe(false);
  expect(await copying).toBe(false);
});

test("oversized snapshots preserve the last readable song and clipboard", async () => {
  const song = createSong();
  const instrument = createInstrument();
  await saveStoredSession(song);
  await saveClipboard(instrument, "instrument");
  const { title } = song;
  const { name } = instrument;

  song.title = "x".repeat(16 * 1024 * 1024);
  instrument.name = song.title;
  expect(await saveStoredSession(song)).toBe(false);
  expect(await saveClipboard(instrument, "instrument")).toBe(false);
  expect(required(await readStoredSession()).title).toBe(title);
  expect(required(await loadClipboard("instrument")).name).toBe(name);
});

test("invalid snapshot fields preserve the last readable song and clipboard", async () => {
  const song = createSong();
  const instrument = required(required(song.channels[0]).instruments[0]);
  await saveStoredSession(song);
  await saveClipboard(instrument, "instrument");
  const saved = await readStoredSession();
  const clipboard = await loadClipboard("instrument");

  instrument.attack = Infinity;
  expect(await saveStoredSession(song)).toBe(false);
  expect(await saveClipboard(instrument, "instrument")).toBe(false);
  expect(await readStoredSession()).toEqual(saved);
  expect(await loadClipboard("instrument")).toEqual(clipboard);
});

test("invalid optional protobuf values preserve the last readable clipboard", async () => {
  const instrument = createInstrument();
  await saveClipboard(instrument, "instrument");
  const saved = await loadClipboard("instrument");

  instrument.envelopes = [{ ...createEnvelope(), curve: Number.NaN }];
  expect(await saveClipboard(instrument, "instrument")).toBe(false);
  instrument.envelopes = [];
  const effect = createEffect("Chorus");
  effect.parameters = { constructor: true };
  instrument.effects = [effect];
  expect(await saveClipboard(instrument, "instrument")).toBe(false);
  expect(await loadClipboard("instrument")).toEqual(saved);
});
