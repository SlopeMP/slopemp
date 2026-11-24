import { expect, test } from "@playwright/test";

import { createSong, required } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";

test("tempo preserves partial input and commits one undoable edit", async ({ page }) => {
  await page.goto(`./#${encodeSong(createSong())}`);
  const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
  const initialURL = page.url();
  await tempo.fill("");
  await tempo.pressSequentially("0");
  await expect(tempo).toHaveValue("0");
  expect(page.url()).toBe(initialURL);
  await tempo.press("Backspace");
  await tempo.pressSequentially("12");
  await expect(tempo).toHaveValue("12");
  expect(page.url()).toBe(initialURL);
  await tempo.press("Enter");
  expect(decodeSong(new URL(page.url()).hash).tempo).toBe(12);
  await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Undo");
  await expect(tempo).toHaveValue("150");
  await tempo.fill("1");
  await tempo.press("Tab");
  expect(decodeSong(new URL(page.url()).hash).tempo).toBe(1);
  await page.reload();
  await expect(tempo).toHaveValue("1");
});

test("arrangement numbers clamp only on commit and restore empty or canceled edits", async ({
  page,
}) => {
  await page.goto(`./#${encodeSong(createSong())}`);
  const beats = page.getByRole("spinbutton", { name: "Beats per bar", exact: true });
  await beats.fill("0");
  await expect(beats).toHaveValue("0");
  await beats.press("Enter");
  await expect(beats).toHaveValue("1");
  await beats.fill("99");
  await expect(beats).toHaveValue("99");
  await beats.press("Tab");
  await expect(beats).toHaveValue("64");
  await beats.fill("");
  await beats.press("Tab");
  await expect(beats).toHaveValue("64");
  const length = page.getByRole("spinbutton", { name: "Song length", exact: true });
  const original = await length.inputValue();
  await length.fill("0");
  await length.press("Escape");
  await expect(length).toHaveValue(original);
});

test("instrument decimals and signed beat offsets preserve incomplete numbers", async ({
  page,
}) => {
  await page.goto(`./#${encodeSong(createSong())}`);
  const volume = page.getByRole("spinbutton", { name: "Volume %", exact: true });
  const initialURL = page.url();
  await volume.fill("");
  await volume.pressSequentially("12.5");
  await expect(volume).toHaveValue("12.5");
  expect(page.url()).toBe(initialURL);
  await volume.press("Enter");
  expect(
    required(required(decodeSong(new URL(page.url()).hash).channels[0]).instruments[0]).volume,
  ).toBe(0.125);
  await page
    .getByRole("combobox", { name: "Edit menu", exact: true })
    .selectOption("Move All Notes Sideways");
  const offset = page.getByRole("spinbutton", { name: "Beat offset", exact: true });
  await offset.fill("");
  await offset.pressSequentially("-0.5");
  await expect(offset).toHaveValue("-0.5");
  await offset.press("Enter");
  await expect(offset).toHaveValue("-0.5");
  await expect(page.getByRole("dialog")).toBeVisible();
});
