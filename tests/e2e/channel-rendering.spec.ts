import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { createEffect, createInstrument } from "../../src/instruments";
import { createChannel, createSong, required } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";

const readSong = async (page: Page): Promise<ReturnType<typeof createSong>> =>
  decodeSong(await page.evaluate(() => location.hash.slice(1)));
const expectContained = async (container: Locator, items: Locator): Promise<void> => {
  const parent = required(await container.boundingBox());
  for (const item of await items.all()) {
    const box = required(await item.boundingBox());
    expect(box.x).toBeGreaterThanOrEqual(parent.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(parent.x + parent.width + 1);
  }
};

for (const width of [710, 950, 1280]) {
  test(`FM routing, operators and long effect names fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const song = createSong();
    const instrument = createInstrument("FM (n-op)");
    const operator = required(instrument.operators[0]);
    instrument.operators = Array.from({ length: 10 }, (_, index) => ({
      ...operator,
      id: `operator-${index}`,
      carrier: index === 0,
    }));
    instrument.connections = [];
    instrument.effects = [createEffect("Reverb"), createEffect("Frequency Shifter")];
    required(song.channels[0]).instruments = [instrument];
    await page.goto(`./#${encodeSong(song)}`);
    const panel = page.locator(".instrument-settings");
    const routing = panel.locator(".fm-routing");
    await expect(routing.getByRole("button")).toHaveCount(10);
    await expectContained(panel, routing);
    await expectContained(routing, routing.getByRole("button"));
    await expectContained(panel, panel.locator(".operator-row"));
    await expectContained(panel, panel.locator(".operator-row select, .operator-row input"));
    for (const card of await panel.locator(".effects-flow > .effect-card").all()) {
      const heading = card.locator("h4");
      expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await expectContained(card, card.locator(".effect-heading > button"));
    }
    await routing.getByRole("button", { name: "Operator 10 modulator", exact: true }).click();
    await routing.getByRole("button", { name: "Operator 1 carrier", exact: true }).click();
    await expect
      .poll(
        async () =>
          required(required((await readSong(page)).channels[0]).instruments[0]).connections,
      )
      .toEqual([{ from: "operator-9", to: "operator-0" }]);
    await page.keyboard.press("z");
    await expect
      .poll(
        async () =>
          required(required((await readSong(page)).channels[0]).instruments[0]).connections,
      )
      .toEqual([]);
  });
}

test("automation lanes retain readable geometry, pointer values and undo after reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const song = createSong();
  const automation = createChannel("automation");
  automation.cells[0] = 1;
  required(automation.patterns[1]).lanes = [
    {
      id: "tempo-lane",
      target: "tempo",
      enabled: true,
      interpolation: "linear",
      points: [
        { time: 0, value: 150 },
        { time: 8, value: 150 },
      ],
    },
  ];
  song.channels.push(automation);
  await page.goto(`./#${encodeSong(song)}`);
  await page.getByTestId("cell-3-0").click();
  const graph = page.locator(".automation-graph");
  const box = required(await graph.boundingBox());
  expect(box.width).toBeLessThanOrEqual(480);
  expect(box.width / box.height).toBeCloseTo(3.2, 1);
  await graph.click({ position: { x: box.width / 2, y: box.height * 0.1 } });
  await expect
    .poll(
      async () =>
        required(required((await readSong(page)).channels[3]).patterns[1]).lanes[0]?.points.length,
    )
    .toBe(3);
  const changed = required(
    required(required((await readSong(page)).channels[3]).patterns[1]).lanes[0],
  );
  expect(required(changed.points[1]).time).toBe(4);
  expect(required(changed.points[1]).value).toBeGreaterThan(250);
  await page.keyboard.press("z");
  await expect
    .poll(
      async () =>
        required(required((await readSong(page)).channels[3]).patterns[1]).lanes[0]?.points.length,
    )
    .toBe(2);
  await page.keyboard.press("y");
  await page.reload();
  await page.getByTestId("cell-3-0").click();
  expect(
    required(required(required((await readSong(page)).channels[3]).patterns[1]).lanes[0]),
  ).toEqual(changed);
  await expect(page.locator(".automation-points .automation-point")).toHaveCount(3);
});

test("100 channels select rectangular ranges, edit and undo without losing cells or identities", async ({
  page,
}) => {
  const song = createSong();
  song.channels = Array.from({ length: 100 }, (_, index) => {
    const channel = createChannel(index < 70 ? "track" : "automation");
    channel.name = `Channel ${index + 1}`;
    channel.instruments = index < 70 ? [createInstrument()] : [];
    return channel;
  });
  const ids = song.channels.map((channel) => channel.id);
  await page.goto(`./#${encodeSong(song)}`);
  await expect(page.locator(".channel-cell")).toHaveCount(1600);
  await page.getByTestId("cell-99-15").click();
  await expect(page.getByTestId("cell-99-15")).toHaveClass(/current/u);
  await page.getByTestId("cell-0-0").click({ modifiers: ["Shift"] });
  await expect(page.locator('.channel-cell[aria-pressed="true"]')).toHaveCount(1600);
  await page.locator("main").focus();
  await page.keyboard.press("3");
  await expect
    .poll(async () =>
      (await readSong(page)).channels.every((channel) => channel.cells.every((cell) => cell === 3)),
    )
    .toBe(true);
  expect((await readSong(page)).channels.map((channel) => channel.id)).toEqual(ids);
  await page.keyboard.press("z");
  await expect
    .poll(async () => (await readSong(page)).channels.map((channel) => channel.cells))
    .toEqual(song.channels.map((channel) => channel.cells));
  await page.getByTestId("cell-69-2").click();
  await expect(page.locator('.channel-cell[aria-pressed="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Mute Channel 70", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mute Channel 70", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect((await readSong(page)).channels.map((channel) => channel.id)).toEqual(ids);
});
