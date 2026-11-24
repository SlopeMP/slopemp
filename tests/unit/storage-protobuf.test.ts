import { expect, test } from "bun:test";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { decodeBytes, packBytes, unpackBytes } from "@slopemp/song/binary-frame";
import { EffectSchema } from "@slopemp/song/generated/instrument_pb.js";
import { SongSchema } from "@slopemp/song/generated/song_pb.js";
import { deflateSync } from "fflate";

import { createEffect, createEnvelope, createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, History, required } from "../../src/model";
import {
  decodeSong,
  encodeSong,
  parseSongBytes,
  readSongData,
  serializeSongBytes,
} from "../../src/storage";

test("song links and files carry the same schema-defined protobuf message", () => {
  const song = createSong();
  const track = required(song.channels[0]);
  const instrument = required(track.instruments[0]);
  const effect = createEffect("Chorus");
  effect.parameters = { depth: -0, enabled: false, mode: "" };
  instrument.effects = [effect];
  track.cells[0] = 1;
  const note = createNote(0, 1 / 3, 48);
  note.continues = false;
  required(track.patterns[1]).notes = [note];
  song.title = "曲 🎵 & <song>";
  song.detune = -0;
  const file = serializeSongBytes(song);
  expect(decodeBytes(encodeSong(song))).toEqual(file);
  const message = fromBinary(SongSchema, unpackBytes(file));
  expect(message.title).toBe(song.title);
  expect(message.detune).toBe(-0);
  expect(message.channels[0]?.patterns[1]?.notes[0]?.continues).toBe(false);
  expect(message.channels[0]?.instruments[0]?.effects[0]?.parameters["depth"]?.kind).toEqual({
    case: "number",
    value: -0,
  });
  expect(parseSongBytes(file)).toEqual(song);
});
test("songs round-trip identities, envelope bounds, and SoundFont settings", () => {
  const song = createSong();
  const instrument = createInstrument("SoundFont");
  required(song.channels[0]).instruments = [instrument];
  const resource = required(song.resources[0]);
  instrument.resourceId = resource.id;
  instrument.bank = 128;
  instrument.program = 8;
  instrument.presetEffects = false;
  const envelope = createEnvelope();
  envelope.a = -Infinity;
  envelope.b = Infinity;
  envelope.speed = Infinity;
  const modulator = { source: 3, destination: 26, amount: -1200, amountSource: 0, transform: 0 };
  envelope.sf2Modulators = [modulator];
  instrument.envelopes = [envelope];
  const bytes = serializeSongBytes(song);
  expect(parseSongBytes(bytes)).toEqual(song);
  expect(decodeSong(`#${encodeSong(song)}`)).toEqual(song);
  const restored = parseSongBytes(bytes);
  required(restored.channels[0]).name = "Detached";
  expect(required(song.channels[0]).name).not.toBe("Detached");
});
test("songs store asset references without derived or local file data", () => {
  const song = createSong();
  const reference = required(song.resources[0]);
  const resolved = {
    ...reference,
    name: "Display name",
    type: "soundfont",
    localName: "local.sf2",
    status: "ready",
    frames: 100,
    metadata: {
      ...reference.metadata,
      presets: [{ name: "Piano", bank: 0, program: 0 }],
      error: "Load failed.",
    },
  };
  song.resources = [resolved];
  expect(parseSongBytes(serializeSongBytes(song)).resources).toEqual([reference]);
  expect(decodeSong(encodeSong(song)).resources).toEqual([reference]);
});
test("100 mostly empty channels compress well and mutable drafts never return stale encodings", () => {
  const song = createSong();
  while (song.channels.length < 100) {
    song.channels.push(createChannel("track", song.barCount, song.patternCount));
  }
  const encoded = encodeSong(song);
  expect(encoded.length).toBeLessThan(JSON.stringify(song).length / 8);
  expect(decodeSong(encoded)).toEqual(song);
  song.tempo++;
  expect(encodeSong(song)).not.toBe(encoded);
  const history = new History(song);
  expect(encodeSong(history.song)).toBe(encodeSong(history.song));
});
test("corruption, truncation, oversized decompression headers, and unsupported versions are rejected", () => {
  const bytes = serializeSongBytes(createSong());
  for (const offset of [0, 3, 4, 8, 12, Math.floor(bytes.length / 2), bytes.length - 1]) {
    const corrupt = bytes.slice();
    corrupt[offset] = required(corrupt[offset]) ^ 255;
    expect(() => parseSongBytes(corrupt)).toThrow();
  }
  for (const length of [0, 1, 12, bytes.length - 1]) {
    expect(() => parseSongBytes(bytes.subarray(0, length))).toThrow();
  }
  const bomb = bytes.slice();
  new DataView(bomb.buffer).setUint32(4, 4_294_967_295, true);
  expect(() => parseSongBytes(bomb)).toThrow();
  expect(() => readSongData({ ...createSong(), version: 99 })).toThrow("version");
  expect(() => decodeSong("%%%invalid")).toThrow("Unable to open");
  expect(() => decodeSong(btoa(JSON.stringify(createSong())))).toThrow();
});
test("current song data must contain complete valid fields instead of silently repairing damage", () => {
  for (const field of ["title", "tempo", "channels", "resources", "customScale", "volume"]) {
    expect(() => readSongData({ ...createSong(), [field]: undefined })).toThrow();
  }
  const song = createSong();
  const channel = required(song.channels[0]);
  channel.cells = [1];
  expect(() => readSongData(song)).toThrow();
  channel.cells = Array.from({ length: song.barCount }, () => 1);
  expect(() =>
    readSongData({
      ...song,
      channels: [{ ...channel, instruments: [{ ...createInstrument(), attack: "bad" }] }],
    }),
  ).toThrow();
});
test("framed protobuf with missing fields, invalid syntax, or an unknown version is rejected", () => {
  const bytes = serializeSongBytes(createSong());
  const message = fromBinary(SongSchema, unpackBytes(bytes));
  delete message.title;
  expect(() => parseSongBytes(packBytes(toBinary(SongSchema, message)))).toThrow("Invalid song");
  message.version = 99;
  expect(() => parseSongBytes(packBytes(toBinary(SongSchema, message)))).toThrow("version");
  expect(() => parseSongBytes(packBytes(Uint8Array.of(18, 10, 65)))).toThrow();
});

test("prototype keys in effect parameters are rejected in both directions", () => {
  const song = createSong();
  const track = required(song.channels[0]);
  const effect = createEffect("Chorus");
  effect.parameters = { ["__proto__"]: true };
  track.effects = [effect];
  expect(() => encodeSong(song)).toThrow();
  track.effects = [];
  const message = fromBinary(SongSchema, unpackBytes(serializeSongBytes(song)));
  required(message.channels[0]).effects = [
    create(EffectSchema, {
      ...effect,
      parameters: { ["__proto__"]: { kind: { case: "boolean", value: true } } },
    }),
  ];
  expect(() => parseSongBytes(packBytes(toBinary(SongSchema, message)))).toThrow();
});

test("near-limit payloads remain readable and oversized payloads are rejected", () => {
  const limit = 16 * 1024 * 1024;
  const bytes = new Uint8Array(limit);
  bytes.fill(120);
  expect(unpackBytes(packBytes(bytes))).toEqual(bytes);
  expect(() => packBytes(new Uint8Array(limit + 1))).toThrow("16 MiB");
});

test("shallow-frozen caller objects never reuse a stale encoding after nested edits", () => {
  const song = Object.freeze(createSong());
  const before = encodeSong(song);
  required(song.channels[0]).name = "Changed after shallow freeze";
  const after = encodeSong(song);
  expect(after).not.toBe(before);
  expect(required(decodeSong(after).channels[0]).name).toBe("Changed after shallow freeze");
});

test("drum envelope infinity bounds survive binary files and song links", () => {
  const song = createSong();
  const instrument = createInstrument("drumset");
  const { envelope } = required(instrument.drums[0]);
  envelope.a = -Infinity;
  envelope.b = Infinity;
  envelope.speed = Infinity;
  envelope.sf2Modulators = [];
  required(song.channels[0]).instruments = [instrument];
  expect(parseSongBytes(serializeSongBytes(song))).toEqual(song);
  expect(decodeSong(encodeSong(song))).toEqual(song);
});

test("encoding rejects invalid instrument fields before saving an unreadable song", () => {
  const song = createSong();
  required(required(song.channels[0]).instruments[0]).attack = Infinity;
  expect(() => encodeSong(song)).toThrow("instrument");
  expect(() => serializeSongBytes(song)).toThrow("instrument");
});

test("inflated data cannot silently extend beyond the size covered by its checksum", () => {
  const body = Uint8Array.of(8, 1);
  const valid = packBytes(body);
  const compressed = deflateSync(Uint8Array.of(...body, 0));
  const oversized = new Uint8Array(12 + compressed.length);
  oversized.set(valid.subarray(0, 12));
  oversized.set(compressed, 12);
  expect(() => unpackBytes(oversized)).toThrow("corrupt");
});
