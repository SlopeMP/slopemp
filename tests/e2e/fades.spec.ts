import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createInstrument } from "../../src/instruments";
import { createSong, required } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";

const instrument = async (page: Page): Promise<ReturnType<typeof createInstrument>> =>
  required(
    required(decodeSong(await page.evaluate(() => location.hash)).channels[0]).instruments[0],
  );

test.beforeEach(async ({ page }) => {
  const song = createSong();
  const sound = createInstrument();
  sound.attack = 0;
  sound.release = 0;
  required(song.channels[0]).instruments = [sound];
  await page.goto(`./#${encodeSong(song)}`);
});

test("negative fade-out drags across zero, renders forward, and survives undo and reload", async ({
  page,
}) => {
  const graph = page.getByRole("button", { name: "Fade In/Out graph", exact: true });
  const bounds = required(await graph.boundingBox());
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + bounds.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.375, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await instrument(page)).release).toBe(-0.5);
  expect((await instrument(page)).attack).toBe(0);
  const points = await graph.locator('path[fill="var(--graph-fill)"]').evaluate((path) => {
    const d = path.getAttribute("d") ?? "";
    return Array.from(d.matchAll(/L([\d.]+) ([\d.]+)/gu), (match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
    }));
  });
  expect(points.every((point, index) => point.x >= (points[index - 1]?.x ?? 0))).toBe(true);
  expect(points.at(-1)).toEqual({ x: 160, y: 58 });
  await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Undo");
  await expect.poll(async () => (await instrument(page)).release).toBe(0);
  await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Redo");
  await expect.poll(async () => (await instrument(page)).release).toBe(-0.5);
  await page.reload();
  await expect.poll(async () => (await instrument(page)).release).toBe(-0.5);
  await expect(graph.locator("svg")).toBeVisible();
});

test("fade handles support signed keyboard edits and pointer cancellation", async ({ page }) => {
  const graph = page.getByRole("button", { name: "Fade In/Out graph", exact: true });
  await graph.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await instrument(page)).release).toBe(-0.05);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await instrument(page)).attack).toBe(0.01);
  expect((await instrument(page)).release).toBe(-0.05);
  const bounds = required(await graph.boundingBox());
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + bounds.width * 0.4875, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.8, y, { steps: 4 });
  await graph.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect.poll(async () => (await instrument(page)).release).toBe(-0.05);
  await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Undo");
  await expect.poll(async () => (await instrument(page)).attack).toBe(0);
  expect((await instrument(page)).release).toBe(-0.05);
});

test("zero fade-out closes vertically at note end instead of drawing a diagonal", async ({
  page,
}) => {
  const graph = page.getByRole("button", { name: "Fade In/Out graph", exact: true });
  const path = graph.locator('path[fill="var(--graph-fill)"]');
  await expect(path).toHaveAttribute("d", /L160 0 L160 58 Z$/u);
  await graph.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await instrument(page)).attack).toBe(0.01);
  await expect(path).toHaveAttribute("d", /L160 0 L160 58 Z$/u);
});
