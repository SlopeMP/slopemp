import { readdir, readFile } from "node:fs/promises";

import { chromium } from "@playwright/test";
import type { Browser, CDPSession } from "@playwright/test";

import type { AudioCommand, AudioReply } from "../src/audio";
import { expectAudible, probeOutput } from "../tests/e2e/audio-output";
import { seedStorage } from "../tests/e2e/stored-state";
import { observeTrackWorkers } from "../tests/e2e/track-workers";
import { profilePlaybackSong } from "./profile-playback-song";

// Compare two running builds on Linux. Each JSON line reports one fresh Chromium session.
// Process CPU is in seconds. Thread CPU uses the host's clock ticks (getconf CLK_TCK).
type Consumption = Extract<AudioReply, { type: "consumed" }> & { received: number };
type PlaybackProbe = {
  consumed: Consumption[];
  assignments: string[][];
  sampleRate: number;
  threadRequest: number;
  errors: string[];
};

declare global {
  var slopempPlaybackProbe: PlaybackProbe;
}

const installProbe = (): void => {
  const probe: PlaybackProbe = {
    consumed: [],
    assignments: [],
    sampleRate: 0,
    threadRequest: 0,
    errors: [],
  };
  globalThis.slopempPlaybackProbe = probe;
  class ProfileAudioContext extends AudioContext {
    public constructor() {
      super({ sampleRate: 48_000 });
      probe.sampleRate = this.sampleRate;
    }
  }
  class ProfileWorker extends Worker {
    public constructor(url: URL | string, options?: WorkerOptions) {
      super(url, options);
      if (String(url).endsWith("/audio-worker.js")) {
        this.addEventListener(
          "message",
          ({ data }: MessageEvent<AudioReply | { type: "threads"; assignments: string[][] }>) => {
            switch (data.type) {
              case "threads": {
                probe.assignments = data.assignments;
                break;
              }
              case "consumed": {
                probe.consumed.push({ ...data, received: performance.now() });
                break;
              }
              case "error": {
                probe.errors.push(data.message);
                break;
              }
              case "block":
              case "ready": {
                break;
              }
            }
          },
        );
      }
    }

    public override postMessage(
      command: AudioCommand,
      options: StructuredSerializeOptions | Transferable[] = [],
    ): void {
      if (command.type === "init") {
        probe.threadRequest = command.threadCount;
      }
      super.postMessage(command, Array.isArray(options) ? { transfer: options } : options);
    }
  }
  Reflect.set(globalThis, "AudioContext", ProfileAudioContext);
  Reflect.set(globalThis, "Worker", ProfileWorker);
};

type ThreadTicks = { name: string; ticks: number };
const readThreadTicks = async (pid: number): Promise<Array<[string, ThreadTicks]>> => {
  const records = await Promise.all(
    (await readdir(`/proc/${pid}/task`)).map(async (tid): Promise<[string, ThreadTicks] | null> => {
      try {
        const stat = await readFile(`/proc/${pid}/task/${tid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        // The remaining fields start at Linux stat field 3. CPU ticks are fields 14 and 15.
        const fields = stat.slice(close + 2).split(" ");
        return [
          `${pid}/${tid}`,
          {
            name: stat.slice(stat.indexOf("(") + 1, close),
            ticks: Number(fields[11]) + Number(fields[12]),
          },
        ];
      } catch {
        // Chromium can retire an idle thread between listing and reading its stat file.
        return null;
      }
    }),
  );
  return records.filter((record) => record !== null);
};

type Snapshot = {
  wall: number;
  processInfo: Array<{ type: string; id: number; cpuTime: number }>;
  tasks: Map<string, ThreadTicks>;
};
const snapshot = async (cdp: CDPSession): Promise<Snapshot> => {
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  const renderers = processInfo.filter(({ type }) => type.toLowerCase() === "renderer");
  const tasks = (
    await Promise.all(renderers.map(async ({ id }) => await readThreadTicks(id)))
  ).flat();
  return { wall: performance.now(), processInfo, tasks: new Map(tasks) };
};
type CPUProfile = {
  cpuSecondsByProcessType: Record<string, number>;
  ticksByThreadName: Record<string, { threads: number; ticks: number }>;
};
const summarizeCPU = (start: Snapshot, end: Snapshot): CPUProfile => {
  const startCPU = new Map(start.processInfo.map(({ id, cpuTime }) => [id, cpuTime]));
  const cpuSecondsByProcessType = new Map<string, number>();
  for (const { id, type, cpuTime } of end.processInfo) {
    const delta = cpuTime - (startCPU.get(id) ?? cpuTime);
    cpuSecondsByProcessType.set(type, (cpuSecondsByProcessType.get(type) ?? 0) + delta);
  }
  const ticksByThreadName = new Map<string, { threads: number; ticks: number }>();
  for (const [id, { name, ticks }] of end.tasks) {
    const delta = ticks - (start.tasks.get(id)?.ticks ?? ticks);
    const group = ticksByThreadName.get(name) ?? { threads: 0, ticks: 0 };
    group.threads++;
    group.ticks += delta;
    ticksByThreadName.set(name, group);
  }
  return {
    cpuSecondsByProcessType: Object.fromEntries(cpuSecondsByProcessType),
    ticksByThreadName: Object.fromEntries(
      [...ticksByThreadName].filter(([, group]) => group.ticks > 0),
    ),
  };
};

type Trial = CPUProfile & {
  elapsedMs: number;
  measurementMs: number;
  sampleRate: number;
  trackWorkers: number;
  totalBlocks: number;
  audioSeconds: number;
  gapCount: number;
  gapFrames: number;
  maxGapFrames: number;
};
const warmupMs = Number(process.env["SLOPEMP_PROFILE_WARMUP_MS"] ?? 5000);
const measurementMs = Number(process.env["SLOPEMP_PROFILE_WINDOW_MS"] ?? 12_000);
const profile = async (browser: Browser, url: string): Promise<Trial> => {
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();
  await seedStorage(
    page,
    { preferences: { audioThreads: 16, autoFollow: false, metronome: false, countIn: false } },
    new URL("./__storage_seed__", url).href,
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await observeTrackWorkers(page, "audio-worker");
  await probeOutput(page);
  await page.addInitScript(installProbe);
  await page.goto(url);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => {
    const { assignments } = globalThis.slopempPlaybackProbe;
    return assignments.length === 15 && assignments.every((group) => group.length === 2);
  });
  await expectAudible(page);
  await Bun.sleep(warmupMs);

  const cdp = await browser.newBrowserCDPSession();
  const start = await snapshot(cdp);
  const audioStart = await page.evaluate(() => performance.now());
  await Bun.sleep(measurementMs);
  const audioEnd = await page.evaluate(() => performance.now());
  const end = await snapshot(cdp);
  const probe = await page.evaluate(() => ({
    ...globalThis.slopempPlaybackProbe,
    isolated: crossOriginIsolated,
  }));
  errors.push(...probe.errors);
  if (
    errors.length > 0 ||
    probe.threadRequest !== 16 ||
    !probe.isolated ||
    probe.sampleRate !== 48_000
  ) {
    throw new Error(
      `Invalid playback profile (threads: ${probe.threadRequest}, sample rate: ${probe.sampleRate}, isolated: ${probe.isolated}). ${errors.join(" ")}`,
    );
  }
  const observations = probe.consumed.filter(
    ({ received }) => received >= audioStart && received < audioEnd,
  );
  const [first] = observations;
  const last = observations.at(-1);
  if (!first || !last || observations.length < 2) {
    throw new Error("Playback produced too few blocks to profile.");
  }
  // An uninterrupted 512-frame block completes 512 samples after the previous block.
  const gaps: number[] = [];
  let previous = first;
  for (const block of observations.slice(1)) {
    if (block.id !== previous.id + 1 || block.generation !== previous.generation) {
      throw new Error("Playback changed generation or skipped a block during measurement.");
    }
    const frames = Math.round((block.time - previous.time) * probe.sampleRate) - 512;
    if (frames > 0) {
      gaps.push(frames);
    }
    previous = block;
  }
  return {
    elapsedMs: end.wall - start.wall,
    measurementMs: audioEnd - audioStart,
    sampleRate: probe.sampleRate,
    trackWorkers: probe.assignments.length,
    totalBlocks: observations.length,
    audioSeconds: last.time - first.time,
    gapCount: gaps.length,
    gapFrames: gaps.reduce((total, frames) => total + frames, 0),
    maxGapFrames: Math.max(0, ...gaps),
    ...summarizeCPU(start, end),
  };
};

const [before, after] = process.argv.slice(2);
if (before === undefined || after === undefined || before === "" || after === "") {
  throw new Error("Usage: bun scripts/profile-playback.ts <before URL> <after URL>");
}
if (
  !Number.isFinite(warmupMs) ||
  warmupMs < 0 ||
  !Number.isFinite(measurementMs) ||
  measurementMs <= 0
) {
  throw new RangeError("Invalid playback profile duration.");
}

const song = await profilePlaybackSong();
const urls = { before, after };
const order = ["before", "after", "after", "before", "before", "after", "after", "before"] as const;
for (const variant of order) {
  const url = new URL(urls[variant]);
  url.hash = song;
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling"],
  });
  try {
    const result = await profile(browser, url.href);
    process.stdout.write(`${JSON.stringify({ variant, version: browser.version(), ...result })}\n`);
  } finally {
    await browser.close();
  }
}
