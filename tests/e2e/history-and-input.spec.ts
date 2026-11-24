import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createInstrument } from "../../src/instruments";
import { createSong, required } from "../../src/model";
import { decodeSong, encodeSong, parseSongBytes } from "../../src/storage";
import { readStoredState } from "./stored-state";

const edit = async (page: Page, action: string): Promise<void> => {
  await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption(action);
};

test("undo stops at the oldest retained browser entry after a long editing session", async ({
  page,
}) => {
  await page.goto("./");
  const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
  for (let index = 1; index <= 70; index++) {
    await tempo.fill(String(150 + index));
  }
  const distance = await page.evaluate(() => Math.min(70, globalThis.history.length - 1));
  await page.evaluate((steps) => {
    globalThis.history.go(-steps);
  }, distance);
  await expect(tempo).toHaveValue(String(220 - distance));
  await expect(
    page.getByRole("combobox", { name: "Edit menu" }).locator('option[value="Undo"]'),
  ).toBeDisabled();
  await page.reload();
  await edit(page, "Redo");
  await expect(tempo).toHaveValue(String(221 - distance));
});

test("undo and redo traverse browser entries and new edits discard the forward branch", async ({
  page,
}) => {
  await page.goto("./");
  const length = await page.evaluate(() => globalThis.history.length);
  const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
  await page.getByTestId("note-grid").click({ position: { x: 80, y: 100 } });
  await tempo.fill("190");
  expect(await page.evaluate(() => globalThis.history.length)).toBe(length + 2);
  await edit(page, "Undo");
  await expect(tempo).toHaveValue("150");
  await edit(page, "Redo");
  await expect(tempo).toHaveValue("190");
  expect(await page.evaluate(() => globalThis.history.length)).toBe(length + 2);
  await page.goBack();
  await expect(tempo).toHaveValue("150");
  await page.goBack();
  await expect(page.getByTestId("note")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByTestId("note")).toHaveCount(1);
  await tempo.fill("180");
  await expect(
    page.getByRole("combobox", { name: "Edit menu" }).locator('option[value="Redo"]'),
  ).toBeDisabled();
  await page.reload();
  await edit(page, "Undo");
  await expect(tempo).toHaveValue("150");
  await edit(page, "Redo");
  await expect(tempo).toHaveValue("180");
});

test("song URLs and JSON exports contain only the current song and share no undo history", async ({
  page,
  context,
}) => {
  await page.goto("./");
  const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
  await tempo.fill("190");
  await tempo.fill("180");
  const url = page.url();
  const shared = decodeSong(new URL(url).hash);
  expect(shared).toMatchObject({ version: 1, tempo: 180 });
  for (const field of ["history", "songs", "labels", "past", "future"]) {
    expect(shared).not.toHaveProperty(field);
  }
  const linked = await context.newPage();
  await linked.goto(url);
  await expect(linked.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue("180");
  await expect(
    linked.getByRole("combobox", { name: "Edit menu" }).locator('option[value="Undo"]'),
  ).toBeDisabled();
  await linked.close();

  await page.getByRole("combobox", { name: "File menu", exact: true }).selectOption("Export Song");
  await page.getByRole("combobox", { name: "File Type", exact: true }).selectOption("slopemp");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const file = await downloading;
  const exported = parseSongBytes(await readFile(required(await file.path())));
  expect(exported).toMatchObject({ version: 1, tempo: 180 });
  for (const field of ["history", "songs", "labels", "past", "future"]) {
    expect(exported).not.toHaveProperty(field);
  }
});

test("reload retains musical undo and redo while browser navigation retains its forward branch", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByTestId("note-grid").click({ position: { x: 80, y: 100 } });
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.reload();
  await edit(page, "Undo");
  await expect(page.getByTestId("note")).toHaveCount(0);
  await edit(page, "Redo");
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.getByRole("spinbutton", { name: "Tempo", exact: true }).fill("190");
  await expect(page.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue("190");
  await page.goBack();
  await expect(page.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue("150");
  await page.goForward();
  await expect(page.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue("190");
});

test("global playback shortcuts override the focused button", async ({ page }) => {
  await page.goto("./");
  const mute = page.getByRole("button", { name: "Mute Track 1", exact: true });
  await mute.focus();
  await page.keyboard.press("Space");
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.locator("main")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});

test("one coarse tempo drag produces one undo step", async ({ page }) => {
  await page.goto("./");
  const tempo = page.getByRole("slider", { name: "Coarse tempo", exact: true });
  const bounds = await tempo.boundingBox();
  if (bounds === null) {
    throw new Error("Tempo slider is missing.");
  }
  await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.85, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole("spinbutton", { name: "Tempo", exact: true })).not.toHaveValue("150");
  await edit(page, "Undo");
  await expect(page.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue("150");
});

test("piano sliding changes the held key and releases it without starting playback", async ({
  page,
}) => {
  await page.goto("./");
  const keys = page.locator(".piano-key");
  const first = keys.nth(10);
  const second = keys.nth(12);
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  if (a === null || b === null) {
    throw new Error("Piano keys are missing.");
  }
  await page.mouse.move(a.x + 5, a.y + a.height / 2);
  await page.mouse.down();
  await expect(first).toHaveClass(/auditioning/u);
  await page.mouse.move(b.x + 5, b.y + b.height / 2, { steps: 3 });
  await expect(second).toHaveClass(/auditioning/u);
  await expect(first).not.toHaveClass(/auditioning/u);
  await page.mouse.up();
  await expect(page.locator(".piano-key.auditioning")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});

test("excluded pitches remain directly editable after changing the scale", async ({ page }) => {
  await page.goto("./");
  const grid = page.getByTestId("note-grid");
  const bounds = await grid.boundingBox();
  if (bounds === null) {
    throw new Error("Note grid is missing.");
  }
  const position = { x: bounds.width * 0.1, y: (bounds.height * 23.5) / 37 };
  await grid.click({ position });
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Scale", exact: true }).selectOption("Major");
  await expect(page.getByTestId("note")).toHaveCount(1);
  await grid.click({ position });
  await expect(page.getByTestId("note")).toHaveCount(0);
});

test("recording continues beyond the old song end when additional notes arrive", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("spinbutton", { name: "Song length", exact: true }).fill("1");
  await page.getByRole("spinbutton", { name: "Beats per bar", exact: true }).fill("1");
  await page.getByRole("spinbutton", { name: "Tempo", exact: true }).fill("300");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await page
    .getByRole("switch", { name: "Count-in one bar of metronome before recording", exact: true })
    .uncheck();
  await page.getByRole("switch", { name: "Hear metronome while recording", exact: true }).uncheck();
  await page.getByRole("button", { name: "Key Bindings", exact: true }).click();
  await page.getByRole("switch", { name: "Unbound keys play notes", exact: true }).check();
  await page.keyboard.press("Escape");
  await page.locator("main").focus();
  await page.keyboard.press("Control+p");
  await expect(page.getByRole("button", { name: "Stop Recording", exact: true })).toBeFocused();
  await expect
    .poll(async () =>
      Number(((await page.locator(".speaker span").textContent()) ?? "").split(":")[0]),
    )
    .toBeGreaterThan(2);
  await page.keyboard.down("KeyF");
  await page.waitForTimeout(100);
  await page.keyboard.up("KeyF");
  await page.keyboard.down("KeyH");
  await page.waitForTimeout(100);
  await page.keyboard.up("KeyH");
  await page.keyboard.press("Space");
  await expect
    .poll(async () =>
      Number(await page.getByRole("spinbutton", { name: "Song length", exact: true }).inputValue()),
    )
    .toBeGreaterThan(2);
  await edit(page, "Undo");
  await expect(page.getByRole("spinbutton", { name: "Song length", exact: true })).toHaveValue("1");
});

test("focused buttons keep global navigation and editing shortcuts", async ({ page }) => {
  await page.goto("./");
  const type = page.locator(".type-button");
  await type.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("cell-0-1")).toHaveClass(/current/u);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("spinbutton", { name: "Song length", exact: true })).toHaveValue(
    "17",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("z");
  await expect(page.getByRole("spinbutton", { name: "Song length", exact: true })).toHaveValue(
    "16",
  );
  await type.focus();
  await page.keyboard.press("q");
  await expect(page.getByRole("dialog", { name: "Channel Settings", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("numeric inputs capture editing keys while Space remains global", async ({ page }) => {
  await page.goto("./");
  const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
  await tempo.fill("190");
  await tempo.press("ArrowUp");
  await expect(tempo).toHaveValue("191");
  await expect(page.getByTestId("cell-0-0")).toHaveClass(/current/u);
  await tempo.press("Space");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
});

test("pending session saves retain the committed song during a live preview", async ({ page }) => {
  await page.goto("./");
  const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
  const previewTempo = await tempo.evaluate(async (field) => {
    if (!(field instanceof HTMLInputElement)) {
      throw new Error("Tempo field is missing.");
    }
    field.value = "180";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    // Let the committed edit publish, keeping the deferred save's timer pending.
    await Promise.resolve();
    const slider = document.querySelector<HTMLInputElement>('input[aria-label="Coarse tempo"]');
    if (slider === null) {
      throw new Error("Tempo slider is missing.");
    }
    slider.value = "220";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    globalThis.dispatchEvent(new Event("pagehide"));
    return field.value;
  });
  expect(previewTempo).toBe("220");
  await expect
    .poll(async () => {
      const stored = await readStoredState(page, "session");
      return stored === undefined ? undefined : parseSongBytes(stored).tempo;
    })
    .toBe(180);
  await page
    .getByRole("slider", { name: "Coarse tempo", exact: true })
    .dispatchEvent("pointercancel");
  await expect(tempo).toHaveValue("180");
});

test("action menus return to their placeholder after each command", async ({ page }) => {
  await page.goto("./");
  const menu = page.getByRole("combobox", { name: "Edit menu", exact: true });
  const file = page.getByRole("combobox", { name: "File menu", exact: true });
  const length = page.getByRole("spinbutton", { name: "Song length", exact: true });
  await expect(menu).toHaveValue("");
  await expect(file).toHaveValue("");
  await menu.selectOption("Insert Bar");
  await expect(length).toHaveValue("17");
  await expect(menu).toHaveValue("");
  await menu.selectOption("Insert Bar");
  await expect(length).toHaveValue("18");
  await expect(menu).toHaveValue("");
  await edit(page, "Undo");
  await expect(length).toHaveValue("17");
  await expect(menu).toHaveValue("");
  await file.selectOption("Export Song");
  await expect(page.getByRole("dialog", { name: "Export Options", exact: true })).toBeVisible();
  await expect(file).toHaveValue("");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await file.selectOption("Export Song");
  await expect(page.getByRole("dialog", { name: "Export Options", exact: true })).toBeVisible();
});

test("SoundFont asset actions retain the selected collection and can reopen", async ({ page }) => {
  const song = createSong();
  const instrument = createInstrument("SoundFont");
  instrument.resourceId = "bundled-fluid-r3-mono";
  required(song.channels[0]).instruments = [instrument];
  await page.goto(`./#${encodeSong(song)}`);
  const font = page.getByRole("combobox", { name: "SoundFont", exact: true });
  await expect(font).toHaveValue("bundled-fluid-r3-mono");
  await font.selectOption("add");
  const assets = page.getByRole("dialog", { name: "Add Assets", exact: true });
  await expect(assets).toBeVisible();
  await expect(font).toHaveValue("bundled-fluid-r3-mono");
  await assets.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(assets).toHaveCount(0);
  await font.selectOption("add");
  await expect(assets).toBeVisible();
  await expect(font).toHaveValue("bundled-fluid-r3-mono");
  expect(
    required(required(decodeSong(new URL(page.url()).hash).channels[0]).instruments[0]).resourceId,
  ).toBe("bundled-fluid-r3-mono");
});

test("structural numeric edits retain focus and apply each typed value", async ({ page }) => {
  await page.goto("./");
  await page.getByTestId("cell-0-1").click();
  const length = page.getByRole("spinbutton", { name: "Song length", exact: true });
  const field = required(await length.elementHandle());
  await length.focus();
  await length.press("ControlOrMeta+a");
  await page.keyboard.insertText("2");
  await expect(length).toHaveValue("2");
  await expect(length).toBeFocused();
  await page.keyboard.insertText("4");
  await expect(length).toHaveValue("24");
  await expect(length).toBeFocused();
  expect(await field.evaluate((element) => element.isConnected)).toBe(true);
  expect(decodeSong(new URL(page.url()).hash).barCount).toBe(24);
  await expect(page.getByTestId("cell-0-1")).toHaveClass(/current/u);
  await edit(page, "Undo");
  await expect(length).toHaveValue("2");
  await edit(page, "Undo");
  await expect(length).toHaveValue("16");
});

test("select arrows stay visible on hover and editor controls keep their size", async ({
  page,
}) => {
  await page.goto("./");
  const scale = page.getByRole("combobox", { name: "Scale", exact: true });
  const arrow = scale.locator("..").locator("svg.icon-tabler-chevron-down");
  await expect(arrow).toBeVisible();
  await scale.hover();
  await expect(arrow).toBeVisible();
  await expect(scale).toHaveCSS("border-radius", "4px");
  expect((await page.locator(".piano").boundingBox())?.width).toBe(32);
  expect(
    (await page.getByRole("slider", { name: "Octave", exact: true }).boundingBox())?.width,
  ).toBe(20);
  const first = await page.getByTestId("cell-0-0").boundingBox();
  const next = await page.getByTestId("cell-0-1").boundingBox();
  expect(first?.height).toBe(26);
  expect((next?.x ?? 0) - (first?.x ?? 0)).toBe(32);
  expect(
    (await page.getByRole("slider", { name: "Loop region", exact: true }).boundingBox())?.height,
  ).toBe(20);
});
