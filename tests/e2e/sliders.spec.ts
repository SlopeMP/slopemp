import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

import { createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";

test.beforeEach(async ({ page }) => {
  const song = createSong();
  for (const channel of song.channels) {
    channel.instruments = [createInstrument()];
    required(channel.instruments[0]).volume = 1.25;
  }
  await page.goto(`./#${encodeSong(song)}`);
});

test("instrument sliders render their rails and centered thumbs", async ({ page }) => {
  const slider = page.getByRole("slider", { name: "Volume slider", exact: true });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveScreenshot("instrument-volume-slider.png");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("126");
  await expect(page.getByRole("spinbutton", { name: "Volume %", exact: true })).toHaveValue("126");
  const bounds = required(await slider.boundingBox());
  await slider.click({ position: { x: bounds.width * 0.75, y: bounds.height / 2 } });
  await expect(slider).not.toHaveValue("125");
  await expect(page.getByRole("spinbutton", { name: "Volume %", exact: true })).toHaveValue(
    await slider.inputValue(),
  );
});

test("instrument volume reaches 250% and survives reload", async ({ page }) => {
  const slider = page.getByRole("slider", { name: "Volume slider", exact: true });
  const input = page.getByRole("spinbutton", { name: "Volume %", exact: true });
  await expect(slider).toHaveAttribute("max", "250");
  await input.fill("200");
  await input.press("Enter");
  await expect(slider).toHaveValue("200");
  await slider.focus();
  await slider.press("End");
  await expect(input).toHaveValue("250");
  await expect
    .poll(
      () =>
        required(required(decodeSong(new URL(page.url()).hash).channels[0]).instruments[0]).volume,
    )
    .toBe(2.5);
  await page.reload();
  await expect(slider).toHaveValue("250");
  await expect(input).toHaveValue("250");
});

test("graph range controls cover the full octave and loop drawing surfaces", async ({ page }) => {
  for (const name of ["Octave", "Loop region"]) {
    const geometry = await page.getByRole("slider", { name, exact: true }).evaluate((element) => {
      const parent = element.parentElement;
      if (!parent) {
        throw new Error("Missing slider drawing surface");
      }
      const control = element.getBoundingClientRect();
      const surface = parent.getBoundingClientRect();
      return {
        width: control.width,
        height: control.height,
        surfaceWidth: surface.width,
        surfaceHeight: surface.height,
      };
    });
    expect(geometry.width).toBeCloseTo(geometry.surfaceWidth, 0);
    expect(geometry.height).toBeCloseTo(geometry.surfaceHeight, 0);
  }
  const octave = page.getByRole("slider", { name: "Octave", exact: true });
  const bounds = required(await octave.boundingBox());
  expect(bounds.height).toBeGreaterThan(100);
  const value = await octave.inputValue();
  await octave.click({ position: { x: bounds.width / 2, y: bounds.height - 4 } });
  await expect(octave).not.toHaveValue(value);
});

test("octave scrollbar height is saved independently for each track", async ({ page }) => {
  const octave = page.getByRole("slider", { name: "Octave", exact: true });
  const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
  const zoomOut = page.getByRole("button", { name: "Zoom out", exact: true });

  await expect(octave).toHaveAttribute("max", "6");
  await zoomOut.click();
  await expect(octave).toHaveAttribute("max", "5");

  await page.getByTestId("cell-1-0").click();
  await expect(octave).toHaveAttribute("max", "6");
  await zoomIn.click();
  await expect(octave).toHaveAttribute("max", "7");
  const saved = decodeSong(new URL(page.url()).hash);
  expect(saved.channels.map((channel) => channel.octaves)).toEqual([4, 2, 3]);

  await page.getByTestId("cell-0-0").click();
  await expect(octave).toHaveAttribute("max", "5");
  await page.reload();
  await expect(octave).toHaveAttribute("max", "5");
  await page.getByTestId("cell-1-0").click();
  await expect(octave).toHaveAttribute("max", "7");
});

test("ghost notes follow the source track's octave scroll and zoom", async ({ page }) => {
  const song = createSong();
  const source = required(song.channels[1]);
  source.octaves = 2;
  source.cells[0] = 1;
  required(source.patterns[1]).notes = [createNote(0, 1, 54)];
  await page.goto(`./#${encodeSong(song)}`);

  const grid = page.getByTestId("note-grid");
  const note = grid.getByTestId("note");
  const ghost = grid.getByTestId("context-note");
  const verticalCenter = async (path: Locator): Promise<number> =>
    await path.evaluate((element) => {
      if (!(element instanceof SVGPathElement) || !element.ownerSVGElement) {
        throw new Error("Expected a note path inside the pattern grid");
      }
      const bounds = element.getBBox();
      return (bounds.y + bounds.height / 2) / element.ownerSVGElement.viewBox.baseVal.height;
    });

  const original = await verticalCenter(ghost);
  await page.getByTestId("cell-1-0").click();
  expect(await verticalCenter(note)).toBeCloseTo(original, 3);

  const octave = page.getByRole("slider", { name: "Octave", exact: true });
  await octave.press("ArrowUp");
  await expect(octave).toHaveValue("4");
  const scrolled = await verticalCenter(note);
  expect(scrolled).toBeGreaterThan(original);
  const saved = decodeSong(new URL(page.url()).hash);
  expect(saved.channels.map((channel) => channel.octave)).toEqual([4, 4, 2]);

  await page.getByTestId("cell-0-0").click();
  await page.reload();
  expect(await verticalCenter(ghost)).toBeCloseTo(scrolled, 3);
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  expect(await verticalCenter(ghost)).toBeCloseTo(scrolled, 3);
});

test("dragging the octave scrollbar saves one song edit on release", async ({ page }) => {
  const octave = page.getByRole("slider", { name: "Octave", exact: true });
  const bounds = required(await octave.boundingBox());
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + (188 / 481) * bounds.height;
  const url = page.url();
  const historyLength = await page.evaluate(() => history.length);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + (106 / 481) * bounds.height, { steps: 8 });
  await expect(octave).toHaveValue("2");
  expect(page.url()).toBe(url);

  await page.mouse.up();
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  expect(required(decodeSong(new URL(page.url()).hash).channels[0]).octave).toBe(2);
  await page.reload();
  await expect(octave).toHaveValue("2");
});
