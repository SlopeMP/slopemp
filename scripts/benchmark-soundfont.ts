import { createHash } from "node:crypto";

import { registerSoundFont, SongRenderer } from "../src/audio";
import { audioBlockFrames } from "../src/audio-output-buffer";
import { AudioThreadPool } from "../src/audio-thread-pool";
import { denseSoundFontSong } from "../tests/fixtures/dense-soundfont-song";

// CPU-only dense playback at the same block size used by the audio worker.
// Browser continuity tests cover worker scheduling and the actual output stream.
const sampleRate = 44_100;
const tracks = Number(process.env["SLOPEMP_BENCH_TRACKS"] ?? 32);
const seconds = Number(process.env["SLOPEMP_BENCH_SECONDS"] ?? 4);
const repeats = Number(process.env["SLOPEMP_BENCH_REPEATS"] ?? 3);
if (
  !Number.isSafeInteger(tracks) ||
  tracks < 1 ||
  tracks > 100 ||
  !Number.isFinite(seconds) ||
  Math.round(seconds * sampleRate) < 1 ||
  !Number.isSafeInteger(repeats) ||
  repeats < 1
) {
  throw new Error("Use 1–100 tracks and positive seconds/repeats.");
}
registerSoundFont(
  "dense-font",
  await Bun.file(new URL("../tests/assets/florestan-subset.sf2", import.meta.url)).arrayBuffer(),
);
const song = denseSoundFontSong(tracks);
for (let run = 1; run <= repeats; run++) {
  const master = new SongRenderer(song, sampleRate, 0, undefined, { channelIds: new Set() });
  const pool = new AudioThreadPool({
    song,
    sampleRate,
    bar: 0,
    beat: 0,
    playing: true,
    recording: false,
    muted: [],
    threadCount: 1,
  });
  const timings: number[] = [];
  const hash = createHash("sha256");
  const started = performance.now();
  try {
    const samples = Math.round(seconds * sampleRate);
    for (let frame = 0; frame < samples; frame += audioBlockFrames) {
      const began = performance.now();
      const { left, right } = await pool.renderBlock(
        master,
        Math.min(audioBlockFrames, samples - frame),
      );
      timings.push(performance.now() - began);
      hash.update(left).update(right);
    }
    const elapsedMs = performance.now() - started;
    timings.sort((left, right) => left - right);
    const percentile = (fraction: number): number =>
      Number(
        (timings[Math.min(timings.length - 1, Math.floor(fraction * timings.length))] ?? 0).toFixed(
          2,
        ),
      );
    process.stdout.write(
      `${JSON.stringify({ tracks, instruments: tracks * 2, seconds, run, elapsedMs: Math.round(elapsedMs), realtimeFactor: Number(((seconds * 1000) / elapsedMs).toFixed(2)), blockBudgetMs: Number(((audioBlockFrames * 1000) / sampleRate).toFixed(2)), p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: percentile(1), hash: hash.digest("hex") })}\n`,
    );
  } finally {
    pool.close();
    master.reset();
  }
}
