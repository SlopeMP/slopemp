import { expect, test } from "@playwright/test";

import { writeStoredState } from "./stored-state";

test("piano is left aligned by default, follows the pattern when disabled and reverts without previews", async ({
  page,
}) => {
  await page.goto("./");
  const piano = page.getByLabel("Piano keyboard", { exact: true });
  const grid = page.getByTestId("note-grid");
  await expect(page.locator(".note-editor")).not.toHaveClass(/piano-aligned/u);
  await expect(piano).toHaveCSS("opacity", "1");

  await writeStoredState(page, { preferences: { leftAlignPiano: false } });
  await page.reload();
  await expect(page.locator(".note-editor")).toHaveClass(/piano-aligned/u);
  await expect(piano).toHaveCSS("opacity", "0.82");
  await expect(async () => {
    const keys = await piano.boundingBox();
    const notes = await grid.boundingBox();
    expect(keys).not.toBeNull();
    expect(notes).not.toBeNull();
    expect(Math.abs((keys?.x ?? 0) + (keys?.width ?? 0) - (notes?.x ?? 0))).toBeLessThan(1);
  }).toPass();

  await page.setViewportSize({ width: 650, height: 900 });
  await expect(page.getByLabel("Previous bar preview", { exact: true })).toBeHidden();
  await expect(page.locator(".note-editor")).not.toHaveClass(/piano-aligned/u);
  await expect(piano).toHaveCSS("opacity", "1");
  await expect(async () => {
    const keys = await piano.boundingBox();
    const notes = await grid.boundingBox();
    expect(Math.abs((keys?.x ?? 0) + (keys?.width ?? 0) - (notes?.x ?? 0))).toBeLessThan(1);
  }).toPass();
});
