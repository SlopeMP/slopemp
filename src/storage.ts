import { decodeBytes, encodeBytes } from "@slopemp/song/binary-frame";
import { parseSongBytes, serializeSongBytes as encodeSongBytes } from "@slopemp/song/codec";
import { mapInstrument, packMessage, unpackMessage } from "@slopemp/song/protobuf";
import { isRecord } from "@slopemp/song/shape";

import { InstrumentClipboardSchema, PatternClipboardSchema } from "./generated/clipboard_pb";
import { readStoredValue, writeStoredValue } from "./indexed-storage";
import { validateInstrument } from "./instruments";
import type { Instrument } from "./instruments";
import { isSnapshot } from "./model";
import type { Song } from "./model";
import { validateClipboard } from "./operations";
import type { PatternClipboard } from "./operations";

export { parseSongBytes, readSongData } from "@slopemp/song/codec";

type EncodedSong = { bytes: Uint8Array<ArrayBuffer>; link?: string };
const encodedSongs = new WeakMap<Song, EncodedSong>();
const encodeSnapshot = (song: Song): EncodedSong => {
  const cached = encodedSongs.get(song);
  if (cached) {
    return cached;
  }
  const encoded = { bytes: encodeSongBytes(song) };
  // History deeply freezes snapshots. Mutable drafts must always encode afresh.
  if (isSnapshot(song)) {
    encodedSongs.set(song, encoded);
  }
  return encoded;
};
export const encodeSong = (song: Song): string => {
  const encoded = encodeSnapshot(song);
  return (encoded.link ??= encodeBytes(encoded.bytes));
};
export const decodeSong = (encoded: string): Song => {
  try {
    return parseSongBytes(decodeBytes(encoded.replace(/^#/u, "")));
  } catch (error) {
    throw new Error(
      `Unable to open this song link. ${error instanceof Error ? error.message : "The song data is invalid."}`,
      { cause: error },
    );
  }
};
export const serializeSongBytes = (song: Song): Uint8Array<ArrayBuffer> =>
  encodeSnapshot(song).bytes.slice();
export const songURL = (song: Song, base = location.href): string => {
  const url = new URL(base);
  url.hash = encodeSong(song);
  return url.href;
};
type SnapshotKey = "clipboard.instrument" | "clipboard.pattern" | "session";
// Pending and failed writes take priority over older durable snapshots.
const unsaved = new Map<SnapshotKey, { data: Uint8Array }>();
const read = async (key: SnapshotKey): Promise<unknown> => {
  try {
    return unsaved.get(key)?.data ?? (await readStoredValue(key));
  } catch {
    return unsaved.get(key)?.data;
  }
};
const write = async (key: SnapshotKey, data: Uint8Array): Promise<boolean> => {
  const pending = { data };
  unsaved.set(key, pending);
  try {
    await writeStoredValue(key, data);
    if (unsaved.get(key) === pending) {
      unsaved.delete(key);
    }
    return true;
  } catch {
    return false;
  }
};
export const saveStoredSession = async (song: Song): Promise<boolean> => {
  try {
    return await write("session", encodeSnapshot(song).bytes);
  } catch {
    // Encoding rejection must preserve the last durable save and the current edit.
    return false;
  }
};
export const readStoredSession = async (): Promise<Song | null> => {
  const value = await read("session");
  if (value === undefined) {
    return null;
  }
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("Invalid stored song.");
  }
  return parseSongBytes(value);
};
export const serializeInstrumentClipboard = (value: unknown): Uint8Array<ArrayBuffer> => {
  if (!validateInstrument(value)) {
    throw new TypeError("Invalid clipboard instrument.");
  }
  return packMessage(InstrumentClipboardSchema, { instrument: mapInstrument(value) });
};
export const serializePatternClipboard = (value: unknown): Uint8Array<ArrayBuffer> => {
  if (!validateClipboard(value)) {
    throw new TypeError("Invalid clipboard pattern.");
  }
  return packMessage(PatternClipboardSchema, value);
};
export const saveClipboard = async (
  value: Instrument | PatternClipboard,
  kind: "instrument" | "pattern" = "pattern",
): Promise<boolean> => {
  try {
    const bytes =
      kind === "instrument"
        ? serializeInstrumentClipboard(value)
        : serializePatternClipboard(value);
    return await write(`clipboard.${kind}`, bytes);
  } catch {
    return false;
  }
};
export function loadClipboard(kind?: "pattern"): Promise<PatternClipboard | null>;
export function loadClipboard(kind: "instrument"): Promise<Instrument | null>;
export async function loadClipboard(
  kind: "instrument" | "pattern" = "pattern",
): Promise<Instrument | PatternClipboard | null> {
  const value = await read(`clipboard.${kind}`);
  if (!(value instanceof Uint8Array)) {
    return null;
  }
  try {
    if (kind === "pattern") {
      const parsed = unpackMessage(PatternClipboardSchema, value);
      return validateClipboard(parsed) ? parsed : null;
    }
    const parsed = unpackMessage(InstrumentClipboardSchema, value);
    const instrument = isRecord(parsed) ? parsed["instrument"] : undefined;
    return validateInstrument(instrument) ? instrument : null;
  } catch {
    return null;
  }
}
