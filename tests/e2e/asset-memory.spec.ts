import { expect, test } from "@playwright/test";

import { createSong } from "../../src/model";
import { encodeSong } from "../../src/storage";

test("Undo restores the removed SoundFont without downloading it again", async ({ page }) => {
  const requests = new Map<string, number>();
  await page.route("**/test-assets/memory-*.sf2", async (route) => {
    const { pathname } = new URL(route.request().url());
    requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
    await route.fulfill({
      path: new URL("../assets/florestan-subset.sf2", import.meta.url).pathname,
    });
  });
  const song = createSong();
  song.resources = Array.from({ length: 3 }, (_unused, index) => ({
    id: `memory-font-${index}`,
    url: `./test-assets/memory-${index}.sf2`,
  }));
  await page.goto(`./#${encodeSong(song)}`);
  const edit = page.getByRole("combobox", { name: "Edit menu", exact: true });
  await edit.selectOption("Add Assets");
  const assets = page.getByRole("dialog", { name: "Add Assets", exact: true });
  await expect(assets.getByText("Ready", { exact: true })).toHaveCount(3);
  await assets.getByRole("button", { name: "Remove memory-1", exact: true }).click();
  await assets.getByRole("button", { name: "Okay", exact: true }).click();
  await expect(assets).toBeHidden();
  await edit.selectOption("Undo");
  await edit.selectOption("Add Assets");
  await expect(assets.getByText("Ready", { exact: true })).toHaveCount(3);
  const requestCounts = [...requests].map(([path, count]) => ({
    filename: path.split("/").at(-1),
    count,
  }));
  expect(requestCounts).toEqual(
    expect.arrayContaining([
      { filename: "memory-0.sf2", count: 1 },
      { filename: "memory-1.sf2", count: 1 },
      { filename: "memory-2.sf2", count: 1 },
    ]),
  );
});
