import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { SongRenderer } from "../../src/audio";
import { exportSequence } from "../../src/formats";
import { createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";
import type { Song } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";
import { expectAudible, probeOutput } from "./audio-output";
import { seedStorage } from "./stored-state";
import { observeTrackWorkers } from "./track-workers";

type Probe = {
  progress: number[];
  count: number;
  assignments: string[][];
  complete: boolean;
  terminated: boolean;
  heartbeats: number;
};
const observeExport = async (page: Page, disableDevice = true): Promise<void> => {
  await seedStorage(page, {
    preferences: { audioThreads: 3, listeningVolume: disableDevice ? 0 : 50 },
  });
  await observeTrackWorkers(page, "audio-export-worker");
  await page.addInitScript((blockAudioDevice) => {
    if (blockAudioDevice) {
      Reflect.set(
        globalThis,
        "AudioContext",
        class {
          public constructor() {
            throw new Error("Offline export must not open an audio device.");
          }
        },
      );
    }
    const BrowserWorker = Worker;
    class ObservedWorker extends BrowserWorker {
      private readonly probe: Probe | null;
      private readonly heartbeat: ReturnType<typeof setInterval> | null;
      public constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options);
        this.probe = String(url).includes("audio-export-worker.js")
          ? {
              progress: [],
              count: 0,
              assignments: [],
              complete: false,
              terminated: false,
              heartbeats: 0,
            }
          : null;
        const { probe } = this;
        this.heartbeat = probe
          ? setInterval(() => {
              probe.heartbeats++;
            }, 10)
          : null;
        if (probe) {
          Reflect.set(globalThis, "exportProbe", probe);
          this.addEventListener(
            "message",
            (
              event: MessageEvent<{
                type: string;
                progress?: number;
                count?: number;
                assignments?: string[][];
              }>,
            ) => {
              const { data } = event;
              if (data.type === "progress" && data.progress !== undefined) {
                probe.progress.push(data.progress);
              } else if (data.type === "threads" && (data.count ?? 0) >= probe.count) {
                probe.count = data.count ?? 0;
                probe.assignments = data.assignments ?? [];
              } else if (data.type === "complete") {
                probe.complete = true;
              }
            },
          );
        }
      }
      public override terminate(): void {
        if (this.probe) {
          this.probe.terminated = true;
        }
        if (this.heartbeat !== null) {
          clearInterval(this.heartbeat);
        }
        super.terminate();
      }
    }
    Reflect.set(globalThis, "Worker", ObservedWorker);
  }, disableDevice);
};
const fixture = (): Song => {
  const song = createSong();
  song.resources = [];
  song.barCount = 3;
  song.loopStart = 1;
  song.loopEnd = 2;
  song.beatsPerBar = 2;
  song.tempo = 240;
  song.channels = Array.from({ length: 4 }, (_unused, index) => {
    const channel = createChannel("track", song.barCount, song.patternCount);
    channel.cells = [1, 2, 3];
    const instrument = createInstrument(index === 0 ? "chip wave" : "Custom chip wave");
    instrument.volume = 0.15;
    channel.instruments = [instrument];
    for (let pattern = 1; pattern <= 3; pattern++) {
      required(channel.patterns[pattern]).notes = [createNote(0, 2, 45 + index * 3 + pattern)];
    }
    return channel;
  });
  return song;
};
const probe = async (page: Page): Promise<Probe> =>
  await page.evaluate(() => {
    const value: unknown = Reflect.get(globalThis, "exportProbe");
    if (typeof value !== "object" || value === null || !("progress" in value)) {
      return {
        progress: [],
        count: 0,
        assignments: [],
        complete: false,
        terminated: false,
        heartbeats: 0,
      };
    }
    const progress: unknown[] = Array.isArray(value.progress) ? value.progress : [];
    const assignments: string[][] = [];
    if ("assignments" in value && Array.isArray(value.assignments)) {
      const groups: unknown[] = value.assignments;
      for (const group of groups) {
        if (Array.isArray(group)) {
          const ids: unknown[] = group;
          assignments.push(ids.filter((id): id is string => typeof id === "string"));
        }
      }
    }
    return {
      progress: progress.filter((item): item is number => typeof item === "number"),
      assignments,
      count: "count" in value ? Number(value.count) : 0,
      complete: "complete" in value && value.complete === true,
      terminated: "terminated" in value && value.terminated === true,
      heartbeats: "heartbeats" in value ? Number(value.heartbeats) : 0,
    };
  });

for (const format of ["wav", "mp3"]) {
  test(`${format} export preserves the edited song and ${format === "wav" ? "resumes audible playback" : "works without an audio device"}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await observeExport(page, format !== "wav");
    if (format === "wav") {
      await probeOutput(page);
    }
    const song = fixture();
    await page.goto(`./#${encodeSong(song)}`);
    const volume = page
      .getByRole("region", { name: "Instrument Settings", exact: true })
      .getByRole("spinbutton", { name: "Volume %", exact: true });
    await volume.fill("30");
    await volume.press("Enter");
    await expect(volume).toHaveValue("30");
    required(required(song.channels[0]).instruments[0]).volume = 0.3;
    await expect
      .poll(async () => decodeSong(await page.evaluate(() => location.hash)))
      .toEqual(song);
    const before = structuredClone(song);
    if (format === "wav") {
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expectAudible(page);
      await expect(page.locator(".speaker span")).not.toHaveText("1:1");
    }
    await page
      .getByRole("combobox", { name: "File menu", exact: true })
      .selectOption("Export Song");
    const dialog = page.getByRole("dialog", { name: "Export Options", exact: true });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    const pausedAt = await page.locator(".speaker span").textContent();
    await dialog.getByRole("textbox", { name: "File name", exact: true }).fill("Edited loop");
    await dialog.getByRole("combobox", { name: "File Type", exact: true }).selectOption(format);
    await page.getByRole("checkbox", { name: "Intro", exact: true }).check();
    await page.getByRole("checkbox", { name: "Outro", exact: true }).check();
    await page.getByRole("spinbutton", { name: "Loop Count", exact: true }).fill("2");
    await page.getByRole("spinbutton", { name: "Loop Count", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save File", exact: true })).toBeEnabled();
    await expect(
      dialog.getByRole("progressbar", { name: "Audio generation", exact: true }),
    ).toBeHidden();
    expect(await page.locator(".speaker span").textContent()).toBe(pausedAt);
    if (format === "wav") {
      expect(
        await page.evaluate(() => {
          const context: unknown = Reflect.get(globalThis, "audioOutputContext");
          return context instanceof AudioContext && context.state;
        }),
      ).toBe("closed");
    }
    const observed = await probe(page);
    expect(observed.count).toBe(3);
    expect(observed.assignments.filter((group) => group.length > 0)).toHaveLength(2);
    expect(observed.assignments.flat().sort()).toEqual(
      song.channels.map((channel) => channel.id).sort(),
    );
    expect(observed.complete).toBe(true);
    expect(observed.terminated).toBe(true);
    expect(observed.heartbeats).toBeGreaterThan(0);
    expect(observed.progress[0]).toBe(0);
    expect(observed.progress.at(-1)).toBe(1);
    expect(
      observed.progress.every(
        (value, index, values) => index === 0 || value >= (values[index - 1] ?? 0),
      ),
    ).toBe(true);
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save File", exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(`Edited loop.${format}`);
    const bytes = await readFile(await download.path());
    await expect(dialog).toBeHidden();
    if (format === "wav") {
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      await expect
        .poll(
          async () =>
            await page.evaluate(() => Number(Reflect.get(globalThis, "audioOutputGeneration"))),
        )
        .toBe(2);
      await expectAudible(page);
      const resumedAt = await page.locator(".speaker span").textContent();
      await expect(page.locator(".speaker span")).not.toHaveText(resumedAt ?? "");
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      expect(bytes.readUInt16LE(22)).toBe(2);
      expect(bytes.readUInt32LE(24)).toBe(44_100);
      const renderer = new SongRenderer(
        before,
        44_100,
        0,
        exportSequence(before, { intro: true, outro: true, loopCount: 2 }),
      );
      let frame = 0;
      let difference = 0;
      let peak = 0;
      while (renderer.playing) {
        const pair = renderer.sample();
        for (let channel = 0; channel < 2; channel++) {
          const value = Math.max(-1, Math.min(1, pair[channel] ?? 0));
          const pcm = Math.round(value * (value < 0 ? 32_768 : 32_767));
          peak = Math.max(peak, Math.abs(bytes.readInt16LE(44 + frame * 4 + channel * 2)));
          difference = Math.max(
            difference,
            Math.abs(pcm - bytes.readInt16LE(44 + frame * 4 + channel * 2)),
          );
        }
        frame++;
      }
      expect(bytes.length).toBe(44 + frame * 4);
      expect(difference).toBeLessThanOrEqual(2);
      expect(peak).toBeGreaterThan(128);
    } else {
      await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
      expect(bytes[0]).toBe(255);
      expect((bytes[1] ?? 0) & 224).toBe(224);
      expect(bytes.length).toBeGreaterThan(1000);
    }
    expect(decodeSong(await page.evaluate(() => location.hash))).toEqual(before);
    expect(errors).toEqual([]);
  });
}

test("cancelling accelerated synthesis terminates export and leaves the editor usable", async ({
  page,
}) => {
  await observeExport(page);
  const song = fixture();
  song.barCount = 64;
  song.loopStart = 0;
  song.loopEnd = 64;
  song.beatsPerBar = 16;
  song.tempo = 30;
  for (const channel of song.channels) {
    channel.cells = Array.from({ length: 64 }, () => 1);
    channel.instruments = [createInstrument("FM (n-op)")];
    required(channel.patterns[1]).notes = [createNote(0, 16, [48, 52, 55, 60])];
  }
  await page.goto(`./#${encodeSong(song)}`);
  await page.getByRole("combobox", { name: "File menu", exact: true }).selectOption("Export Song");
  await page.getByRole("combobox", { name: "File Type", exact: true }).selectOption("wav");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect.poll(async () => (await probe(page)).progress.some((value) => value > 0)).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const observed = await probe(page);
  expect(observed.terminated).toBe(true);
  expect(observed.complete).toBe(false);
  await expect(page.getByText(/Export failed:/u)).not.toBeVisible();
  expect(decodeSong(await page.evaluate(() => location.hash))).toEqual(song);
  await page.getByRole("spinbutton", { name: "Tempo", exact: true }).fill("120");
  await page.getByRole("spinbutton", { name: "Tempo", exact: true }).press("Enter");
  await expect(page.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue("120");
  song.tempo = 120;
  await expect.poll(async () => decodeSong(await page.evaluate(() => location.hash))).toEqual(song);
});
