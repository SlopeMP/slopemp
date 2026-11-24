import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { envelopeTargets } from "../../src/instrument-envelopes";
import { createInstrument, validateInstrument } from "../../src/instruments";
import type { Instrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import type { Song } from "../../src/model";
import { assetType } from "../../src/resource-identity";
import { decodeSong, encodeSong } from "../../src/storage";
import { TEST_RESOURCES } from "../assets/resources";

const saved = async (page: Page): Promise<Song> =>
  decodeSong(await page.evaluate(() => location.hash.slice(1)));
const firstInstrument = (song: Song): Instrument =>
  required(required(song.channels[0]).instruments[0]);
const seedRandom = async (page: Page, first: number, seed = 151): Promise<void> => {
  await page.evaluate(
    ({ initial, state: initialState }) => {
      let state = initialState;
      let firstCall = true;
      Math.random = (): number => {
        if (firstCall) {
          firstCall = false;
          return initial;
        }
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 4_294_967_296;
      };
    },
    { initial: first, state: seed },
  );
};
const expectGenerated = (instrument: Instrument, previous: Instrument): void => {
  expect(validateInstrument(instrument)).toBe(true);
  expect(instrument.id).toBe(previous.id);
  expect(instrument.volume).toBe(previous.volume);
  expect(instrument.effects.length).toBeGreaterThan(0);
  expect(instrument.envelopes.length).toBeGreaterThan(0);
  expect(instrument.effects.every((effect) => effect.enabled)).toBe(true);
  const targets = new Set(envelopeTargets(instrument).map((target) => target.value));
  for (const envelope of instrument.envelopes) {
    expect(envelope).toMatchObject({ timeBasis: "beats", clock: "song synchronized" });
    expect(envelope.enabled).toBe(true);
    expect(envelope.type).not.toBe("None");
    expect(targets.has(envelope.target)).toBe(true);
  }
};
const samples = TEST_RESOURCES.filter(({ url }) => assetType(url) === "audio");
const fixture = (): Song => {
  const song = createSong();
  song.resources.push(...samples);
  const channel = required(song.channels[0]);
  const instrument = createInstrument();
  instrument.volume = 0.37;
  channel.instruments = [instrument];
  required(channel.patterns[1]).notes = [createNote(0, 1, 48)];
  return song;
};

test.beforeEach(async ({ page }) => {
  for (const sample of samples) {
    await page.route(`**/${sample.url.slice(2)}`, async (route) => {
      await route.fulfill({
        path: new URL(`../assets/${sample.url.split("/").at(-1)}`, import.meta.url).pathname,
      });
    });
  }
});

test("Random Generated chooses bundled SoundFont presets and retains mix, notes and routing", async ({
  page,
}) => {
  const song = fixture();
  await page.goto(`./#${encodeSong(song)}`);
  await page.locator(".instrument-panel .type-button").click();
  const dialog = page.getByRole("dialog", { name: "Choose instrument type" });
  const bundledFont = dialog.getByRole("region", { name: "fluid-r3-mono", exact: true });
  await expect(bundledFont.getByRole("button").first()).toBeVisible();
  await seedRandom(page, 0.999);
  await dialog.getByRole("button", { name: "Random Generated", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => firstInstrument(await saved(page)).type).toBe("SoundFont");
  const generatedSong = await saved(page);
  const instrument = firstInstrument(generatedSong);
  expectGenerated(instrument, firstInstrument(song));
  expect(instrument.resourceId).toBe("bundled-fluid-r3-mono");
  expect(required(generatedSong.channels[0]).patterns).toEqual(required(song.channels[0]).patterns);
  const preset = page.getByRole("combobox", { name: "Instrument", exact: true });
  const program = `${instrument.bank}:${instrument.program}`;
  await expect(preset).toHaveValue(program);
  await expect(page.getByRole("combobox", { name: "SoundFont", exact: true })).toHaveValue(
    instrument.resourceId,
  );
  await expect(page.getByRole("spinbutton", { name: "Volume %", exact: true })).toHaveValue("37");
  await page.reload();
  expect(firstInstrument(await saved(page))).toEqual(instrument);
  await expect(preset).toHaveValue(program);
});

test("Shift+R can generate chip sample instruments with the resource's playback settings", async ({
  page,
}) => {
  const song = fixture();
  await page.goto(`./#${encodeSong(song)}`);
  const wave = page.getByRole("combobox", { name: "Wave", exact: true });
  for (const sample of samples) {
    await expect(wave.locator(`option[value="sample:${sample.id}"]`)).toBeEnabled();
  }
  await page.locator("main.editor").focus();
  let instrument = firstInstrument(song);
  for (let seed = 1; seed <= 64; seed++) {
    const previousHash = await page.evaluate(() => location.hash);
    await seedRandom(page, 0, seed);
    await page.keyboard.press("Shift+R");
    await expect.poll(async () => await page.evaluate(() => location.hash)).not.toBe(previousHash);
    instrument = firstInstrument(await saved(page));
    if (instrument.resourceId) {
      break;
    }
  }
  expectGenerated(instrument, firstInstrument(song));
  expect(instrument.type).toBe("chip wave");
  const sample = required(song.resources.find((resource) => resource.id === instrument.resourceId));
  expect(assetType(sample.url)).toBe("audio");
  expect(instrument.rootKey).toBe(sample.rootKey);
  expect(instrument.sampleStart).toBe(sample.start);
  expect(instrument.loopStart).toBe(sample.loopStart);
  expect(instrument.loopEnd).toBe(sample.loopEnd);
  expect(instrument.loopMode).toBe(sample.mode);
  expect(instrument.backwards).toBe(sample.backwards);
  await expect(page.getByRole("combobox", { name: "Wave", exact: true })).toHaveValue(
    `sample:${sample.id}`,
  );
  expect(required((await saved(page)).channels[0]).patterns).toEqual(
    required(song.channels[0]).patterns,
  );
});

test("repeated random presets keep the SoundFont instrument selection in sync", async ({
  page,
}) => {
  await page.goto(`./#${encodeSong(fixture())}`);
  await page.locator(".instrument-panel .type-button").click();
  const dialog = page.getByRole("dialog", { name: "Choose instrument type" });
  await expect(
    dialog.getByRole("region", { name: "fluid-r3-mono", exact: true }).getByRole("button").first(),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Random Preset", exact: true }).click();
  for (const value of [0.999, 0.8, 0.999, 0.9]) {
    await seedRandom(page, value);
    await page.locator("main.editor").focus();
    await page.keyboard.press("r");
    const instrument = firstInstrument(await saved(page));
    if (instrument.type === "SoundFont") {
      await expect(page.getByRole("combobox", { name: "Instrument", exact: true })).toHaveValue(
        `${instrument.bank}:${instrument.program}`,
      );
    }
  }
});
