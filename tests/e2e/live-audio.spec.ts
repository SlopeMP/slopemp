import { rm, writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createInstrument, presetInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";
import { denseSoundFontSong } from "../fixtures/dense-soundfont-song";
import { expectAudible, probeOutput } from "./audio-output";
import { seedStorage } from "./stored-state";

// Measure every rendered sample on the audio thread. Analyser polling on the UI
// thread cannot observe a dropout that starts and ends while that thread is busy.
const continuityModule = `audio-continuity-probe-${process.pid}.js`;
const continuityModulePath = new URL(`../../dist/web/${continuityModule}`, import.meta.url);
const probeContinuity = async (page: Page): Promise<void> => {
  await page.addInitScript((module) => {
    const connect: unknown = Reflect.get(AudioNode.prototype, "connect");
    if (typeof connect !== "function") {
      throw new TypeError("Missing audio output API");
    }
    const attached = new WeakSet<AudioNode>();
    Reflect.set(
      AudioNode.prototype,
      "connect",
      new Proxy(connect, {
        apply(target, source: unknown, args: unknown[]): unknown {
          if (
            source instanceof AudioWorkletNode &&
            args[0] instanceof AudioDestinationNode &&
            !attached.has(source)
          ) {
            attached.add(source);
            const { context } = source;
            void context.audioWorklet.addModule(new URL(module, document.baseURI).href).then(() => {
              const probe = new AudioWorkletNode(context, "continuity-probe");
              Reflect.apply(target, source, [probe]);
              // The probe outputs silence, leaving the audible graph unchanged.
              Reflect.apply(target, probe, [context.destination]);
              Reflect.set(globalThis, "audioContinuityProbe", probe);
            });
          }
          return Reflect.apply(target, source, args);
        },
      }),
    );
  }, continuityModule);
};

// Worklet requests bypass Playwright routing. Serve the test-only processor from
// the build directory, using a separate filename for each browser worker.
test.beforeAll(async () => {
  await writeFile(
    continuityModulePath,
    `
        class ContinuityProbe extends AudioWorkletProcessor {
          frames = 0;
          silent = 0;
          longestSilence = 0;
          longestSilenceAt = 0;
          audible = false;
          invalid = false;
          constructor() {
            super();
            this.port.onmessage = ({ data }) => {
              if (data === "start") {
                this.frames = this.silent = this.longestSilence = 0;
                this.longestSilenceAt = 0;
                this.audible = this.invalid = false;
              }
              this.port.postMessage({
                frames: this.frames,
                longestSilence: this.longestSilence,
                longestSilenceAt: this.longestSilenceAt,
                audible: this.audible,
                invalid: this.invalid,
              });
            };
          }
          process(inputs) {
            const channels = inputs[0] || [];
            const length = channels[0]?.length || 128;
            for (let frame = 0; frame < length; frame++) {
              let level = 0;
              for (const channel of channels) {
                const value = channel[frame];
                if (!Number.isFinite(value)) this.invalid = true;
                level = Math.max(level, Math.abs(value));
              }
              if (level > 1e-8) {
                this.audible = true;
                this.silent = 0;
              } else {
                this.silent++;
                if (this.silent > this.longestSilence) {
                  this.longestSilence = this.silent;
                  this.longestSilenceAt = this.frames + frame;
                }
              }
            }
            this.frames += length;
            return true;
          }
        }
        registerProcessor("continuity-probe", ContinuityProbe);
    `,
  );
});
test.afterAll(async () => {
  await rm(continuityModulePath, { force: true });
});
type ContinuityStats = {
  frames: number;
  longestSilence: number;
  audible: boolean;
  invalid: boolean;
};
const continuity = async (page: Page, command: "report" | "start"): Promise<ContinuityStats> =>
  await page.evaluate(async (message) => {
    const probe: unknown = Reflect.get(globalThis, "audioContinuityProbe");
    if (!(probe instanceof AudioWorkletNode)) {
      throw new TypeError("Missing audio continuity probe");
    }
    const result = new Promise<ContinuityStats>((resolve) => {
      probe.port.addEventListener(
        "message",
        (event: MessageEvent<ContinuityStats>) => {
          resolve(event.data);
        },
        { once: true },
      );
    });
    probe.port.start();
    probe.port.postMessage(message, []);
    return await result;
  }, command);

for (const { tracks, audioThreads } of [
  { tracks: 8, audioThreads: 1 },
  { tracks: 32, audioThreads: 8 },
]) {
  test(`${tracks * 2} simultaneous SoundFont instruments play without audio gaps on ${audioThreads} audio threads`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await seedStorage(page, { preferences: { audioThreads } });
    await probeContinuity(page);
    await page.route("**/test-assets/dense.sf2", async (route) => {
      await route.fulfill({
        path: new URL("../assets/florestan-subset.sf2", import.meta.url).pathname,
      });
    });
    await page.goto(`./#${encodeSong(denseSoundFontSong(tracks))}`);
    await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Add Assets");
    const assets = page.getByRole("dialog", { name: "Add Assets", exact: true });
    await expect(assets.getByText("Ready", { exact: true })).toHaveCount(1);
    await assets.getByRole("button", { name: "Okay", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(async () => await page.evaluate(() => Reflect.has(globalThis, "audioContinuityProbe")))
      .toBe(true);
    await expect.poll(async () => (await continuity(page, "report")).audible).toBe(true);
    // Include cold voices, repeated chord starts, release tails and a loop boundary.
    await continuity(page, "start");
    await page.evaluate(() => {
      const until = performance.now() + 200;
      while (performance.now() < until) {
        // Playback must keep running while the editor thread is occupied.
      }
    });
    await page.waitForTimeout(1000);
    const volume = page
      .getByRole("region", { name: "Instrument Settings", exact: true })
      .getByRole("spinbutton", { name: "Volume %", exact: true });
    await volume.fill("4");
    await volume.press("Enter");
    await expect(volume).toHaveValue("4");
    await page.waitForTimeout(2600);
    const output = await continuity(page, "report");
    expect(output.frames).toBeGreaterThan(100_000);
    expect(output.audible).toBe(true);
    expect(output.invalid).toBe(false);
    expect(output.longestSilence, JSON.stringify(output)).toBeLessThan(128);
    expect(errors).toEqual([]);
  });
}

for (const native of [false, true]) {
  test(`${native ? "native" : "custom"} playback has no audio gaps during edits and a blocked UI thread`, async ({
    page,
  }) => {
    await probeContinuity(page);
    const song = createSong();
    song.beatsPerBar = 16;
    const channel = required(song.channels[0]);
    song.channels = [channel];
    const instrument = createInstrument(native ? "chip wave" : "FM (n-op)");
    instrument.attack = 0;
    instrument.volume = 0.5;
    channel.instruments = [instrument];
    channel.cells.fill(1);
    required(channel.patterns[1]).notes = [createNote(0, song.beatsPerBar, 48)];
    await page.goto(`./#${encodeSong(song)}`);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(async () => await page.evaluate(() => Reflect.has(globalThis, "audioContinuityProbe")))
      .toBe(true);
    await expect.poll(async () => (await continuity(page, "report")).audible).toBe(true);
    await continuity(page, "start");
    const volume = page
      .getByRole("region", { name: "Instrument Settings", exact: true })
      .getByRole("spinbutton", { name: "Volume %", exact: true });
    for (const value of ["60", "80", "70"]) {
      await volume.fill(value);
      await volume.press("Enter");
      await expect(volume).toHaveValue(value);
    }
    await page.evaluate(() => {
      const until = performance.now() + 200;
      while (performance.now() < until) {
        // Exercise the same thread starvation as expensive edits and rendering.
      }
    });
    const output = await continuity(page, "report");
    expect(output.frames).toBeGreaterThan(8000);
    expect(output.audible).toBe(true);
    expect(output.invalid).toBe(false);
    // A sustained note may cross zero; a silent render quantum is an underrun.
    expect(output.longestSilence).toBeLessThan(128);
  });
}

for (const native of [false, true]) {
  test(`${native ? "native" : "custom"} audio stays audible after loop drags and repeated live instrument edits with 100 channels`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await probeOutput(page);
    const song = createSong();
    song.tempo = 300;
    song.beatsPerBar = 4;
    song.barCount = 4;
    song.loopEnd = 4;
    song.channels = Array.from({ length: 100 }, () => createChannel("track", 4, song.patternCount));
    const channel = required(song.channels[0]);
    channel.cells.fill(1);
    channel.instruments = [
      native ? presetInstrument("square lead") : createInstrument("chip wave"),
    ];
    required(channel.patterns[1]).notes = [createNote(0, 4, 48)];
    await page.goto(`./#${encodeSong(song)}`);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expectAudible(page);
    const strip = page.getByRole("slider", { name: "Loop region", exact: true });
    await strip.scrollIntoViewIfNeeded();
    const bounds = required(await strip.boundingBox());
    await page.mouse.move(bounds.x + 3.5 * 32, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 1.5 * 32, bounds.y + bounds.height / 2, { steps: 12 });
    await page.mouse.up();
    await expectAudible(page);
    const panel = page.getByRole("region", { name: "Instrument Settings", exact: true });
    const volume = panel.getByRole("spinbutton", { name: "Volume %", exact: true });
    for (const value of ["60", "80", "70"]) {
      await volume.fill(value);
      await volume.press("Enter");
      await expect(volume).toHaveValue(value);
      await expectAudible(page);
    }
    // Wait beyond several note/loop boundaries: future notes must also remain valid.
    await page.waitForTimeout(1800);
    await expectAudible(page);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const saved = decodeSong(await page.evaluate(() => location.hash));
    expect(saved.channels).toHaveLength(100);
    expect(required(required(saved.channels[0]).instruments[0]).volume).toBe(0.7);
    expect(saved.loopEnd).toBeLessThan(4);
    await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Undo");
    await expect(volume).toHaveValue("80");
    await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Redo");
    await expect(volume).toHaveValue("70");
    expect(errors).toEqual([]);
  });
}

test("obsolete commands and export formats are absent", async ({ page }) => {
  await page.goto("./");
  for (const value of ["Recover Recent Song", "Insert Track", "Paste Pattern Numbers"]) {
    await expect(page.locator(`option[value="${value}"]`)).toHaveCount(0);
  }
  await page.getByRole("combobox", { name: "File menu", exact: true }).selectOption("Export Song");
  await expect(
    page.getByRole("combobox", { name: "File Type", exact: true }).locator("option"),
  ).toHaveText([".wav", ".mp3", ".mid", ".slopemp (editable song)"]);
});
