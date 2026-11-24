import { createHash } from "node:crypto";

import { SongRenderer } from "../src/audio";
import { AudioThreadPool, mixStems } from "../src/audio-thread-pool";
import { createInstrument } from "../src/instruments";
import { createChannel, createNote, createSong, required } from "../src/model";
import { resetSynthNoiseTables } from "../src/synth/runtime";

// Isolate CPU synthesis from browser startup, worker messaging and file encoding.
// Use --cpu-prof-md to locate DSP/control costs; hashes expose sound changes.
const sampleRate = 44_100;
const seconds = Number(process.env["SLOPEMP_BENCH_SECONDS"] ?? 8);
const repeats = Number(process.env["SLOPEMP_BENCH_REPEATS"] ?? 3);
const tracks = Number(process.env["SLOPEMP_BENCH_TRACKS"] ?? 4);
if (
  !Number.isFinite(seconds) ||
  Math.round(sampleRate * seconds) < 1 ||
  !Number.isSafeInteger(repeats) ||
  repeats < 1 ||
  !Number.isSafeInteger(tracks) ||
  tracks < 1 ||
  tracks > 100
) {
  throw new Error(
    "Benchmark seconds/repeats must be positive; tracks must be an integer from 1 to 100.",
  );
}
for (const type of ["FM (n-op)", "chip wave", "harmonics", "supersaw"]) {
  const song = createSong();
  song.resources = [];
  song.beatsPerBar = 4;
  song.channels = Array.from({ length: tracks }, (_unused, index) => {
    const channel = createChannel("track", song.barCount, song.patternCount);
    channel.cells.fill(1);
    const instrument = createInstrument(type);
    instrument.volume = 0.2;
    channel.instruments = [instrument];
    const step = index % 12;
    required(channel.patterns[1]).notes = [
      createNote(0, song.beatsPerBar, [48 + step, 55 + step, 60 + step]),
    ];
    return channel;
  });
  for (let run = 1; run <= repeats; run++) {
    const { random } = Math;
    let seed = 12_345;
    Math.random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    resetSynthNoiseTables();
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
    const hash = createHash("sha256");
    let planMs = 0;
    let synthMs = 0;
    let mixMs = 0;
    try {
      const samples = Math.round(sampleRate * seconds);
      for (let start = 0; start < samples; start += 8192) {
        const frames = Math.min(8192, samples - start);
        const began = performance.now();
        const plan = master.preparePlan(frames);
        const planned = performance.now();
        const stems = await pool.render(frames, plan);
        const synthesized = performance.now();
        const { left, right } = mixStems(stems, frames);
        master.processMix(left, right, plan);
        const mixed = performance.now();
        planMs += planned - began;
        synthMs += synthesized - planned;
        mixMs += mixed - synthesized;
        hash.update(left).update(right);
      }
      const elapsedMs = planMs + synthMs + mixMs;
      process.stdout.write(
        `${JSON.stringify({ type, tracks, seconds, run, planMs: Math.round(planMs), synthMs: Math.round(synthMs), mixMs: Math.round(mixMs), elapsedMs: Math.round(elapsedMs), realtimeFactor: Number(((seconds * 1000) / elapsedMs).toFixed(2)), hash: hash.digest("hex") })}\n`,
      );
    } finally {
      pool.close();
      master.reset();
      Math.random = random;
      resetSynthNoiseTables();
    }
  }
}
