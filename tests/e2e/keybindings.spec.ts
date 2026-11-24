import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createChannel, createSong } from "../../src/model";
import type { Channel } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";

test("Ctrl+Enter inserts the selected channel kind directly below it", async ({ page }) => {
  const song = createSong();
  const first = createChannel("automation");
  first.name = "Automation 1";
  const second = createChannel("automation");
  second.name = "Automation 2";
  song.channels.push(first, second);
  await page.goto(`./#${encodeSong(song)}`);

  const channels = async (): Promise<Array<Pick<Channel, "cells" | "kind" | "name">>> =>
    decodeSong(await page.evaluate(() => location.hash.slice(1))).channels.map(
      ({ name, kind, cells }) => ({ name, kind, cells }),
    );
  const emptyCells = Array<number>(song.barCount).fill(0);
  const original = await channels();

  await page.getByTestId("cell-1-0").click();
  await page.keyboard.press("Control+Enter");
  await expect
    .poll(channels)
    .toEqual([
      ...original.slice(0, 2),
      { name: "Track 4", kind: "track", cells: emptyCells },
      ...original.slice(2),
    ]);
  await page.keyboard.press("z");
  await expect.poll(channels).toEqual(original);

  await page.getByTestId("cell-3-0").click();
  await page.keyboard.press("Control+Enter");
  await expect
    .poll(channels)
    .toEqual([
      ...original.slice(0, 4),
      { name: "Automation 3", kind: "automation", cells: emptyCells },
      ...original.slice(4),
    ]);
});

const openBindings = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await page.getByRole("button", { name: "Key Bindings", exact: true }).click();
};

test("key bindings can be changed, used, persisted, and reset", async ({ page }) => {
  await page.goto("./");
  await openBindings(page);
  const undo = page.getByRole("button", { name: "Set Undo key binding", exact: true });
  await undo.click();
  await page.keyboard.press("k");
  await expect(undo).toHaveText("K");
  await expect(page.getByRole("combobox", { name: "Controls preset", exact: true })).toHaveValue(
    "custom",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByTestId("note-grid").click({ position: { x: 80, y: 100 } });
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.keyboard.press("z");
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.keyboard.press("k");
  await expect(page.getByTestId("note")).toHaveCount(0);
  await page.reload();
  await openBindings(page);
  await expect(undo).toHaveText("K");
  await page.getByRole("button", { name: "Reset Key Bindings", exact: true }).click();
  await expect(undo).toHaveText("Z");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByTestId("note-grid").click({ position: { x: 80, y: 100 } });
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.keyboard.press("z");
  await expect(page.getByTestId("note")).toHaveCount(0);
});

test("binding capture handles conflicts, cancellation, and clearing", async ({ page }) => {
  await page.goto("./");
  await openBindings(page);
  const undo = page.getByRole("button", { name: "Set Undo key binding", exact: true });
  await undo.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Preferences", exact: true })).toBeVisible();
  await expect(undo).toHaveText("Z");
  await undo.click();
  await page.keyboard.press("v");
  await expect(undo).toHaveText("Key in use");
  await expect(undo).toBeFocused();
  await page.keyboard.press("k");
  await expect(undo).toHaveText("K");
  await expect(page.getByRole("button", { name: "Set Paste key binding", exact: true })).toHaveText(
    "V / Ctrl+V",
  );
  await page.getByRole("button", { name: "Clear Undo key binding", exact: true }).click();
  await expect(undo).toHaveText("Unbound");
  await page.reload();
  await openBindings(page);
  await expect(undo).toHaveText("Unbound");
});

test("individual resets restore alternatives and confirm conflicting bindings", async ({
  page,
}) => {
  await page.goto("./");
  await openBindings(page);
  const notes = page.getByRole("switch", { name: "Unbound keys play notes", exact: true });
  await notes.check();
  const copy = page.getByRole("button", { name: "Set Copy key binding", exact: true });
  const paste = page.getByRole("button", { name: "Set Paste key binding", exact: true });
  await page.getByRole("button", { name: "Clear Copy key binding", exact: true }).click();
  await paste.click();
  await page.keyboard.press("c");
  await page.getByRole("button", { name: "Reset Copy key binding", exact: true }).click();
  await expect(copy).toHaveText("Key in use");
  await expect(copy).toBeFocused();
  await expect(copy).toHaveCSS("color", "rgb(255, 85, 85)");
  await page.keyboard.press("Escape");
  await expect(copy).toHaveText("Unbound");
  await expect(paste).toHaveText("C");
  await page.getByRole("button", { name: "Clear Paste key binding", exact: true }).click();
  await page.getByRole("button", { name: "Reset Copy key binding", exact: true }).click();
  await expect(copy).toHaveText("C / Ctrl+C");
  await page.getByRole("button", { name: "Reset Paste key binding", exact: true }).click();
  await expect(paste).toHaveText("V / Ctrl+V");
  await expect(page.getByRole("button", { name: "Set Undo key binding", exact: true })).toHaveText(
    "Z",
  );
  await expect(notes).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Controls preset", exact: true })).toHaveValue(
    "custom",
  );
  await page.reload();
  await openBindings(page);
  await expect(copy).toHaveText("C / Ctrl+C");
  await expect(paste).toHaveText("V / Ctrl+V");
});

test("controls presets and note playback are independent and persist", async ({ page }) => {
  await page.goto("./");
  await openBindings(page);
  const preset = page.getByRole("combobox", { name: "Controls preset", exact: true });
  const notes = page.getByRole("switch", { name: "Unbound keys play notes", exact: true });
  const undo = page.getByRole("button", { name: "Set Undo key binding", exact: true });
  await expect(preset.locator("option")).toHaveText([
    "Simple shortcuts",
    "Combo shortcuts",
    "Custom",
  ]);
  await expect(preset).toHaveValue("simple");
  await expect(notes).not.toBeChecked();
  await preset.selectOption("combo");
  await expect(undo).toHaveText("Ctrl+Z");
  await expect(notes).not.toBeChecked();
  await notes.check();
  await preset.selectOption("simple");
  await expect(undo).toHaveText("Z");
  await expect(notes).toBeChecked();
  await preset.selectOption("custom");
  await expect(undo).toHaveText("Z");
  await page.reload();
  await openBindings(page);
  await expect(preset).toHaveValue("custom");
  await expect(notes).toBeChecked();
  await preset.selectOption("combo");
  await undo.click();
  await page.keyboard.press("k");
  await expect(preset).toHaveValue("custom");
  await expect(undo).toHaveText("K");
  await page.getByRole("button", { name: "Reset Key Bindings", exact: true }).click();
  await expect(preset).toHaveValue("simple");
  await expect(notes).toBeChecked();
});

test("removed actions are absent and shortcut labels match the environment", async ({ page }) => {
  await page.goto("./");
  await openBindings(page);
  for (const label of [
    "Playback to selected bar",
    "Playback to beginning",
    "Cut pattern notes",
    "Copy pattern notes",
    "Paste pattern notes",
    "Select instrument 1",
    "Select instrument 10",
  ]) {
    await expect(
      page.getByRole("button", { name: `Set ${label} key binding`, exact: true }),
    ).toHaveCount(0);
  }
  await expect(
    page.getByRole("heading", { name: "Instrument selection", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Set Start / stop recording key binding", exact: true }),
  ).toHaveText("Ctrl+P");
  await expect(
    page.getByRole("button", { name: "Set Select previous channel key binding", exact: true }),
  ).toHaveText("Up");
  await expect(
    page.getByRole("button", { name: "Set Move selected channels up key binding", exact: true }),
  ).toHaveText("Ctrl+Up");
  await expect(
    page.getByRole("button", { name: "Set Copy instrument key binding", exact: true }),
  ).toHaveText("Shift+C");
  await expect(
    page.getByRole("button", { name: "Set Paste instrument key binding", exact: true }),
  ).toHaveText("Shift+V");
  await expect(page.getByText(/Choose a binding, then press the new key combination/u)).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Note Recording", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Shortcut/performance keyboard mode", exact: true }),
  ).toHaveCount(0);
});

test("Mac environment signals display Cmd bindings", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: { platform: "macOS" },
    });
  });
  await page.goto("./");
  await openBindings(page);
  await expect(
    page.getByRole("button", { name: "Set Start / stop recording key binding", exact: true }),
  ).toHaveText("Cmd+P");
  await expect(
    page.getByRole("button", { name: "Set Move selected channels up key binding", exact: true }),
  ).toHaveText("Cmd+Up");
});

test("note playback and Caps Lock leave bound shortcuts in control", async ({ page }) => {
  await page.goto("./");
  await openBindings(page);
  await page.getByRole("switch", { name: "Unbound keys play notes", exact: true }).check();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByTestId("note-grid").click({ position: { x: 80, y: 100 } });
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.keyboard.press("CapsLock");
  await page.keyboard.press("z");
  await expect(page.getByTestId("note")).toHaveCount(0);
  await page.keyboard.press("CapsLock");
  await openBindings(page);
  await page.getByRole("combobox", { name: "Controls preset", exact: true }).selectOption("combo");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByTestId("note-grid").click({ position: { x: 80, y: 100 } });
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.keyboard.press("z");
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("note")).toHaveCount(0);
});

test("the same clipboard bindings copy and cut selections and paste patterns", async ({ page }) => {
  await page.goto("./");
  await openBindings(page);
  for (const [action, key] of [
    ["Copy", "k"],
    ["Paste", "j"],
    ["Cut", "l"],
  ] as const) {
    await page.getByRole("button", { name: `Set ${action} key binding`, exact: true }).click();
    await page.keyboard.press(key);
  }
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByTestId("note-grid").click({ position: { x: 80, y: 100 } });
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.keyboard.press("k");
  await page.getByTestId("cell-1-4").click();
  await page.keyboard.press("j");
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.keyboard.press("l");
  await expect(page.getByTestId("cell-1-4")).toHaveText("0");
  await page.getByTestId("cell-2-4").click();
  await page.keyboard.press("j");
  await expect(page.getByTestId("note")).toHaveCount(1);
});

test("recording captures only unbound keys when note playback is enabled", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await page
    .getByRole("switch", { name: "Count-in one bar of metronome before recording", exact: true })
    .uncheck();
  await page.getByRole("switch", { name: "Hear metronome while recording", exact: true }).uncheck();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.locator("main").focus();
  await page.keyboard.press("Control+p");
  await expect(page.getByRole("button", { name: "Stop Recording", exact: true })).toBeFocused();
  await page.keyboard.down("KeyF");
  await page.waitForTimeout(100);
  await page.keyboard.up("KeyF");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("note")).toHaveCount(0);
  await openBindings(page);
  await page.getByRole("switch", { name: "Unbound keys play notes", exact: true }).check();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.locator("main").focus();
  await page.keyboard.press("Control+p");
  await expect(page.getByRole("button", { name: "Stop Recording", exact: true })).toBeFocused();
  await page.keyboard.down("KeyZ");
  await page.waitForTimeout(100);
  await page.keyboard.up("KeyZ");
  await page.keyboard.down("KeyF");
  await page.waitForTimeout(100);
  await page.keyboard.up("KeyF");
  await page.keyboard.down("KeyH");
  await page.waitForTimeout(100);
  await page.keyboard.up("KeyH");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("note")).toHaveCount(2);
});
