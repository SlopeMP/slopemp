import { expect, test } from "@playwright/test";

import { createSong, required } from "../../src/model";
import { encodeSong } from "../../src/storage";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test("touch note insertion and dialog scrolling remain usable in the compact layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await page.goto("./");
  const grid = page.getByTestId("note-grid");
  const bounds = await grid.boundingBox();
  if (bounds === null) {
    throw new Error("Missing compact note grid.");
  }
  await page.touchscreen.tap(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.5);
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.getByRole("button", { name: "Preferences", exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Preferences", exact: true }).tap();
  const dialog = page.getByRole("dialog", { name: "Preferences", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Choose Layout", exact: true })).toBeHidden();
  const toggle = dialog.getByRole("switch", {
    name: "Count-in one bar of metronome before recording",
    exact: true,
  });
  await toggle.scrollIntoViewIfNeeded();
  await toggle.tap();
  await expect(toggle).not.toBeChecked();
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).tap();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the touch pattern picker keeps the assigned pattern when the limit changes", async ({
  page,
}) => {
  const song = createSong();
  required(song.channels[0]).cells[0] = 3;
  await page.goto(`./#${encodeSong(song)}`);

  const cell = page.getByTestId("cell-0-0");
  await cell.tap();
  const pattern = page.getByRole("combobox", { name: "Choose pattern", exact: true });
  await expect(pattern).toHaveValue("3");

  await page.getByRole("spinbutton", { name: "Max patterns", exact: true }).fill("9");
  await expect(pattern.locator("option")).toHaveCount(10);
  await expect(pattern).toHaveValue("3");

  await pattern.selectOption("9");
  await expect(cell).toHaveAccessibleName(/pattern 9$/u);
});
