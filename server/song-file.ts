import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { createSong } from "@slopemp/song";
import type { Song } from "@slopemp/song";
import { parseSongBytes, serializeSongBytes } from "@slopemp/song/codec";

const fileMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const readSongFile = async (path: string): Promise<Uint8Array | null> => {
  try {
    return await readFile(path);
  } catch (error) {
    if (fileMissing(error)) {
      try {
        // A dangling symlink is still a file entry.
        await lstat(path);
      } catch (statError) {
        if (fileMissing(statError)) {
          return null;
        }
        throw new Error(`Could not inspect song file ${path}.`, { cause: statError });
      }
    }
    throw new Error(`Could not read song file ${path}.`, { cause: error });
  }
};

export const loadSong = async (path: string): Promise<Song> => {
  const bytes = await readSongFile(path);
  if (bytes === null) {
    return createSong();
  }
  try {
    return parseSongBytes(bytes);
  } catch (error) {
    throw new Error(`Corrupt song file ${path}.`, { cause: error });
  }
};

export const saveSong = async (path: string, song: Song): Promise<void> => {
  const bytes = serializeSongBytes(song);
  const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, "wx");
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};
