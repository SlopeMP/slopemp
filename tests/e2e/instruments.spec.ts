import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import {
  createEffect,
  createEnvelope,
  createInstrument,
  presetInstrument,
} from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";

const chooseType = async (page: Page, type: string): Promise<void> => {
  await page.locator(".instrument-panel .type-button").click();
  const dialog = page.getByRole("dialog", { name: "Choose instrument type" });
  await dialog.getByRole("button", { name: "Custom Instruments", exact: true }).click();
  await dialog.getByRole("button", { name: type, exact: true }).click();
  await expect(dialog).not.toBeVisible();
};

test.beforeEach(async ({ page }) => {
  // Start routing/effect tests with a known graph and an empty effect chain.
  const song = createSong();
  for (const channel of song.channels) {
    channel.instruments = [createInstrument()];
  }
  await page.goto(`./#${encodeSong(song)}`);
});

test("instrument preset browsing preserves mix volume and cancellation preserves the sound", async ({
  page,
}) => {
  const panel = page.getByRole("region", { name: "Instrument Settings", exact: true });
  const volume = panel.getByRole("spinbutton", { name: "Volume %", exact: true });
  await volume.fill("37");
  await volume.press("Enter");
  await page.locator(".instrument-panel .type-button").click();
  const dialog = page.getByRole("dialog", { name: "Choose instrument type" });
  await expect(dialog.locator("button .tabler-icon-leading")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Keyboard", exact: true }).click();
  await dialog.getByRole("button", { name: "grand piano", exact: true }).click();
  await expect(page.locator(".type-button")).toHaveText("grand piano");
  await expect(volume).toHaveValue("37");
  await page.locator(".type-button").click();
  await dialog.getByRole("button", { name: "Novelty", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".type-button")).toHaveText("grand piano");
  await expect(volume).toHaveValue("37");
});

test("instrument search filters group names and preset names independently", async ({ page }) => {
  await page.locator(".instrument-panel .type-button").click();
  const dialog = page.getByRole("dialog", { name: "Choose instrument type" });
  const sidebar = dialog.getByRole("navigation", { name: "Instrument categories" });
  const search = dialog.getByRole("searchbox", { name: "Search instrument categories" });
  await expect(search).toBeFocused();
  await sidebar.getByRole("button", { name: "Keyboard", exact: true }).click();

  await search.fill("  GUITAR ");
  await expect(sidebar.getByRole("button")).toHaveText(["All", "Guitar"]);
  const distortion = dialog.getByRole("region", { name: "Distortion", exact: true });
  await expect(distortion.getByRole("button")).toHaveText([
    "overdrive guitar",
    "distortion guitar",
    "guitar harmonics",
  ]);

  await search.fill("grand piano");
  await expect(sidebar.getByRole("button")).toHaveText(["All"]);
  const keyboard = dialog.getByRole("region", { name: "Keyboard", exact: true });
  await expect(keyboard.getByRole("button")).toHaveText(["grand piano"]);

  await search.fill("Keyboard");
  await expect(sidebar.getByRole("button")).toHaveText(["All", "Keyboard"]);
  await expect(keyboard).toHaveCount(0);

  await search.clear();
  await expect(sidebar.getByRole("button", { name: "Keyboard", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(keyboard.getByRole("button", { name: "bright piano", exact: true })).toBeVisible();
});

test("FM replaces the oscillator type and keeps independent custom cycles and tuning after reload", async ({
  page,
}) => {
  await page.locator(".instrument-panel .type-button").click();
  const dialog = page.getByRole("dialog", { name: "Choose instrument type" });
  await dialog.getByRole("button", { name: "Custom Instruments", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "3x Oscillator", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "FM (n-op)", exact: true }).click();
  const fm = page.locator(".fm-editor");
  const first = fm.getByRole("region", { name: "Operator 1", exact: true });
  await first.getByRole("spinbutton", { name: "Coarse semitones", exact: true }).fill("-12");
  await first.getByRole("spinbutton", { name: "Coarse semitones", exact: true }).press("Enter");
  const second = fm.getByRole("region", { name: "Operator 2", exact: true });
  await second.getByRole("spinbutton", { name: "Amplitude %", exact: true }).fill("63");
  await second.getByRole("spinbutton", { name: "Amplitude %", exact: true }).press("Enter");
  await second.getByRole("combobox", { name: "Wave", exact: true }).selectOption("Custom");
  const drawing = second.getByRole("button", { name: "Operator 2 Custom wave", exact: true });
  await drawing.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await expect
    .poll(
      async () =>
        required(
          required(
            required(decodeSong(await page.evaluate(() => location.hash.slice(1))).channels[0])
              .instruments[0],
          ).operators[1],
        ).customWave[1],
    )
    .toBe(3);
  await page.reload();
  await expect(
    first.getByRole("spinbutton", { name: "Coarse semitones", exact: true }),
  ).toHaveValue("-12");
  await expect(second.getByRole("spinbutton", { name: "Amplitude %", exact: true })).toHaveValue(
    "63",
  );
  await expect(second.getByRole("combobox", { name: "Wave", exact: true })).toHaveValue("Custom");
  await expect(first.getByRole("combobox", { name: "Wave", exact: true })).toHaveValue("sine");
});

test("Quick Effects repeat independently and Monoize has no parameters", async ({ page }) => {
  const panel = page.getByRole("region", { name: "Instrument Settings", exact: true });
  const addEffect = panel.getByRole("combobox", { name: "Add Effect", exact: true });
  await panel.getByRole("button", { name: "Add Effect…", exact: true }).click();
  await expect(addEffect).toHaveValue("");
  await addEffect.selectOption("Echo");
  await expect(addEffect).toHaveValue("");
  await page
    .getByRole("dialog", { name: "Add Effect", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  let cards = panel
    .locator(".effect-card")
    .filter({ has: page.getByRole("heading", { name: "Echo", exact: true }) });
  await cards.first().getByRole("spinbutton", { name: "Feedback %", exact: true }).fill("62");
  await cards.first().getByRole("spinbutton", { name: "Feedback %", exact: true }).press("Enter");
  const paste = panel.getByRole("button", { name: "Paste Effect", exact: true });
  await expect(paste).toBeDisabled();
  await cards.first().getByRole("button", { name: "Copy Echo", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await paste.click();
  await expect(cards).toHaveCount(2);
  await expect(
    cards.last().getByRole("spinbutton", { name: "Feedback %", exact: true }),
  ).toHaveValue("62");
  await cards.last().getByRole("spinbutton", { name: "Feedback %", exact: true }).fill("17");
  await cards.last().getByRole("spinbutton", { name: "Feedback %", exact: true }).press("Enter");
  await expect(
    cards.first().getByRole("spinbutton", { name: "Feedback %", exact: true }),
  ).toHaveValue("62");
  await cards.last().getByRole("button", { name: "Bypass Echo 2", exact: true }).click();
  await expect(
    cards.last().getByRole("button", { name: "Bypass Echo 2", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: "Add Effect…", exact: true }).click();
  await expect(addEffect).toHaveValue("");
  await addEffect.selectOption("Monoize");
  await page
    .getByRole("dialog", { name: "Add Effect", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  const mono = panel
    .locator(".effect-card")
    .filter({ has: page.getByRole("heading", { name: "Monoize", exact: true }) });
  await expect(mono.getByRole("spinbutton")).toHaveCount(0);
  await expect(mono.getByRole("combobox")).toHaveCount(0);
  await cards.last().getByRole("button", { name: "Remove Echo", exact: true }).click();
  cards = panel
    .locator(".effect-card")
    .filter({ has: page.getByRole("heading", { name: "Echo", exact: true }) });
  await expect(cards).toHaveCount(1);
});

test("the chip Wave picker keeps its wave when opening and closing Add Assets", async ({
  page,
}) => {
  await chooseType(page, "chip wave");
  const wave = page.getByRole("combobox", { name: "Wave", exact: true });
  await wave.selectOption("square");
  const assets = page.getByRole("dialog", { name: "Add Assets", exact: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    await wave.selectOption("add");
    await expect(assets).toBeVisible();
    await expect(wave).toHaveValue("square");
    await assets.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(assets).toHaveCount(0);
  }
});

test("Chorus has one persistent percentage slider", async ({ page }) => {
  const panel = page.getByRole("region", { name: "Instrument Settings", exact: true });
  await panel.getByRole("button", { name: "Add Effect…", exact: true }).click();
  await panel.getByRole("combobox", { name: "Add Effect", exact: true }).selectOption("Chorus");
  await page
    .getByRole("dialog", { name: "Add Effect", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  const card = panel
    .locator(".effect-card")
    .filter({ has: page.getByRole("heading", { name: "Chorus", exact: true }) });
  const slider = card.getByRole("slider", { name: "Chorus slider", exact: true });
  await expect(card.getByRole("slider")).toHaveCount(1);
  await expect(card.getByRole("combobox")).toHaveCount(0);
  await expect(slider).toHaveAttribute("min", "0");
  await expect(slider).toHaveAttribute("max", "100");
  await expect(slider).toHaveAttribute("step", "1");
  await expect(slider).toHaveValue("100");
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveValue("99");
  await page.reload();
  await expect(slider).toHaveValue("99");
  const song = decodeSong(await page.evaluate(() => location.hash.slice(1)));
  const instrument = required(required(song.channels[0]).instruments[0]);
  expect(required(instrument.effects[0]).parameters).toEqual({ amount: 99 });
});

test("FM rejects cyclic algorithm routes and allows explicit feedback", async ({ page }) => {
  await chooseType(page, "FM (n-op)");
  const canvas = page.locator(".fm-routing");
  const carrier = canvas.getByRole("button", { name: "Operator 1 carrier", exact: true });
  await carrier.click();
  await canvas.getByRole("button", { name: "Operator 2 modulator", exact: true }).click();
  await expect(
    page.getByText("A modulation connection cannot form a cycle. Use Feedback for return routes."),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "FM routing mode", exact: true })
    .selectOption("Feedback");
  await carrier.click();
  await carrier.click();
  await expect(canvas.locator("path[marker-end]")).toHaveCount(1);
  await page.getByRole("button", { name: "Add operator", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operator 5", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove operator", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operator 5", exact: true })).not.toBeVisible();
});

test("FM exposes wave controls and numeric sliders with persistent operator settings", async ({
  page,
}) => {
  await chooseType(page, "FM (n-op)");
  const fm = page.locator(".fm-editor");
  const first = fm.getByRole("region", { name: "Operator 1", exact: true });
  await expect(first.getByRole("combobox", { name: "Wave", exact: true })).toBeVisible();
  await expect(fm.locator("details")).toHaveCount(0);
  await expect(first.getByRole("combobox")).toHaveCount(1);
  await expect(first.getByRole("slider")).toHaveCount(9);
  await expect(first.getByRole("spinbutton")).toHaveCount(9);
  await first.getByRole("spinbutton", { name: "Ratio", exact: true }).fill("0.375");
  await first.getByRole("spinbutton", { name: "Ratio", exact: true }).press("Enter");
  await first.getByRole("spinbutton", { name: "Offset Hz", exact: true }).fill("-1.3");
  await first.getByRole("spinbutton", { name: "Offset Hz", exact: true }).press("Enter");
  await first.getByRole("spinbutton", { name: "Coarse semitones", exact: true }).fill("-12");
  await first.getByRole("spinbutton", { name: "Coarse semitones", exact: true }).press("Enter");
  await first.getByRole("spinbutton", { name: "Fine cents", exact: true }).fill("27");
  await first.getByRole("spinbutton", { name: "Fine cents", exact: true }).press("Enter");
  await first.getByRole("spinbutton", { name: "Pan %", exact: true }).fill("-35");
  await first.getByRole("spinbutton", { name: "Pan %", exact: true }).press("Enter");
  await first.getByRole("spinbutton", { name: "Phase °", exact: true }).fill("120");
  await first.getByRole("spinbutton", { name: "Phase °", exact: true }).press("Enter");
  await first.getByRole("spinbutton", { name: "Stereo phase °", exact: true }).fill("-90");
  await first.getByRole("spinbutton", { name: "Stereo phase °", exact: true }).press("Enter");
  await first.getByRole("spinbutton", { name: "Stereo detune cents", exact: true }).fill("24");
  await first.getByRole("spinbutton", { name: "Stereo detune cents", exact: true }).press("Enter");
  await first.getByRole("switch", { name: "Invert", exact: true }).check();
  await first.getByRole("combobox", { name: "Wave", exact: true }).selectOption("pulse width");
  const width = first.getByRole("spinbutton", { name: "Pulse Width %", exact: true });
  await expect(width).toBeVisible();
  await width.fill("37.5");
  await width.press("Enter");
  const amplitude = first.getByRole("slider", { name: "Amplitude slider", exact: true });
  await amplitude.focus();
  await amplitude.press("Home");
  await amplitude.press("ArrowRight");
  await expect(first.getByRole("spinbutton", { name: "Amplitude %", exact: true })).toHaveValue(
    "1",
  );
  await fm.getByRole("spinbutton", { name: "Phase Randomness %", exact: true }).fill("42");
  await fm.getByRole("spinbutton", { name: "Phase Randomness %", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Add envelope", exact: true }).click();
  const target = page.locator(".envelope-section").last().getByRole("combobox").first();
  await expect(target.locator("option").filter({ hasText: "Operator 1 stereoDetune" })).toHaveCount(
    1,
  );
  await expect(target.locator("option").filter({ hasText: "Operator 1 pulseWidth" })).toHaveCount(
    1,
  );
  await page.reload();
  for (const [name, value] of [
    ["Ratio", "0.375"],
    ["Offset Hz", "-1.3"],
    ["Coarse semitones", "-12"],
    ["Fine cents", "27"],
    ["Pan %", "-35"],
    ["Phase °", "120"],
    ["Stereo phase °", "-90"],
    ["Stereo detune cents", "24"],
    ["Pulse Width %", "37.5"],
  ] as const) {
    await expect(first.getByRole("spinbutton", { name, exact: true })).toHaveValue(value);
  }
  await expect(first.getByRole("switch", { name: "Invert", exact: true })).toBeChecked();
  await expect(fm.getByRole("spinbutton", { name: "Phase Randomness %", exact: true })).toHaveValue(
    "42",
  );
  await page.getByRole("button", { name: "Add operator", exact: true }).click();
  const added = fm.getByRole("region", { name: "Operator 5", exact: true });
  await expect(added.getByRole("spinbutton", { name: "Amplitude %", exact: true })).toHaveValue(
    "0",
  );
  await expect(added.getByRole("spinbutton", { name: "Pan %", exact: true })).toHaveValue("0");
  await expect(added.getByRole("spinbutton", { name: "Ratio", exact: true })).toHaveValue("1");
  await added.getByRole("combobox", { name: "Wave", exact: true }).selectOption("white noise");
  await page.reload();
  await expect(added.getByRole("combobox", { name: "Wave", exact: true })).toHaveValue(
    "white noise",
  );
});

test("envelopes expand independently and retain values outside slider limits", async ({ page }) => {
  await chooseType(page, "chip wave");
  const existing = page.getByRole("button", { name: /^Delete envelope \d+$/u });
  while ((await existing.count()) > 0) {
    await existing.first().click();
  }
  await page.getByRole("button", { name: "Add envelope", exact: true }).click();
  await page.getByRole("button", { name: "Add envelope", exact: true }).click();
  const envelopes = page.locator(".envelope-section");
  await expect(envelopes).toHaveCount(2);
  await expect(
    envelopes.first().getByRole("combobox", { name: "Time basis", exact: true }),
  ).toHaveValue("beats");
  await envelopes
    .first()
    .getByRole("combobox", { name: "Envelope 1 type", exact: true })
    .selectOption("Sine");
  await expect(envelopes.first().getByRole("combobox", { name: "Clock", exact: true })).toHaveValue(
    "song synchronized",
  );
  await envelopes.first().getByRole("textbox", { name: "A", exact: true }).fill("7.25");
  await envelopes.first().getByRole("textbox", { name: "A", exact: true }).press("Tab");
  await envelopes.first().getByRole("button", { name: "Collapse envelope 1", exact: true }).click();
  await expect(
    envelopes.first().getByRole("textbox", { name: "A", exact: true }),
  ).not.toBeVisible();
  await expect(envelopes.last().getByRole("textbox", { name: "A", exact: true })).toBeVisible();
  await envelopes.first().getByRole("button", { name: "Expand envelope 1", exact: true }).click();
  await expect(envelopes.first().getByRole("textbox", { name: "A", exact: true })).toHaveValue(
    "7.25",
  );
});

test("envelope target selection follows effects through removal and undo", async ({ page }) => {
  const song = createSong();
  const instrument = createInstrument("chip wave");
  const echo = createEffect("Echo");
  const feedback = `effect:${echo.id}:feedback`;
  instrument.effects = [createEffect("Soft Clipping"), echo];
  instrument.envelopes = [{ ...createEnvelope(), target: feedback }];
  required(song.channels[0]).instruments = [instrument];
  await page.goto(`./#${encodeSong(song)}`);

  const target = page.getByRole("combobox", { name: "Envelope 1 target", exact: true });
  const selected = target.locator("option:checked");
  const edit = page.getByRole("combobox", { name: "Edit menu", exact: true });
  await expect(target).toHaveValue(feedback);
  await expect(selected).toHaveText("2. Echo: Feedback");

  await page.getByRole("button", { name: "Remove Soft Clipping", exact: true }).click();
  await expect(target).toHaveValue(feedback);
  await expect(selected).toHaveText("1. Echo: Feedback");

  await page.getByRole("button", { name: "Remove Echo", exact: true }).click();
  await expect(selected).toHaveText("None");

  await edit.selectOption("Undo");
  await expect(target).toHaveValue(feedback);
  await expect(selected).toHaveText("1. Echo: Feedback");

  await edit.selectOption("Undo");
  await expect(target).toHaveValue(feedback);
  await expect(selected).toHaveText("2. Echo: Feedback");
});

test("Automation lane targets can be changed independently and rebound after effect removal", async ({
  page,
}) => {
  await page.getByRole("spinbutton", { name: "Automations", exact: true }).fill("1");
  await page.getByRole("spinbutton", { name: "Automations", exact: true }).press("Enter");
  await page.getByTestId("cell-3-4").click();
  const panel = page.getByRole("region", { name: "Automation Settings", exact: true });
  const addLane = panel.getByRole("button", { name: "Add automation lane", exact: true });
  const lanes = panel.getByRole("region", { name: "Automation lane", exact: true });
  const firstTarget = lanes.nth(0).getByRole("combobox", { name: "Target", exact: true });
  await addLane.click();
  await expect(firstTarget).toHaveValue("volume");
  await firstTarget.selectOption("tempo");
  await expect(page.getByTestId("cell-3-4")).toHaveAccessibleName(/bar 5, pattern [1-9]/u);
  await panel.getByRole("spinbutton", { name: "Point 1 value", exact: true }).fill("210");
  await panel.getByRole("spinbutton", { name: "Point 1 value", exact: true }).press("Enter");
  await page.getByTestId("cell-3-0").click();
  await expect(lanes).toHaveCount(0);
  await page.getByTestId("cell-3-4").click();
  await expect(panel.getByRole("spinbutton", { name: "Point 1 value", exact: true })).toHaveValue(
    "210",
  );
  await panel.getByRole("button", { name: "Add Effect…", exact: true }).click();
  await panel.getByRole("combobox", { name: "Add Effect", exact: true }).selectOption("Echo");
  await page
    .getByRole("dialog", { name: "Add Effect", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(firstTarget).toHaveValue("tempo");
  await addLane.click();
  const target = lanes.nth(1).getByRole("combobox", { name: "Target", exact: true });
  const effectOption = await target
    .locator("option")
    .filter({ hasText: "Echo: Feedback" })
    .getAttribute("value");
  expect(effectOption).not.toBeNull();
  await target.selectOption(effectOption ?? "");
  await expect(target).toHaveValue(effectOption ?? "");
  await expect(firstTarget).toHaveValue("tempo");
  await panel.getByRole("button", { name: "Remove Echo", exact: true }).click();
  await expect(target).toHaveValue("");
  await target.selectOption("nextBar");
  await expect(target).toHaveValue("nextBar");
  await expect(lanes.nth(1).getByRole("combobox", { name: "Interpolation" })).toHaveValue("hold");
  await page.getByTestId("cell-3-0").click();
  await page.getByTestId("cell-3-4").click();
  await expect(target).toHaveValue("nextBar");
});

test("ordinary staged envelopes retain native SF2 timing and sustain units", async ({ page }) => {
  await chooseType(page, "chip wave");
  const existing = page.getByRole("button", { name: /^Delete envelope \d+$/u });
  while ((await existing.count()) > 0) {
    await existing.first().click();
  }
  await page.getByRole("button", { name: "Add envelope", exact: true }).click();
  const envelope = page.locator(".envelope-section").first();
  await envelope
    .getByRole("combobox", { name: "Envelope 1 type", exact: true })
    .selectOption("Staged / SF2");
  await envelope.getByRole("spinbutton", { name: "Attack s", exact: true }).fill("1");
  await envelope.getByRole("spinbutton", { name: "Attack s", exact: true }).press("Enter");
  await envelope
    .getByRole("combobox", { name: "Envelope law", exact: true })
    .selectOption("SF2 volume");
  await expect(
    envelope.getByRole("spinbutton", { name: "Attack timecents", exact: true }),
  ).toHaveValue("0");
  await envelope.getByRole("spinbutton", { name: "Delay timecents", exact: true }).fill("-32768");
  await envelope.getByRole("spinbutton", { name: "Delay timecents", exact: true }).press("Enter");
  await envelope.getByRole("spinbutton", { name: "Sustain centibels", exact: true }).fill("200");
  await envelope.getByRole("spinbutton", { name: "Sustain centibels", exact: true }).press("Enter");
  await envelope.getByText("Envelope modulators (0)", { exact: true }).click();
  await envelope.getByRole("button", { name: "Add envelope modulator", exact: true }).click();
  await envelope.getByRole("combobox", { name: "Destination", exact: true }).selectOption("35");
  await envelope.getByRole("spinbutton", { name: "Amount", exact: true }).fill("120");
  await envelope.getByRole("spinbutton", { name: "Amount", exact: true }).press("Enter");
  await page.reload();
  await envelope.getByRole("button", { name: "Expand envelope 1", exact: true }).click();
  await expect(envelope.getByRole("combobox", { name: "Envelope law", exact: true })).toHaveValue(
    "SF2 volume",
  );
  await expect(
    envelope.getByRole("spinbutton", { name: "Delay timecents", exact: true }),
  ).toHaveValue("-32768");
  await expect(
    envelope.getByRole("spinbutton", { name: "Sustain centibels", exact: true }),
  ).toHaveValue("200");
  await envelope
    .getByRole("combobox", { name: "Envelope law", exact: true })
    .selectOption("SF2 modulation");
  await expect(
    envelope.getByRole("spinbutton", { name: "Sustain 0.1% decrease", exact: true }),
  ).toHaveValue("900");
  await envelope
    .getByRole("combobox", { name: "Envelope law", exact: true })
    .selectOption("generic");
  await expect(envelope.getByRole("spinbutton", { name: "Attack s", exact: true })).toHaveValue(
    "1",
  );
  expect(
    Number(
      await envelope.getByRole("spinbutton", { name: "Sustain level", exact: true }).inputValue(),
    ),
  ).toBeCloseTo(0.1);
});

test("spectrum and drum editors use compact graphs and preserve edits", async ({ page }) => {
  await chooseType(page, "spectrum");
  const graph = page.getByRole("button", { name: "Spectrum", exact: true });
  expect((await graph.boundingBox())?.height).toBe(26);
  await expect(graph.locator("svg")).toHaveAttribute("viewBox", "0 0 120 26");
  await graph.focus();
  await page.keyboard.press("Delete");
  await page.reload();
  expect(
    required(
      required(decodeSong(await page.evaluate(() => location.hash.slice(1))).channels[0])
        .instruments[0],
    ).spectrum[0],
  ).toBe(0);
  await chooseType(page, "drumset");
  const rows = page.locator(".drum-row");
  await expect(rows).toHaveCount(12);
  const first = rows.first();
  await expect(first.locator("button.mini-graph")).toHaveAttribute(
    "aria-label",
    "Drum 12 Spectrum",
  );
  const envelope = await first.getByRole("combobox").boundingBox();
  const spectrum = await first.locator("button.mini-graph").boundingBox();
  expect(spectrum?.height).toBe(26);
  expect(spectrum?.y).toBe(envelope?.y);
  expect(spectrum?.x).toBeGreaterThan((envelope?.x ?? 0) + (envelope?.width ?? 0));
  await first.locator("button.mini-graph").focus();
  await page.keyboard.press("Delete");
  await page.reload();
  expect(
    required(
      required(
        required(decodeSong(await page.evaluate(() => location.hash.slice(1))).channels[0])
          .instruments[0],
      ).drums[11],
    ).spectrum[0],
  ).toBe(0);
});

for (const preset of [
  "warm pad",
  "square lead",
  "chip noise",
  "breath noise",
  "standard drumset",
  "electric piano 1",
  "supersaw lead",
  "PWM overdrive",
  "bright piano",
  "harpsichord",
]) {
  test(`upstream ${preset} playback runs under the production CSP without runtime code generation`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/unsafe-eval|Content Security Policy|Refused to evaluate/u.test(message.text())) {
        errors.push(message.text());
      }
    });
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    channel.instruments = [presetInstrument(preset)];
    required(channel.patterns[1]).notes = [createNote(0, 4, [48, 52, 55])];
    await page.goto(`./#${encodeSong(song)}`);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(errors).toEqual([]);
  });
}

test("custom retro noise plays without a factory preset or CSP errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/unsafe-eval|Content Security Policy|Refused to evaluate/u.test(message.text())) {
      errors.push(message.text());
    }
  });
  await chooseType(page, "basic noise");
  await expect(page.getByRole("combobox", { name: "Noise", exact: true })).toHaveValue("retro");
  const grid = page.getByTestId("note-grid");
  const box = await grid.boundingBox();
  if (!box) {
    throw new Error("Missing note grid.");
  }
  await grid.click({ position: { x: box.width * 0.1, y: box.height * 0.5 } });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const song = decodeSong(await page.evaluate(() => location.hash.slice(1)));
  const instrument = required(required(song.channels[0]).instruments[0]);
  expect(instrument.type).toBe("basic noise");
  expect(instrument.noise).toBe("retro");
  expect(instrument.preset).toBe("");
  expect(errors).toEqual([]);
});

test("instrument picker stays outside the shared controls group and EQ graphs belong to effects", async ({
  page,
}) => {
  const panel = page.getByRole("region", { name: "Instrument Settings", exact: true });
  const controls = panel.getByRole("group", { name: "Instrument controls", exact: true });
  await expect(controls.getByRole("spinbutton", { name: "Volume %", exact: true })).toBeVisible();
  await expect(controls.locator(".type-button")).toBeVisible();
  await expect(controls.getByRole("combobox", { name: "Transition", exact: true })).toBeVisible();
  await expect(controls.getByRole("combobox", { name: "Chords", exact: true })).toBeVisible();
  expect(
    await panel
      .locator(".number-bar")
      .evaluate((element) => element.closest(".settings-group") === null),
  ).toBe(true);
  await expect(panel.getByRole("button", { name: "EQ Filter graph", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Add Effect…", exact: true }).click();
  const add = panel.getByRole("combobox", { name: "Add Effect", exact: true });
  await expect(add.locator("option").filter({ hasText: /^Note Filter$/u })).toHaveCount(0);
  await add.selectOption("EQ");
  await page
    .getByRole("dialog", { name: "Add Effect", exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  const card = panel
    .locator(".effect-card")
    .filter({ has: page.getByRole("heading", { name: "EQ", exact: true }) });
  const graph = card.getByRole("button", { name: "EQ Filter graph", exact: true });
  await graph.click({ position: { x: 45, y: 7 } });
  const saved = decodeSong(await page.evaluate(() => location.hash.slice(1)));
  const effect = required(required(required(saved.channels[0]).instruments[0]).effects[0]);
  expect(effect.parameters["bandCount"]).toBe(1);
  await page.keyboard.press("z");
  expect(
    required(
      required(
        required(decodeSong(await page.evaluate(() => location.hash.slice(1))).channels[0])
          .instruments[0],
      ).effects[0],
    ).parameters["bandCount"],
  ).toBe(0);
  await page.keyboard.press("y");
  await page.reload();
  await expect(graph).toHaveCount(1);
  const restored = decodeSong(await page.evaluate(() => location.hash.slice(1)));
  expect(
    required(required(required(restored.channels[0]).instruments[0]).effects[0]).parameters,
  ).toEqual(effect.parameters);
  await card.getByRole("button", { name: "Copy EQ", exact: true }).click();
  await panel.getByRole("button", { name: "Paste Effect", exact: true }).click();
  await expect(panel.getByRole("button", { name: "EQ Filter graph", exact: true })).toHaveCount(2);
});

for (const type of ["Echo", "Ping Pong Delay", "Multitap Delay"]) {
  test(`${type} timing switches units, survives reload and supports undo/redo`, async ({
    page,
  }) => {
    const song = createSong();
    const instrument = createInstrument("chip wave");
    instrument.effects = [createEffect(type)];
    required(song.channels[0]).instruments = [instrument];
    await page.goto(`./#${encodeSong(song)}`);
    const card = page.locator(".instrument-panel .effect-card").filter({
      has: page.getByRole("heading", { name: type, exact: true }),
    });
    const timing = card.getByRole("combobox", { name: "Timing", exact: true });
    await expect(timing).toHaveValue("Seconds");
    await card.getByRole("spinbutton", { name: "Time s", exact: true }).fill("0.5");
    await card.getByRole("spinbutton", { name: "Time s", exact: true }).press("Enter");
    await timing.selectOption("Beats");
    await expect(card.getByRole("spinbutton", { name: "Time beats", exact: true })).toHaveValue(
      "0.5",
    );
    const edit = page.getByRole("combobox", { name: "Edit menu", exact: true });
    await edit.selectOption("Undo");
    await expect(timing).toHaveValue("Seconds");
    await expect(card.getByRole("spinbutton", { name: "Time s", exact: true })).toHaveValue("0.5");
    await edit.selectOption("Redo");
    await expect(timing).toHaveValue("Beats");
    const savedSong = decodeSong(await page.evaluate(() => location.hash.slice(1)));
    expect(
      required(required(required(savedSong.channels[0]).instruments[0]).effects[0]).parameters,
    ).toMatchObject({ time: 0.5, timeBasis: "Beats" });
    await page.reload();
    await expect(timing).toHaveValue("Beats");
    await expect(card.getByRole("spinbutton", { name: "Time beats", exact: true })).toHaveValue(
      "0.5",
    );
    await timing.selectOption("Seconds");
    await expect(card.getByRole("spinbutton", { name: "Time s", exact: true })).toHaveValue("0.5");
  });
}
