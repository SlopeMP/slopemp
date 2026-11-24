import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createSong } from "../../src/model";
import type { Song } from "../../src/model";
import { copyPatterns } from "../../src/operations";
import { decodeSong, encodeSong, serializePatternClipboard } from "../../src/storage";
import { writeStoredState } from "./stored-state";
const requireValue = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected a saved song value.");
  }
  return value;
};
const readSong = async (page: Page): Promise<Song> =>
  decodeSong(await page.evaluate(() => location.hash.slice(1)));
const saved = async (page: Page): Promise<Song> => {
  await expect.poll(async () => await page.evaluate(() => location.hash.length)).toBeGreaterThan(1);
  await page.waitForTimeout(360);
  return await readSong(page);
};
const command = async (page: Page, name: string): Promise<void> => {
  await page
    .getByRole("combobox", { name: / menu$/u })
    .filter({ has: page.locator(`option[value="${name}"]`) })
    .selectOption(name);
};
const gridClick = async (page: Page, x = 0.1, y = 0.5): Promise<void> => {
  const grid = page.getByTestId("note-grid");
  const box = await grid.boundingBox();
  if (!box) {
    throw new Error("Missing note grid");
  }
  await grid.click({ position: { x: box.width * x, y: box.height * y } });
};
test.beforeEach(async ({ page }) => {
  await page.goto("./");
});

test("initial composition and mandatory control order fill the viewport without errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page).toHaveTitle("SlopeMP");
  await expect(page.getByRole("heading", { name: "SlopeMP", level: 1 })).toHaveCount(0);
  for (const [name, value] of [
    ["Tempo", "150"],
    ["Beats per bar", "8"],
    ["Song length", "16"],
    ["Tracks", "3"],
    ["Automations", "0"],
    ["Max patterns", "8"],
  ] as const) {
    await expect(page.getByRole("spinbutton", { name, exact: true })).toHaveValue(value);
  }
  await expect(page.getByTestId("cell-0-0")).toHaveText("0");
  await expect(page.getByTestId("cell-0-4")).toHaveText("0");
  await expect(page.getByRole("slider", { name: "Octave", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
test("note/chord edits preserve reuse and undo/redo restores the entire gesture", async ({
  page,
}) => {
  const fixture = createSong();
  requireValue(fixture.channels[0]).cells.fill(1, 0, 2);
  await page.goto(`./#${encodeSong(fixture)}`);
  await gridClick(page);
  let song = await saved(page);
  expect(requireValue(requireValue(song.channels[0]).patterns[1]).notes).toHaveLength(1);
  await gridClick(page, 0.1, 0.4);
  song = await saved(page);
  expect(
    requireValue(requireValue(requireValue(song.channels[0]).patterns[1]).notes[0]).pitches,
  ).toHaveLength(2);
  await command(page, "Undo");
  song = await saved(page);
  expect(
    requireValue(requireValue(requireValue(song.channels[0]).patterns[1]).notes[0]).pitches,
  ).toHaveLength(1);
  await command(page, "Redo");
  song = await saved(page);
  expect(
    requireValue(requireValue(requireValue(song.channels[0]).patterns[1]).notes[0]).pitches,
  ).toHaveLength(2);
  await page.getByTestId("cell-0-1").click();
  await expect(page.getByTestId("note")).toHaveCount(2);
});
test("backward note drawing is a single history step and pointer cancel rolls back", async ({
  page,
}) => {
  const box = await page.getByTestId("note-grid").boundingBox();
  if (!box) {
    throw new Error("grid");
  }
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  const song = await saved(page);
  const note = requireValue(requireValue(requireValue(song.channels[0]).patterns[1]).notes[0]);
  expect(note.end - note.start).toBeGreaterThan(2);
  await command(page, "Undo");
  await expect(page.getByTestId("note")).toHaveCount(0);
  await command(page, "Redo");
  await expect(page.getByTestId("note")).toHaveCount(1);
});
test("zero cells allocate notes, clearing assignment retains stored pattern", async ({ page }) => {
  await page.getByTestId("cell-0-4").click();
  await gridClick(page);
  let song = await saved(page);
  const number = requireValue(requireValue(song.channels[0]).cells[4]);
  expect(number).toBeGreaterThan(0);
  expect(requireValue(requireValue(song.channels[0]).patterns[number]).notes).toHaveLength(1);
  await page.locator("main").focus();
  await page.keyboard.press("0");
  song = await saved(page);
  expect(requireValue(song.channels[0]).cells[4]).toBe(0);
  expect(requireValue(requireValue(song.channels[0]).patterns[number]).notes).toHaveLength(1);
});
test("channel rectangle and pattern clipboard keep bar count fixed", async ({ page }) => {
  await gridClick(page);
  await command(page, "Copy");
  await page.getByTestId("cell-1-2").click();
  await command(page, "Paste");
  let song = await saved(page);
  expect(
    requireValue(
      requireValue(song.channels[1]).patterns[
        requireValue(requireValue(song.channels[1]).cells[2])
      ],
    ).notes,
  ).toHaveLength(1);
  expect(song.barCount).toBe(16);
  await page.getByTestId("cell-1-3").click();
  await command(page, "Paste");
  song = await saved(page);
  expect(requireValue(song.channels[1]).cells[3]).toBe(1);
});
test("cut clears assignment without deleting bars and persistent clipboard survives reload", async ({
  page,
}) => {
  await gridClick(page);
  await command(page, "Cut");
  await expect(page.getByTestId("cell-0-0")).toHaveText("0");
  await page.reload();
  await page.getByTestId("cell-1-5").click();
  await command(page, "Paste");
  const song = await saved(page);
  expect(song.barCount).toBe(16);
  expect(
    requireValue(
      requireValue(song.channels[1]).patterns[
        requireValue(requireValue(song.channels[1]).cells[5])
      ],
    ).notes,
  ).toHaveLength(1);
});
test("a delayed clipboard read pastes into the selected destination at the time of the command", async ({
  page,
}) => {
  await gridClick(page);
  const clipboard = copyPatterns(await readSong(page), {
    channelStart: 0,
    channelEnd: 0,
    barStart: 0,
    barEnd: 0,
  });
  await page.evaluate(async (encoded) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("slopemp", 1);
      request.addEventListener("success", () => {
        resolve(request.result);
      });
      request.addEventListener("error", () => {
        reject(request.error ?? new Error("Could not open test storage."));
      });
    });
    const transaction = database.transaction("state", "readwrite");
    const store = transaction.objectStore("state");
    let waiting = true;
    globalThis.addEventListener(
      "release-clipboard-read",
      () => {
        waiting = false;
      },
      { once: true },
    );
    transaction.addEventListener("complete", () => {
      database.close();
    });
    // A new request in each success handler keeps the write transaction open.
    // The editor's read waits for this transaction to commit.
    const keepOpen = (): void => {
      if (waiting) {
        store.get("clipboard.pattern").addEventListener("success", keepOpen, { once: true });
      }
    };
    store.put(encoded, "clipboard.pattern").addEventListener("success", keepOpen);
  }, serializePatternClipboard(clipboard));

  const originalTarget = page.getByTestId("cell-1-2");
  const nextTarget = page.getByTestId("cell-1-3");
  try {
    await originalTarget.click();
    await command(page, "Paste");
    await nextTarget.click();
    await expect(originalTarget).toHaveText("0");
  } finally {
    await page.evaluate(() => {
      globalThis.dispatchEvent(new Event("release-clipboard-read"));
    });
  }
  await expect(originalTarget).toHaveText("1");
  await expect(nextTarget).toHaveText("0");
});
test("track editor paste keeps pattern numbers within the same channel", async ({ page }) => {
  const song = createSong();
  const track = requireValue(song.channels[0]);
  track.cells.splice(0, 6, 2, 1, 3, 4, 3, 0);
  await page.goto(`./#${encodeSong(song)}`);
  await page.reload();

  await expect(page.getByTestId("cell-0-0")).toHaveText("2");
  await gridClick(page);
  await command(page, "Copy");
  await page.getByTestId("cell-0-4").click();
  await command(page, "Paste");
  await expect(page.getByTestId("cell-0-4")).toHaveText("2");

  await page.getByTestId("cell-0-0").click();
  await page.getByTestId("cell-0-1").click({ modifiers: ["Shift"] });
  await command(page, "Copy");
  await page.getByTestId("cell-0-2").click();
  await command(page, "Paste");
  await expect(page.getByTestId("cell-0-2")).toHaveText("2");
  await expect(page.getByTestId("cell-0-3")).toHaveText("1");
  expect(requireValue(requireValue((await saved(page)).channels[0]).patterns[3]).notes).toEqual([]);
});
test("structure edits clamp meter, repair references, and undo shrinking preserves notes", async ({
  page,
}) => {
  await gridClick(page, 0.8, 0.5);
  await page.getByRole("spinbutton", { name: "Beats per bar", exact: true }).fill("2");
  let song = await saved(page);
  expect(song.beatsPerBar).toBe(2);
  expect(requireValue(requireValue(song.channels[0]).patterns[1]).notes).toHaveLength(0);
  await command(page, "Undo");
  song = await saved(page);
  expect(song.beatsPerBar).toBe(8);
  expect(requireValue(requireValue(song.channels[0]).patterns[1]).notes).toHaveLength(1);
  await page.getByRole("spinbutton", { name: "Song length", exact: true }).fill("2");
  song = await saved(page);
  expect(song.loopEnd).toBeLessThanOrEqual(2);
  expect(song.channels.every((t) => t.cells.length === 2)).toBe(true);
});
test("custom scale cancel preserves contents and confirmed mask persists", async ({ page }) => {
  await page.getByRole("combobox", { name: "Scale", exact: true }).selectOption("Custom");
  await expect(page.getByRole("dialog", { name: "Edit Custom Scale" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Scale", exact: true })).toHaveValue("Free");
  await page.getByRole("combobox", { name: "Scale", exact: true }).selectOption("Custom");
  await page.getByRole("dialog").getByRole("checkbox", { name: "C♯", exact: true }).uncheck();
  await page.getByRole("button", { name: "Okay", exact: true }).click();
  const song = await saved(page);
  expect(song.scale).toBe("Custom");
  expect(song.customScale).not.toContain(1);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Scale", exact: true })).toHaveValue("Custom");
});
test("key changes preserve sounding notes; scale and rhythm do not rewrite them", async ({
  page,
}) => {
  await gridClick(page);
  const before = await saved(page);
  const pitch = requireValue(
    requireValue(requireValue(requireValue(before.channels[0]).patterns[1]).notes[0]).pitches[0],
  );
  await page.getByRole("combobox", { name: "Key", exact: true }).selectOption("5");
  await page.getByRole("combobox", { name: "Scale", exact: true }).selectOption("Minor");
  await page.getByRole("combobox", { name: "Rhythm", exact: true }).selectOption("3");
  const after = await saved(page);
  expect(
    requireValue(
      requireValue(requireValue(requireValue(after.channels[0]).patterns[1]).notes[0]).pitches[0],
    ) + after.key,
  ).toBe(pitch);
});
test("preferences apply immediately, persist separately from song, and do not clear redo", async ({
  page,
}) => {
  await gridClick(page);
  await command(page, "Undo");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Preferences" });
  await dialog.getByRole("spinbutton", { name: "Volume", exact: true }).fill("35");
  await expect(dialog.getByRole("slider", { name: "Volume slider", exact: true })).toHaveValue(
    "35",
  );
  await dialog.getByRole("slider", { name: "Volume slider", exact: true }).fill("0");
  await expect(dialog.getByRole("spinbutton", { name: "Volume", exact: true })).toHaveValue("0");
  await dialog.getByRole("switch", { name: "Automatically View Current Bar" }).uncheck();
  await page.keyboard.press("Escape");
  await command(page, "Redo");
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.reload();
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(dialog.getByRole("slider", { name: "Volume slider", exact: true })).toHaveValue("0");
  await expect(
    dialog.getByRole("switch", { name: "Automatically View Current Bar" }),
  ).not.toBeChecked();
});
test("playback moves playheads and preferences/help leave it running", async ({ page }) => {
  await gridClick(page);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".channel-playhead")).toBeVisible();
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Help" })).toBeVisible();
  await expect(page.locator(".channel-playhead")).toBeVisible();
});
test("auto-follow starts at the viewed bar and pause returns to the viewed bar", async ({
  page,
}) => {
  await page.getByTestId("cell-1-6").click();
  await expect(page.locator(".speaker span")).toHaveText("7:1");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".playhead")).toHaveCount(1);
  await expect(page.locator(".channel-cell.current")).toHaveAttribute("data-testid", "cell-1-6");
  await page.getByTestId("cell-1-9").click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".speaker span")).toHaveText("10:1");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".speaker span")).toHaveText(/^10:/u);
});
test("auto-follow permits browsing until a bar boundary and scrolls the playing bar into view", async ({
  page,
}) => {
  await page.getByRole("spinbutton", { name: "Song length", exact: true }).fill("64");
  await page.getByRole("spinbutton", { name: "Tempo", exact: true }).fill("120");
  await page.getByRole("spinbutton", { name: "Beats per bar", exact: true }).fill("4");
  const song = await saved(page);
  song.loopEnd = song.barCount;
  await page.goto(`./#${encodeSong(song)}`);
  await page.getByTestId("cell-1-32").click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  // Selecting another bar must not seek or immediately snap back to playback.
  await page.getByTestId("cell-1-34").click();
  await page.waitForTimeout(250);
  await expect(page.locator(".channel-cell.current")).toHaveAttribute("data-testid", "cell-1-34");
  await expect(page.locator(".playhead")).toHaveCount(0);
  await page.locator(".arrangement-scroll").evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect(page.locator(".channel-cell.current")).toHaveAttribute("data-testid", "cell-1-33");
  await expect(page.locator(".playhead")).toHaveCount(1);
  expect(
    await page.locator(".arrangement-scroll").evaluate((element) => {
      const cell = element.querySelector(".channel-cell.current");
      if (!cell) {
        return false;
      }
      const viewport = element.getBoundingClientRect();
      const bounds = cell.getBoundingClientRect();
      return bounds.left >= viewport.left && bounds.right <= viewport.left + element.clientWidth;
    }),
  ).toBe(true);
});
test("disabling auto-follow keeps selection and playback independent", async ({ page }) => {
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await page.getByRole("switch", { name: "Automatically View Current Bar" }).uncheck();
  await page.keyboard.press("Escape");
  await page.getByTestId("cell-1-6").click();
  await expect(page.locator(".speaker span")).toHaveText("1:1");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".channel-playhead")).toBeVisible();
  await expect(page.locator(".channel-cell.current")).toHaveAttribute("data-testid", "cell-1-6");
  await expect(page.locator(".playhead")).toHaveCount(0);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".speaker span")).toHaveText("1:1");
});
test("recording locks the entire editor, captures physical keys, and commits one undo step", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await page
    .getByRole("switch", { name: "Count-in one bar of metronome before recording" })
    .uncheck();
  await page.getByRole("switch", { name: "Hear metronome while recording" }).uncheck();
  await page.getByRole("button", { name: "Key Bindings", exact: true }).click();
  await page.getByRole("switch", { name: "Unbound keys play notes", exact: true }).check();
  await page.keyboard.press("Escape");
  await page.locator("main").focus();
  await page.keyboard.press("Control+p");
  await expect(page.getByRole("button", { name: "Stop Recording", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Preferences", exact: true })).toBeDisabled();
  await expect(page.getByRole("spinbutton", { name: "Tempo", exact: true })).toBeDisabled();
  await page.keyboard.down("KeyF");
  await page.waitForTimeout(200);
  await page.keyboard.up("KeyF");
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Preferences", exact: true })).toBeEnabled();
  const song = await saved(page);
  expect(
    requireValue(
      requireValue(song.channels[0]).patterns[
        requireValue(requireValue(song.channels[0]).cells[0])
      ],
    ).notes.length,
  ).toBeGreaterThan(0);
  await command(page, "Undo");
  await expect(page.getByTestId("note")).toHaveCount(0);
});
test("Binary song export uses finite loop choices, downloads and can be imported undoably", async ({
  page,
}) => {
  await gridClick(page);
  await command(page, "Export Song");
  await page.getByRole("combobox", { name: "File Type", exact: true }).selectOption("slopemp");
  await page.getByRole("spinbutton", { name: "Loop Count", exact: true }).fill("2");
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const file = await waiting;
  expect(file.suggestedFilename()).toBe("Song.slopemp");
  const path = await file.path();
  if (!path) {
    throw new Error("No download");
  }
  await command(page, "New Blank Song");
  await expect(page.getByTestId("note")).toHaveCount(0);
  await command(page, "Import Song");
  await page.getByLabel("Song file").setInputFiles(path);
  const song = await saved(page);
  expect(song.barCount).toBe(20);
  await expect(page.getByTestId("note")).toHaveCount(1);
  await command(page, "Undo");
  await expect(page.getByTestId("note")).toHaveCount(0);
});
test("corrupt imports report failure and preserve song contents", async ({ page }) => {
  await gridClick(page);
  await saved(page);
  await command(page, "Import Song");
  await page.getByLabel("Song file").setInputFiles({
    name: "bad.slopemp",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("{broken"),
  });
  await expect(page.getByRole("status")).toContainText("Import failed");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("note")).toHaveCount(1);
});
test("an invalid asset URL reports a load error and closing discards the draft", async ({
  page,
}) => {
  const baseline = (await saved(page)).resources.length;
  await command(page, "Add Assets");
  const dialog = page.getByRole("dialog", { name: "Add Assets", exact: true });
  await dialog.getByRole("button", { name: "Add Asset", exact: true }).click();
  const url = dialog.getByRole("textbox", { name: `Asset ${baseline + 1} URL`, exact: true });
  await url.fill("not-a-url");
  await url.blur();
  await expect(dialog.getByRole("alert")).toContainText("http");
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  expect((await saved(page)).resources).toHaveLength(baseline);
});
test("changing an asset URL releases its pending load and allows a replacement", async ({
  page,
}) => {
  const original = new URL("./pending-sample.wav", page.url()).href;
  const release = Promise.withResolvers<undefined>();
  await page.route(original, async (route) => {
    await release.promise;
    await route.fulfill({ status: 404 });
  });
  await command(page, "Add Assets");
  const dialog = page.getByRole("dialog", { name: "Add Assets", exact: true });
  await dialog.getByRole("button", { name: "Add Asset", exact: true }).click();
  const asset = dialog.locator(".resource-entry").last();
  const url = asset.getByRole("textbox", { name: /Asset \d+ URL$/u });
  const okay = dialog.getByRole("button", { name: "Okay", exact: true });
  try {
    await expect(okay).toBeEnabled();
    await url.fill(original);
    await url.blur();
    await expect(asset.getByText("Loading…", { exact: true })).toBeVisible();
    await okay.click();
    await expect(okay).toBeDisabled();

    const replacement = new URL("./test-assets/flute-C4.wav", page.url()).href;
    await page.route(replacement, async (route) => {
      await route.fulfill({ path: new URL("../assets/flute-C4.wav", import.meta.url).pathname });
    });
    await url.fill(replacement);
    await expect(okay).toBeEnabled();
    await url.blur();
    await expect(asset.getByText("Ready", { exact: true })).toBeVisible();
    await expect(okay).toBeEnabled();
    await okay.click();
    const entry = requireValue((await saved(page)).resources.at(-1));
    expect(entry.url).toBe(replacement);
    expect(entry).not.toHaveProperty("name");
    expect(entry).not.toHaveProperty("type");
  } finally {
    release.resolve(undefined);
  }
});
test("mute is temporary and is absent from shared song content", async ({ page }) => {
  await page.getByRole("button", { name: "Mute Track 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mute Track 1", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Mute Track 1", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
test("URL sharing restores editable notes with local preferences independent", async ({
  page,
  context,
}) => {
  await gridClick(page);
  await saved(page);
  const url = page.url();
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByTestId("note")).toHaveCount(1);
  await expect(other.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await other.close();
});
test("mobile layout scrolls to settings, preserves grid and has no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("note-grid")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Channel arrangement", exact: true }),
  ).toBeVisible();
  await page.getByRole("spinbutton", { name: "Song length", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("spinbutton", { name: "Song length", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("cancelling a live note gesture restores contents and does not add undo history", async ({
  page,
}) => {
  const grid = page.getByTestId("note-grid");
  const box = await grid.boundingBox();
  if (box === null) {
    throw new Error("Missing grid.");
  }
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 4 });
  await expect(page.getByTestId("note")).toHaveCount(1);
  await grid.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse" });
  await page.mouse.up();
  await expect(page.getByTestId("note")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Edit menu" }).locator('option[value="Undo"]'),
  ).toBeDisabled();
});

test("current arrangement cell increments and decrements without changing another row", async ({
  page,
}) => {
  const cell = page.getByTestId("cell-0-0");
  const box = await cell.boundingBox();
  if (box === null) {
    throw new Error("Missing current cell.");
  }
  await cell.click({ position: { x: box.width / 2, y: 3 } });
  await expect(cell).toHaveText("1");
  await cell.click({ position: { x: box.width / 2, y: box.height - 3 } });
  await expect(cell).toHaveText("0");
  await expect(page.getByTestId("cell-1-0")).toHaveText("0");
});

test("loop boundaries swap when crossed and an outside click moves the full loop", async ({
  page,
}) => {
  const strip = page.getByRole("slider", { name: "Loop region", exact: true });
  const bounds = await strip.boundingBox();
  if (bounds === null) {
    throw new Error("Missing loop strip.");
  }
  await page.mouse.move(bounds.x + 32, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 6 * 32, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const song = await readSong(page);
      return [song.loopStart, song.loopEnd];
    })
    .toEqual([4, 5]);
  await command(page, "Undo");
  await expect
    .poll(async () => {
      const song = await readSong(page);
      return [song.loopStart, song.loopEnd];
    })
    .toEqual([0, 4]);
  await strip.click({ position: { x: 12 * 32, y: bounds.height / 2 } });
  await expect
    .poll(async () => {
      const song = await readSong(page);
      return [song.loopStart, song.loopEnd];
    })
    .toEqual([10, 14]);
});

test("control press and release feedback follows pointer and keyboard activation", async ({
  page,
}) => {
  const mute = page.getByRole("button", { name: "Mute Track 1", exact: true });
  await mute.hover();
  await expect(mute).toHaveCSS("background-color", "rgb(41, 42, 50)");
  await page.mouse.down();
  await expect(mute).toHaveCSS("background-color", "rgb(18, 19, 23)");
  await page.mouse.up();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect(mute).toHaveCSS("background-color", "rgb(137, 103, 198)");
  await mute.focus();
  await page.keyboard.down("Space");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(mute).not.toHaveClass(/pressed/u);
  await page.keyboard.up("Space");
});

test("transport keeps bar buttons fixed through playback and recording", async ({ page }) => {
  await writeStoredState(page, { preferences: { countIn: false } });
  await page.reload();
  const previous = page.getByRole("button", { name: "Previous bar", exact: true });
  const next = page.getByRole("button", { name: "Next bar", exact: true });
  const initial = [await previous.boundingBox(), await next.boundingBox()];
  const expectFixed = async (): Promise<void> => {
    expect([await previous.boundingBox(), await next.boundingBox()]).toEqual(initial);
  };
  await expect(page.getByRole("button", { name: "Record", exact: true })).toBeVisible();
  const playBox = await page.getByRole("button", { name: "Play", exact: true }).boundingBox();
  const recordBox = await page.getByRole("button", { name: "Record", exact: true }).boundingBox();
  expect(playBox?.width).toBe(recordBox?.width);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record", exact: true })).toBeHidden();
  await expectFixed();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expectFixed();
  await page.getByRole("button", { name: "Record", exact: true }).click();
  const stop = page.getByRole("button", { name: "Stop Recording", exact: true });
  await expect(stop).toBeFocused();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeHidden();
  await expectFixed();
  await stop.click();
  await expect(page.getByRole("button", { name: "Record", exact: true })).toBeVisible();
  await expectFixed();
});

test("dragging a note past the left edge ties it, with undo and persistence", async ({ page }) => {
  await gridClick(page, 0.02, 0.5);
  await expect(page.getByTestId("tie-over")).toHaveCount(0);
  const grid = requireValue((await page.getByTestId("note-grid").boundingBox()) ?? undefined);
  await page.mouse.move(grid.x + grid.width * 0.015, grid.y + grid.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(grid.x - 30, grid.y + grid.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("tie-over")).toHaveCount(1);
  let song = await saved(page);
  expect(song.channels[0]?.patterns[1]?.notes[0]?.continues).toBe(true);
  await command(page, "Undo");
  await expect(page.getByTestId("tie-over")).toHaveCount(0);
  await command(page, "Redo");
  await expect(page.getByTestId("tie-over")).toHaveCount(1);
  song = await saved(page);
  await page.reload();
  await expect(page.getByTestId("tie-over")).toHaveCount(1);
  expect((await saved(page)).channels[0]?.patterns[1]?.notes[0]?.continues).toBe(
    song.channels[0]?.patterns[1]?.notes[0]?.continues,
  );
});

test("drawing backwards beyond the bar creates a tied note", async ({ page }) => {
  const grid = requireValue((await page.getByTestId("note-grid").boundingBox()) ?? undefined);
  await page.mouse.move(grid.x + grid.width * 0.15, grid.y + grid.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(grid.x - 30, grid.y + grid.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("tie-over")).toHaveCount(1);
  expect((await saved(page)).channels[0]?.patterns[1]?.notes[0]?.continues).toBe(true);
});

test("a tied note must cross past zero again after dragging right", async ({ page }) => {
  await gridClick(page, 0.02, 0.5);
  const grid = requireValue((await page.getByTestId("note-grid").boundingBox()) ?? undefined);
  const song = await saved(page);
  const step = grid.width / song.beatsPerBar / song.rhythm;
  const startX = grid.x + 2;
  const y = grid.y + grid.height * 0.5;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX - step * 2, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("tie-over")).toHaveCount(1);

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + step, y, { steps: 5 });
  await expect(page.getByTestId("tie-over")).toHaveCount(0);
  await page.mouse.move(startX, y, { steps: 5 });
  await expect(page.getByTestId("tie-over")).toHaveCount(0);
  await page.mouse.move(startX - step, y, { steps: 5 });
  await expect(page.getByTestId("tie-over")).toHaveCount(1);
  await page.mouse.up();
  expect((await saved(page)).channels[0]?.patterns[1]?.notes[0]?.continues).toBe(true);
});

test("bending ramps, holds, extends, and commits one undo step", async ({ page }) => {
  await gridClick(page);
  const before = await saved(page);
  const original = requireValue(
    requireValue(requireValue(before.channels[0]).patterns[1]).notes[0],
  );
  const box = requireValue((await page.getByTestId("note-grid").boundingBox()) ?? undefined);
  const x = box.x + box.width * 0.1;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Lock the vertical gesture before extending it horizontally.
  await page.mouse.move(x + 1, y - 40, { steps: 5 });
  await page.mouse.move(x + box.width * 0.2, y - 65, { steps: 12 });
  await page.mouse.up();
  const after = await saved(page);
  const bent = requireValue(requireValue(requireValue(after.channels[0]).patterns[1]).notes[0]);
  expect(bent.end).toBeGreaterThan(original.end);
  expect(bent.pins.some((pin) => pin.interval > 0)).toBe(true);
  expect(bent.pins[0]?.interval).toBe(0);
  expect(new Set(bent.pins.map((pin) => pin.time)).size).toBe(bent.pins.length);
  await command(page, "Undo");
  expect(requireValue(requireValue((await saved(page)).channels[0]).patterns[1]).notes).toEqual([
    original,
  ]);
  await command(page, "Redo");
  expect(requireValue(requireValue((await saved(page)).channels[0]).patterns[1]).notes).toEqual([
    bent,
  ]);
});
