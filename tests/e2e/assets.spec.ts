import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import type { Resource } from "../../src/model";
import { assetName } from "../../src/resource-identity";
import { decodeSong, serializeSongBytes } from "../../src/storage";
import { TEST_RESOURCES } from "../assets/resources";
import { deleteStoredState } from "./stored-state";

const assets = [
  {
    path: "test-assets/piano-C4.wav",
    hash: "69845de40a38ed6501746520f9f385ae56200a4372faed48178e64a32a75e58c",
    bytes: 2_613_976,
  },
  {
    path: "test-assets/flute-C4.wav",
    hash: "e88a0ff35e6b8c29fd88bc778a4c817d955b2c3a2934def97a7d093b72e2ae97",
    bytes: 2_009_832,
  },
  {
    path: "test-assets/florestan-subset.sf2",
    hash: "1d890349a4bf0ae8d932000f0157633c03b81e127e479e069238ff382db44a32",
    bytes: 531_786,
  },
];
const command = async (page: Page, menu: "Edit" | "File", action: string): Promise<void> => {
  await page.getByRole("combobox", { name: `${menu} menu`, exact: true }).selectOption(action);
};
const importShortSong = async (page: Page, type: string): Promise<void> => {
  const song = createSong();
  song.resources.push(...TEST_RESOURCES);
  song.tempo = 300;
  song.beatsPerBar = 1;
  song.barCount = 1;
  song.loopStart = 0;
  song.loopEnd = 1;
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  channel.cells = [1];
  channel.instruments = [createInstrument(type)];
  required(channel.patterns[1]).notes = [createNote(0, 1, 48)];
  await command(page, "File", "Import Song");
  await page.getByLabel("Song file").setInputFiles({
    name: "fixture.slopemp",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(serializeSongBytes(song)),
  });
  await expect(page.getByTestId("note")).toHaveCount(1);
};
const exportAudio = async (page: Page): Promise<Buffer> => {
  await command(page, "File", "Export Song");
  await page.getByRole("combobox", { name: "File Type", exact: true }).selectOption("wav");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const save = page.getByRole("button", { name: "Save File", exact: true });
  await expect(save).toBeEnabled({ timeout: 15_000 });
  const waiting = page.waitForEvent("download");
  await save.click();
  const download = await waiting;
  const path = await download.path();
  return await readFile(path);
};
const expectAudibleStereo = (buffer: Buffer): void => {
  expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
  expect(buffer.toString("ascii", 8, 12)).toBe("WAVE");
  expect(buffer.readUInt16LE(22)).toBe(2);
  expect(buffer.readUInt32LE(24)).toBe(44_100);
  expect(buffer.readUInt32LE(40)).toBeGreaterThan(0);
  let energy = 0;
  for (let offset = 44; offset < buffer.length; offset += 2) {
    energy += (buffer.readInt16LE(offset) / 32_768) ** 2;
  }
  expect(Math.sqrt(energy / ((buffer.length - 44) / 2))).toBeGreaterThan(0.0001);
};

test.beforeEach(async ({ page }) => {
  for (const asset of assets) {
    await page.route(`**/${asset.path}`, async (route) => {
      await route.fulfill({
        path: new URL(`../assets/${asset.path.split("/").at(-1)}`, import.meta.url).pathname,
      });
    });
  }
});

test("production excludes test assets from its catalog and hosting", async ({ page, request }) => {
  await page.goto("./");
  for (const asset of assets) {
    expect((await request.get(asset.path.replace("test-assets/", "assets/"))).status()).toBe(404);
  }
  for (const resource of TEST_RESOURCES) {
    await expect(
      page.getByRole("option", { name: assetName(resource.url), exact: true }),
    ).toHaveCount(0);
  }
});

test("favorite assets persist independently and are copied into new songs", async ({ page }) => {
  await page.goto("./");
  await importShortSong(page, "chip wave");
  const piano = required(TEST_RESOURCES[0]);
  const flute = required(TEST_RESOURCES[1]);
  const songAsset = (url: string): Resource | undefined =>
    decodeSong(new URL(page.url()).hash).resources.find((asset) => asset.url === url);
  const addAssets = page.getByRole("dialog", { name: "Add Assets", exact: true });
  const favorites = page.getByRole("dialog", { name: "View Favorites", exact: true });
  const viewFavorites = addAssets.getByRole("button", { name: "View Favorites", exact: true });
  const back = favorites.getByRole("button", { name: "Back to Add Assets", exact: true });
  const star = (name: string): Locator =>
    addAssets.getByRole("button", { name: `Favorite ${name}`, exact: true });
  const editFavorite = (name: string): Locator =>
    favorites.getByRole("button", { name: `Edit ${name}`, exact: true });

  await command(page, "Edit", "Add Assets");
  await star("piano-C4").click();
  await expect(star("piano-C4")).toHaveAttribute("aria-pressed", "true");
  await star("piano-C4").click();
  await expect(star("piano-C4")).toHaveAttribute("aria-pressed", "false");
  await star("piano-C4").click();
  await star("flute-C4").click();

  await viewFavorites.click();
  await editFavorite("piano-C4").click();
  await favorites.getByText("Playback metadata", { exact: true }).click();
  const favoriteRoot = favorites.getByRole("spinbutton", { name: "piano-C4 Root MIDI key" });
  await expect(favoriteRoot).toHaveValue("60");
  await favoriteRoot.fill("67");
  await favoriteRoot.press("Enter");
  await favorites.getByRole("button", { name: "Save Favorite", exact: true }).click();
  await expect(editFavorite("piano-C4")).toBeVisible();
  expect(songAsset(piano.url)).toMatchObject({ id: piano.id, rootKey: 60 });

  await back.click();
  await addAssets.getByRole("button", { name: "Remove piano-C4", exact: true }).click();
  await viewFavorites.click();
  await favorites
    .locator(".resource-entry")
    .filter({ has: page.getByRole("button", { name: "Edit piano-C4", exact: true }) })
    .getByRole("button", { name: "Add to Song", exact: true })
    .click();
  const pianoRow = addAssets
    .locator(".resource-entry")
    .filter({ has: page.getByRole("button", { name: "Favorite piano-C4", exact: true }) });
  await pianoRow.getByText("Playback metadata", { exact: true }).click();
  const songRoot = pianoRow.getByRole("spinbutton", { name: "piano-C4 Root MIDI key" });
  await expect(songRoot).toHaveValue("67");
  await songRoot.fill("69");
  await songRoot.press("Enter");
  await addAssets.getByRole("button", { name: "Okay", exact: true }).click();
  await expect(addAssets).toBeHidden();
  const insertedPiano = required(songAsset(piano.url));
  expect(insertedPiano.rootKey).toBe(69);
  expect(insertedPiano.id).not.toBe(piano.id);

  await page.reload();
  await command(page, "Edit", "Add Assets");
  expect(songAsset(piano.url)).toEqual(insertedPiano);
  await viewFavorites.click();
  await expect(editFavorite("piano-C4")).toBeVisible();
  await expect(editFavorite("flute-C4")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(addAssets).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(addAssets).toBeHidden();

  await command(page, "File", "New Blank Song");
  const newPiano = required(songAsset(piano.url));
  const newFlute = required(songAsset(flute.url));
  expect(newPiano.rootKey).toBe(67);
  expect(newPiano.id).not.toBe(insertedPiano.id);
  expect(newFlute.rootKey).toBe(60);
  expect(newFlute.id).not.toBe(flute.id);

  await command(page, "Edit", "Add Assets");
  await viewFavorites.click();
  await favorites.getByRole("button", { name: "Remove flute-C4 from favorites" }).click();
  await expect(editFavorite("flute-C4")).toHaveCount(0);
  expect(songAsset(flute.url)).toEqual(newFlute);

  // Leave the editor before clearing its session so pagehide can't recreate it.
  await page.route("**/__fresh_song__", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
  });
  await page.goto("./__fresh_song__");
  await deleteStoredState(page, "session");
  await page.goto("./");
  await expect(page.getByRole("combobox", { name: "File menu", exact: true })).toBeVisible();
  expect(songAsset(flute.url)).toBeUndefined();
  expect(songAsset(piano.url)?.rootKey).toBe(67);
  expect(songAsset(piano.url)?.id).not.toBe(newPiano.id);
});

test("bundled SoundFont favorites can be removed and restored independently", async ({ page }) => {
  const addAssets = page.getByRole("dialog", { name: "Add Assets", exact: true });
  const favorites = page.getByRole("dialog", { name: "View Favorites", exact: true });
  const fluidFavorite = favorites.getByRole("button", { name: "Edit fluid-r3-mono", exact: true });
  const pianoFavorite = favorites.getByRole("button", { name: "Edit piano-C4", exact: true });
  const restoreDefaults = favorites.getByRole("button", { name: "Restore Defaults", exact: true });
  const openFavorites = async (): Promise<void> => {
    await command(page, "Edit", "Add Assets");
    await addAssets.getByRole("button", { name: "View Favorites", exact: true }).click();
  };
  const songFluidCount = (): number =>
    decodeSong(new URL(page.url()).hash).resources.filter(
      (asset) => asset.url === "./assets/fluid-r3-mono.sf3",
    ).length;

  await page.goto("./");
  await openFavorites();
  await expect(fluidFavorite).toHaveCount(1);
  await expect(restoreDefaults).toBeDisabled();
  expect(songFluidCount()).toBe(1);
  await favorites
    .getByRole("button", { name: "Remove fluid-r3-mono from favorites", exact: true })
    .click();
  await expect(favorites.getByText("No favorite assets yet.")).toBeVisible();
  expect(songFluidCount()).toBe(1);

  await page.reload();
  await openFavorites();
  await expect(favorites.getByText("No favorite assets yet.")).toBeVisible();
  await expect(restoreDefaults).toBeEnabled();
  await favorites.getByRole("button", { name: "Back to Add Assets", exact: true }).click();
  await addAssets.getByRole("button", { name: "Close dialog", exact: true }).click();
  await importShortSong(page, "chip wave");
  await command(page, "Edit", "Add Assets");
  await addAssets.getByRole("button", { name: "Favorite piano-C4", exact: true }).click();
  await addAssets.getByRole("button", { name: "Remove fluid-r3-mono", exact: true }).click();
  await addAssets.getByRole("button", { name: "Okay", exact: true }).click();
  await expect(addAssets).toBeHidden();
  expect(songFluidCount()).toBe(0);

  await openFavorites();
  await expect(pianoFavorite).toHaveCount(1);
  await expect(fluidFavorite).toHaveCount(0);
  await restoreDefaults.click();
  await expect(fluidFavorite).toHaveCount(1);
  await expect(pianoFavorite).toHaveCount(1);
  await expect(restoreDefaults).toBeDisabled();
  expect(songFluidCount()).toBe(0);

  await page.reload();
  await openFavorites();
  await expect(fluidFavorite).toHaveCount(1);
  await expect(pianoFavorite).toHaveCount(1);
  await expect(restoreDefaults).toBeDisabled();
  expect(songFluidCount()).toBe(0);
});

for (const sample of ["test-piano-c4", "test-flute-c4"]) {
  test(`imported ${sample} can be selected, edited and rendered as audible stereo`, async ({
    page,
  }) => {
    await page.goto("./");
    await importShortSong(page, "chip wave");
    await page
      .getByRole("combobox", { name: "Wave", exact: true })
      .selectOption(`sample:${sample}`);
    await page.getByRole("button", { name: "Advanced Loop Controls", exact: true }).click();
    await expect(
      page.getByRole("application", { name: "Sample waveform and loop handles", exact: true }),
    ).toBeVisible();
    expectAudibleStereo(await exportAudio(page));
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Wave", exact: true })).toHaveValue(
      `sample:${sample}`,
    );
  });
}

test("imported Florestan SoundFont exposes native presets and renders its real samples", async ({
  page,
}) => {
  await page.goto("./");
  await importShortSong(page, "SoundFont");
  await page
    .getByRole("combobox", { name: "SoundFont", exact: true })
    .selectOption("test-florestan");
  await page.getByRole("combobox", { name: "Instrument", exact: true }).selectOption("0:2");
  await expect(
    page.getByRole("button", { name: "SoundFont preset configuration…", exact: true }),
  ).toHaveCount(0);
  const presetEffects = page.getByRole("switch", { name: "Preset effects", exact: true });
  await expect(presetEffects).toBeChecked();
  await presetEffects.uncheck();
  await expect(presetEffects).not.toBeChecked();
  expectAudibleStereo(await exportAudio(page));
});

test("a relative SF3 URL reconstructs the asset and its selected preset after reload", async ({
  page,
}) => {
  // The fixture contains two linked Ogg Vorbis test tones in an unpadded SF3 sample chunk.
  const fixture = new URL("../fixtures/soundfont-vorbis.sf3", import.meta.url).pathname;
  await page.goto("./");
  await importShortSong(page, "SoundFont");
  const relativeUrl = "./SoundFont%20Vorbis.v1.SF3?download=sample.wav#sample.wav";
  const source = new URL(relativeUrl, page.url());
  await page.route(
    (url) => url.pathname === source.pathname && url.search === source.search,
    async (route) => {
      await route.fulfill({ path: fixture, contentType: "application/octet-stream" });
    },
  );
  await command(page, "Edit", "Add Assets");
  const dialog = page.getByRole("dialog", { name: "Add Assets", exact: true });
  await dialog.getByRole("button", { name: "Add Asset", exact: true }).click();
  const asset = dialog.locator(".resource-entry").last();
  const url = asset.getByRole("textbox", { name: /Asset \d+ URL$/u });
  await url.fill(relativeUrl);
  await expect(asset.getByText("SoundFont Vorbis.v1", { exact: true })).toBeVisible();
  await expect(asset.getByText("Playback metadata", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Okay", exact: true }).click();
  await expect(dialog).toBeHidden();
  const font = page.getByRole("combobox", { name: "SoundFont", exact: true });
  await font.selectOption({ label: "SoundFont Vorbis.v1" });
  const preset = page.getByRole("combobox", { name: "Instrument", exact: true });
  await preset.selectOption({ label: "Vorbis Test Tone (0:2)" });
  const resourceId = await font.inputValue();
  await expect
    .poll(() => {
      const song = decodeSong(new URL(page.url()).hash);
      return {
        selected: song.channels[0]?.instruments[0]?.resourceId,
        url: song.resources.find((resource) => resource.id === resourceId)?.url,
      };
    })
    .toEqual({ selected: resourceId, url: relativeUrl });
  await page.reload();
  await expect(font.locator("option:checked")).toHaveText("SoundFont Vorbis.v1");
  await expect(preset).toBeEnabled();
  await expect(preset).toHaveValue("0:2");
  expectAudibleStereo(await exportAudio(page));
});
