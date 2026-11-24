import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createSong, required } from "../../src/model";
import { setChannelCount } from "../../src/operations";
import { decodeSong, encodeSong } from "../../src/storage";
import { seedStorage } from "./stored-state";

const expectFullRoll = async (page: Page): Promise<void> => {
  await expect(async () => {
    const region = required(await page.locator(".pattern-region").boundingBox());
    for (const selector of [".piano", ".piano-key:last-child", ".note-grid", ".octave-scroll"]) {
      const child = required(await page.locator(selector).boundingBox());
      expect(child.y).toBeGreaterThanOrEqual(region.y - 1);
      expect(Math.abs(child.y + child.height - region.y - region.height)).toBeLessThan(1);
    }
  }).toPass();
};

for (const scenario of [
  { width: 1280, height: 600, layout: "long", leftAlignPiano: true },
  { width: 1280, height: 600, layout: "long", leftAlignPiano: false },
  { width: 1280, height: 360, layout: "tall", leftAlignPiano: true },
  { width: 390, height: 450, layout: "long", leftAlignPiano: true },
] as const) {
  test(`all piano rows fit in ${scenario.layout} layout at ${scenario.width}x${scenario.height}, left aligned=${scenario.leftAlignPiano}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    const { layout, leftAlignPiano } = scenario;
    await seedStorage(page, { preferences: { layout, leftAlignPiano } });
    const song = createSong();
    setChannelCount(song, "track", 23);
    await page.goto(`./#${encodeSong(song)}`);
    await expectFullRoll(page);

    await page.setViewportSize({ width: scenario.width, height: scenario.height - 80 });
    await expectFullRoll(page);
    const grid = page.getByTestId("note-grid");
    const bounds = required(await grid.boundingBox());
    const rowCount = await page.locator(".piano-key").count();
    await grid.click({
      position: { x: bounds.width * 0.2, y: bounds.height * (1 - 0.5 / rowCount) },
    });
    await expect(page.getByTestId("note")).toHaveCount(1);
    await expect
      .poll(async () => {
        const saved = decodeSong(await page.evaluate(() => location.hash.slice(1)));
        return required(required(required(saved.channels[0]).patterns[1]).notes[0]).pitches;
      })
      .toEqual([required(song.channels[0]).octave * 12]);
  });
}
