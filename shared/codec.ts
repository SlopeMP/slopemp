import { SongSchema } from "./generated/song_pb";
import { validateSong } from "./model";
import type { Song } from "./model";
import { mapSong, packMessage, unpackMessage } from "./protobuf";
import { isRecord } from "./shape";

export const readSongData = (input: unknown): Song => {
  validateSong(input);
  return input;
};

const fields = (value: unknown, keys: string[]): unknown =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)))
    : value;

const resourceReference = (resource: unknown): unknown => {
  const reference = fields(resource, [
    "id",
    "url",
    "rootKey",
    "start",
    "loopStart",
    "loopEnd",
    "mode",
    "backwards",
    "metadata",
  ]);
  if (isRecord(reference) && Object.hasOwn(reference, "metadata")) {
    reference["metadata"] = fields(reference["metadata"], ["bundled", "license", "revision"]);
  }
  return reference;
};

export const parseSongBytes = (bytes: Uint8Array): Song =>
  readSongData(unpackMessage(SongSchema, bytes));

export const serializeSongBytes = (song: Song): Uint8Array<ArrayBuffer> => {
  const data = {
    ...song,
    resources: Array.isArray(song.resources)
      ? song.resources.map(resourceReference)
      : song.resources,
  };
  return packMessage(SongSchema, mapSong(readSongData(data)));
};
