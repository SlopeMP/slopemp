import { deepStrictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";

import { inflateSync } from "fflate";

import { createChannel, createNote, createSong } from "../src/model";
import type { Song } from "../src/model";
import type * as SongStorage from "../src/storage";
import { profilePlaybackSong } from "./profile-playback-song";

const denseArrangement = (): Song => {
  const song = createSong("Minor");
  const patternCount = 32;
  song.title = "Dense arrangement";
  song.barCount = patternCount;
  song.patternCount = patternCount;
  song.channels = Array.from({ length: 12 }, (_channel, track) => {
    const channel = createChannel("track", song.barCount, song.patternCount);
    channel.cells = Array.from({ length: patternCount }, (_, bar) => bar + 1);
    for (const [patternIndex, pattern] of Object.values(channel.patterns).entries()) {
      pattern.notes = Array.from({ length: 16 }, (_, step) => {
        const pitch = 36 + ((track * 5 + patternIndex * 3 + step * 7) % 48);
        return createNote(step / 2, step / 2 + 1 / 3, [pitch, pitch + 7]);
      });
    }
    return channel;
  });
  return song;
};

const median = (samples: number[]): number => {
  const sorted = samples.toSorted((left, right) => left - right);
  const midpoint = sorted[Math.floor(sorted.length / 2)];
  if (midpoint === undefined) {
    throw new Error("Benchmark did not collect samples.");
  }
  return Number(midpoint.toFixed(3));
};

const time = (operation: () => unknown, iterations: number): number => {
  const start = performance.now();
  for (let run = 0; run < iterations; run++) {
    operation();
  }
  return (performance.now() - start) / iterations;
};

const canonicalize = (value: unknown): unknown => {
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return { number: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(Reflect.get(value, key))]),
    );
  }
  return value;
};

const measure = (storage: typeof SongStorage, fixture: string, song: Song): void => {
  const { decodeSong, encodeSong, parseSongBytes, serializeSongBytes } = storage;
  const file = serializeSongBytes(song);
  const link = encodeSong(song);
  deepStrictEqual(parseSongBytes(file), song);
  deepStrictEqual(decodeSong(link), song);

  // Time the file pipeline with mutable songs so frozen snapshot caches cannot mask codec costs.
  const iterations = Math.max(3, Math.round(190 / song.channels.length));
  const encode = (): Uint8Array => serializeSongBytes(song);
  const decode = (): Song => parseSongBytes(file);
  time(encode, iterations);
  time(decode, iterations);
  const encodeSamples: number[] = [];
  const decodeSamples: number[] = [];
  for (let sample = 0; sample < 9; sample++) {
    encodeSamples.push(time(encode, iterations));
    decodeSamples.push(time(decode, iterations));
  }

  process.stdout.write(
    `${JSON.stringify({
      fixture,
      inputHash: createHash("sha256")
        .update(JSON.stringify(canonicalize(song)))
        .digest("hex"),
      protobufBytes: inflateSync(file.subarray(12)).byteLength,
      fileBytes: file.byteLength,
      linkCharacters: link.length,
      encodeMs: median(encodeSamples),
      decodeMs: median(decodeSamples),
    })}\n`,
  );
};

// Copy this script into either checkout to compare releases. Verify that fixture hashes match.
const { now } = Date;
const { random } = Math;
let seed = 62_713;
try {
  Date.now = (): number => 1_763_510_000_000;
  Math.random = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  // Loading storage constructs validation shapes and consumes some of the seed.
  const storage = await import("../src/storage");
  measure(storage, "New song", createSong());
  measure(storage, "30-track playback profile", storage.decodeSong(await profilePlaybackSong()));
  measure(storage, "Dense arrangement", denseArrangement());
} finally {
  Date.now = now;
  Math.random = random;
}
