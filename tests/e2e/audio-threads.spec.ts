import { expect, test } from "@playwright/test";

import type { AudioCommand } from "../../src/audio";
import type { AudioTrackCommand } from "../../src/audio-thread-pool";
import { createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";
import { encodeSong } from "../../src/storage";
import { expectAudible, probeOutput } from "./audio-output";
import { readStoredPreferences, seedStorage } from "./stored-state";
import { observeTrackWorkers } from "./track-workers";

type ThreadReport = { type: "threads"; count: number; assignments: string[][] };

test("adding a track shares used SoundFonts and excludes unused fonts from audio workers", async ({
  page,
}) => {
  await seedStorage(page, { preferences: { audioThreads: 3 } });
  await probeOutput(page);
  const observe = (): void => {
    const loaded = new Map<string, boolean>();
    addEventListener("message", (event: MessageEvent<AudioCommand>) => {
      if (event.data.type === "resource" && event.data.update.type === "soundfont") {
        loaded.set(
          event.data.update.id,
          event.data.update.font.samples.buffer instanceof SharedArrayBuffer,
        );
      }
    });
    class ObservedTrackWorker extends Worker {
      public override postMessage(
        command: AudioTrackCommand,
        options: StructuredSerializeOptions | Transferable[] = [],
      ): void {
        if (command.type === "init") {
          postMessage({
            type: "track-resources",
            resources: command.resources.map((update) => update.id),
            loaded: [...loaded.keys()],
            shared:
              [...loaded.values()].every(Boolean) &&
              command.resources.every(
                (update) =>
                  update.type !== "soundfont" ||
                  update.font.samples.buffer instanceof SharedArrayBuffer,
              ),
          });
        }
        super.postMessage(command, Array.isArray(options) ? { transfer: options } : options);
      }
    }
    Reflect.set(globalThis, "Worker", ObservedTrackWorker);
  };
  await page.route("**/audio-worker.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `(${observe.toString()})();\n${await response.text()}` });
  });
  await page.addInitScript(() => {
    const reports: Array<{ resources: string[]; loaded: string[]; shared: boolean }> = [];
    Reflect.set(globalThis, "trackResourceReports", reports);
    class ObservedWorker extends Worker {
      public constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener(
          "message",
          (
            event: MessageEvent<{
              type: string;
              resources: string[];
              loaded: string[];
              shared: boolean;
            }>,
          ) => {
            if (event.data.type === "track-resources") {
              reports.push({
                resources: event.data.resources,
                loaded: event.data.loaded,
                shared: event.data.shared,
              });
            }
          },
        );
      }
    }
    Reflect.set(globalThis, "Worker", ObservedWorker);
  });
  await page.route("**/test-assets/*.sf2", async (route) => {
    await route.fulfill({
      path: new URL("../assets/florestan-subset.sf2", import.meta.url).pathname,
    });
  });
  const song = createSong();
  song.resources = Array.from({ length: 8 }, (_unused, index) => ({
    id: `unused-font-${index}`,
    url: `./test-assets/unused-${index}.sf2`,
  }));
  song.resources.unshift({ id: "used-font", url: "./test-assets/used.sf2" });
  const channel = required(song.channels[0]);
  song.channels = [channel];
  const font = createInstrument("SoundFont");
  font.resourceId = "used-font";
  font.program = 2;
  channel.instruments = [createInstrument("Custom chip wave"), font];
  channel.cells.fill(1);
  required(channel.patterns[1]).notes = [createNote(0, song.beatsPerBar, 48)];
  await page.goto(`./#${encodeSong(song)}`);
  await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Add Assets");
  const assets = page.getByRole("dialog", { name: "Add Assets", exact: true });
  await expect(assets.getByText("Ready", { exact: true })).toHaveCount(9);
  await assets.getByRole("button", { name: "Okay", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expectAudible(page);
  await page.getByRole("spinbutton", { name: "Tracks", exact: true }).fill("2");
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const reports: unknown = Reflect.get(globalThis, "trackResourceReports");
          return reports;
        }),
    )
    .toEqual([
      {
        resources: ["used-font"],
        loaded: ["used-font"],
        shared: true,
      },
      {
        resources: [],
        loaded: ["used-font"],
        shared: true,
      },
    ]);
  await expectAudible(page);
  const position = await page.locator(".speaker span").textContent();
  await expect(page.locator(".speaker span")).not.toHaveText(position ?? "");
});

test("audio thread limits apply during playback and persist locally without editing the song", async ({
  page,
}) => {
  await observeTrackWorkers(page, "audio-worker");
  await page.addInitScript(() => {
    const BrowserWorker = Worker;
    class ObservedWorker extends BrowserWorker {
      public constructor(scriptURL: URL | string, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener(
          "message",
          (
            event: MessageEvent<ThreadReport | { type: "block" | "consumed" | "error" | "ready" }>,
          ) => {
            if (event.data.type === "threads") {
              Reflect.set(globalThis, "audioThreadCount", event.data.count);
              Reflect.set(globalThis, "audioThreadAssignments", event.data.assignments);
            }
          },
        );
      }
    }
    Reflect.set(globalThis, "Worker", ObservedWorker);
  });
  const song = createSong();
  song.channels = Array.from({ length: 6 }, (_unused, index) => {
    const channel = createChannel("track", song.barCount, song.patternCount);
    const instrument = createInstrument("Custom chip wave");
    instrument.volume = 0.1;
    channel.instruments = [instrument];
    channel.cells.fill(1);
    required(channel.patterns[1]).notes = [createNote(0, song.beatsPerBar, 48 + index)];
    return channel;
  });
  await page.goto(`./#${encodeSong(song)}`);
  await expect.poll(async () => await page.evaluate(() => location.hash.length)).toBeGreaterThan(1);
  const songURL = await page.evaluate(() => location.hash);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  const threads = page.getByRole("spinbutton", { name: "Audio Threads", exact: true });
  await expect(threads).toHaveAttribute("min", "1");
  await expect(threads).toHaveAttribute("max", "16");
  for (const value of ["1", "3", "2"]) {
    await threads.fill(value);
    await expect(threads).toHaveValue(value);
    await expect
      .poll(
        async () => await page.evaluate(() => Number(Reflect.get(globalThis, "audioThreadCount"))),
      )
      .toBe(Number(value));
    if (value === "3") {
      const assignments = async (): Promise<string[][]> =>
        await page.evaluate(() => {
          const groups: unknown = Reflect.get(globalThis, "audioThreadAssignments");
          if (!Array.isArray(groups)) {
            throw new TypeError("Missing worker assignments");
          }
          const result: string[][] = [];
          const entries: unknown[] = groups;
          for (const entry of entries) {
            if (!Array.isArray(entry)) {
              throw new TypeError("Invalid worker assignment");
            }
            const ids: unknown[] = entry;
            result.push(ids.filter((id): id is string => typeof id === "string"));
          }
          return result;
        });
      await expect
        .poll(async () => (await assignments()).flat().sort())
        .toEqual(song.channels.map((channel) => channel.id).sort());
      expect(
        (await assignments()).filter((group) => group.length > 0).length,
      ).toBeGreaterThanOrEqual(2);
    }
    await expect
      .poll(async () => await readStoredPreferences(page))
      .toMatchObject({ audioThreads: Number(value) });
  }
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const position = await page.locator(".speaker span").textContent();
  await expect(page.locator(".speaker span")).not.toHaveText(position ?? "");
  expect(await page.evaluate(() => location.hash)).toBe(songURL);
  await page.reload();
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(threads).toHaveValue("2");
  expect(await page.evaluate(() => location.hash)).toBe(songURL);
});
