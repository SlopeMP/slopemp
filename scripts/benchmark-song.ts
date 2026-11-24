import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { hasAudioResource, SongRenderer } from "../src/audio";
import { assetType } from "../src/resource-identity";
import { loadSoundFont } from "../src/soundfont-loader";
import { decodeSong } from "../src/storage";
import { resetSynthNoiseTables } from "../src/synth/runtime";

// Usage: bun scripts/benchmark-song.ts song.txt
// Keep the source song outside the benchmark so private compositions need not be committed.
const input = process.argv.at(2);
if (input === undefined || input === "") {
  throw new Error("Pass a text file containing a SlopeMP song URL or hash.");
}
const text = (await Bun.file(input).text()).trim();
const song = decodeSong(text.slice(text.indexOf("#") + 1));
const resourceRoot = process.env["SLOPEMP_BENCH_RESOURCES"] ?? "public";
const usedResources = new Set(
  song.channels.flatMap((channel) =>
    channel.instruments.map((instrument) => instrument.resourceId),
  ),
);
for (const resource of song.resources) {
  if (
    usedResources.has(resource.id) &&
    assetType(resource.url) === "soundfont" &&
    resource.url &&
    !/^https?:/u.test(resource.url)
  ) {
    await loadSoundFont(
      resource.id,
      await Bun.file(resolve(resourceRoot, resource.url)).arrayBuffer(),
    );
  }
}
for (const channel of song.channels) {
  for (const instrument of channel.instruments) {
    if (instrument.resourceId && !hasAudioResource(instrument.resourceId)) {
      throw new Error(`Benchmark resource unavailable: ${instrument.resourceId}`);
    }
  }
}
const sampleRate = Number(process.env["SLOPEMP_BENCH_SAMPLE_RATE"] ?? 44_100);
const seconds = Number(
  process.env["SLOPEMP_BENCH_SECONDS"] ?? (song.loopEnd * song.beatsPerBar * 60) / song.tempo,
);
const repeats = Number(process.env["SLOPEMP_BENCH_REPEATS"] ?? 3);
if (
  !Number.isFinite(seconds) ||
  seconds <= 0 ||
  !Number.isFinite(sampleRate) ||
  sampleRate <= 0 ||
  !Number.isSafeInteger(repeats) ||
  repeats <= 0
) {
  throw new Error("Benchmark seconds, sample rate, and repeats must be positive numbers.");
}
const { random } = Math;
try {
  for (let run = 0; run < repeats; run++) {
    let seed = 12_345;
    Math.random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    resetSynthNoiseTables();
    const renderer = new SongRenderer(structuredClone(song), sampleRate);
    const left = new Float32Array(Math.round(sampleRate * seconds));
    const right = new Float32Array(left.length);
    const midpoint = Math.floor(left.length / 2);
    const started = performance.now();
    renderer.process(left.subarray(0, midpoint), right.subarray(0, midpoint));
    const halfway = performance.now();
    renderer.process(left.subarray(midpoint), right.subarray(midpoint));
    const finished = performance.now();
    const elapsedMs = finished - started;
    const hash = createHash("sha256").update(left).update(right).digest("hex");
    process.stdout.write(
      `${JSON.stringify({ run: run + 1, seconds, sampleRate, elapsedMs: Math.round(elapsedMs), firstHalfMs: Math.round(halfway - started), secondHalfMs: Math.round(finished - halfway), realtimeFactor: Number(((seconds * 1000) / elapsedMs).toFixed(2)), hash })}\n`,
    );
    renderer.reset();
  }
} finally {
  Math.random = random;
}
