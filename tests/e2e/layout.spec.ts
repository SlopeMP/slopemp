import { expect, test } from "@playwright/test";

import { createInstrument } from "../../src/instruments";
import { createSong, required } from "../../src/model";
import { encodeSong } from "../../src/storage";
import { seedStorage } from "./stored-state";

test("main actions keep their labels centered and their icons aligned on the left", async ({
  page,
}) => {
  await page.goto("./");
  const actions = [
    page.getByRole("button", { name: "Preferences", exact: true }),
    page.getByRole("button", { name: "Help", exact: true }),
    page.getByRole("combobox", { name: "File menu", exact: true }),
    page.getByRole("combobox", { name: "Edit menu", exact: true }),
  ];
  const iconInsets: number[] = [];
  for (const action of actions) {
    await expect(action).toBeVisible();
    const geometry = await action.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const isMenu = element instanceof HTMLSelectElement;
      const icon = (isMenu ? element.parentElement : element)?.querySelector(
        ".tabler-icon-leading",
      );
      if (!icon) {
        throw new Error("Action is missing its leading icon.");
      }
      const iconBounds = icon.getBoundingClientRect();
      const labelBounds = ((): { left: number; right: number } => {
        if (isMenu) {
          // The native select renders its selected option inside the content box.
          const style = getComputedStyle(element);
          if (style.textAlignLast !== "center") {
            throw new Error("The native menu label is not centered.");
          }
          return {
            left:
              bounds.left +
              Number.parseFloat(style.borderLeftWidth) +
              Number.parseFloat(style.paddingLeft),
            right:
              bounds.right -
              Number.parseFloat(style.borderRightWidth) -
              Number.parseFloat(style.paddingRight),
          };
        }
        const text = [...element.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE && (node.textContent?.trim().length ?? 0) > 0,
        );
        if (!text) {
          throw new Error("Action is missing its label.");
        }
        const range = document.createRange();
        range.selectNodeContents(text);
        return range.getBoundingClientRect();
      })();
      return {
        centerOffset: (labelBounds.left + labelBounds.right - bounds.left - bounds.right) / 2,
        iconInset: iconBounds.left - bounds.left,
        iconWidth: iconBounds.width,
        labelGap: labelBounds.left - iconBounds.right,
      };
    });
    expect(Math.abs(geometry.centerOffset)).toBeLessThan(1);
    expect(geometry.iconWidth).toBeGreaterThan(0);
    expect(geometry.iconInset).toBeGreaterThan(0);
    expect(geometry.labelGap).toBeGreaterThanOrEqual(0);
    iconInsets.push(geometry.iconInset);
  }
  expect(Math.max(...iconInsets) - Math.min(...iconInsets)).toBeLessThan(1);
});

for (const { width, layout } of [
  { width: 950, layout: "long" },
  { width: 1050, layout: "long" },
  { width: 950, layout: "tall" },
  { width: 1280, layout: "tall" },
] as const) {
  test(`stacked settings scroll from top to bottom in ${layout} layout at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 600 });
    await seedStorage(page, { preferences: { layout } });
    const song = createSong();
    required(song.channels[0]).instruments = [createInstrument("FM (n-op)")];
    await page.goto(`./#${encodeSong(song)}`);

    const settings = page.locator(".settings-area");
    await expect(settings).toHaveCSS("scrollbar-width", "none");
    const play = page.getByRole("button", { name: "Play", exact: true });
    const addEnvelope = page.getByRole("button", { name: "Add envelope", exact: true });
    await expect(play).toBeInViewport();
    await expect(addEnvelope).not.toBeInViewport();

    await settings.hover({ position: { x: 2, y: 2 } });
    const scrollDistance = await settings.evaluate((element) => element.scrollHeight);
    await page.mouse.wheel(0, scrollDistance);
    await expect
      .poll(async () => await settings.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(addEnvelope).toBeInViewport();

    await page.mouse.wheel(0, -scrollDistance);
    await expect.poll(async () => await settings.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(play).toBeInViewport();
  });
}

for (const { width, height } of [
  { width: 1280, height: 600 },
  { width: 1600, height: 600 },
  { width: 1280, height: 360 },
]) {
  test(`settings columns scroll independently without visible scrollbars at ${width}×${height}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await seedStorage(page, { preferences: { layout: "long" } });
    const song = createSong();
    required(song.channels[0]).instruments = [createInstrument("FM (n-op)")];
    await page.goto(`./#${encodeSong(song)}`);

    const settings = page.locator(".settings-area");
    const main = page.locator(".main-settings");
    const instrument = page.locator(".instrument-settings");
    for (const panel of [settings, main, instrument]) {
      await expect(panel).toHaveCSS("scrollbar-width", "none");
    }
    for (const name of ["Preferences", "Help"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button).toHaveCSS("height", "26px");
      await expect(button).toBeInViewport();
    }

    for (const [active, stationary] of [
      [main, instrument],
      [instrument, main],
    ] as const) {
      const stationaryTop = required(await stationary.boundingBox()).y;
      const { scrollDistance, maxScroll } = await active.evaluate((element) => ({
        scrollDistance: element.scrollHeight,
        maxScroll: element.scrollHeight - element.clientHeight,
      }));
      expect(maxScroll).toBeGreaterThan(0);
      await active.hover({ position: { x: 2, y: 2 } });

      // Attempt to scroll beyond the top before scrolling to the bottom.
      await page.mouse.wheel(0, -scrollDistance);
      await page.mouse.wheel(0, scrollDistance);
      await expect
        .poll(async () => await active.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(maxScroll - 1);
      expect(await stationary.evaluate((element) => element.scrollTop)).toBe(0);
      expect(required(await stationary.boundingBox()).y).toBe(stationaryTop);
      expect(await settings.evaluate((element) => element.scrollTop)).toBe(0);

      // Attempt to scroll beyond the bottom before returning to the top.
      await page.mouse.wheel(0, scrollDistance);
      await page.mouse.wheel(0, -scrollDistance);
      await expect.poll(async () => await active.evaluate((element) => element.scrollTop)).toBe(0);
      expect(await stationary.evaluate((element) => element.scrollTop)).toBe(0);
      expect(required(await stationary.boundingBox()).y).toBe(stationaryTop);
      expect(await settings.evaluate((element) => element.scrollTop)).toBe(0);
    }
  });
}
