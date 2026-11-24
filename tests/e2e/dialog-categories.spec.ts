import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`Preferences and Help share category navigation at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("./");
    await page.getByRole("button", { name: "Preferences", exact: true }).click();
    const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
    await expect(preferences.getByRole("searchbox")).toBeFocused();
    const categories = preferences.getByRole("navigation", { name: "Preference categories" });
    await expect(categories.getByRole("button", { name: "All", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await categories.getByRole("button", { name: "Note Recording", exact: true }).click();
    await expect(
      preferences.getByRole("heading", { name: "Note Recording", exact: true }),
    ).toBeVisible();
    await expect(preferences.getByRole("heading", { name: "Audio", exact: true })).toHaveCount(0);
    const recording = preferences.getByRole("switch", { name: /Snap recorded notes/u });
    await recording.check();
    await expect(recording).toBeChecked();
    await categories.getByRole("button", { name: "Piano Roll", exact: true }).click();
    const align = preferences.getByRole("switch", {
      name: "Left Align Piano",
    });
    await expect(align).toBeChecked();
    await align.uncheck();
    await categories.getByRole("button", { name: "All", exact: true }).click();
    await preferences.getByRole("searchbox").fill("metronome");
    await expect(
      preferences.getByRole("heading", { name: "Note Recording", exact: true }),
    ).toBeVisible();
    await expect(preferences.getByRole("heading", { name: "Audio", exact: true })).toHaveCount(0);
    await preferences.getByRole("searchbox").fill("no-such-preference");
    await expect(preferences.getByText("No matching settings or sections.")).toBeVisible();
    await preferences.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Preferences", exact: true }).click();
    await categories.getByRole("button", { name: "Note Recording", exact: true }).click();
    await expect(recording).toBeChecked();
    await categories.getByRole("button", { name: "Piano Roll", exact: true }).click();
    await expect(align).not.toBeChecked();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Help", exact: true }).click();
    const help = page.getByRole("dialog", { name: "Help", exact: true });
    await expect(help.getByRole("searchbox")).toBeFocused();
    await help.getByRole("button", { name: "Features", exact: true }).click();
    await expect(help.getByRole("heading", { name: "Features", exact: true })).toBeVisible();
    await expect(help.getByText(/Arrange reusable patterns/u)).toBeVisible();
    await expect(help.getByText("Keyboard shortcuts", { exact: true })).toHaveCount(0);
    await help.getByRole("button", { name: "Credits", exact: true }).click();
    await expect(help.getByText(/Synthesis code adapted from UltraBox/u)).toBeVisible();
    await expect(
      help.getByRole("link", { name: "Bundled asset credits and licenses", exact: true }),
    ).toHaveAttribute("href", "./license/README.md");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // The shared header close button stays available after scrolling through a section.
    await help.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(help).toBeHidden();
  });
}

test("dialog inputs keep focus while preferences and asset drafts update", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
  await preferences.getByRole("button", { name: "Audio", exact: true }).click();
  const volume = preferences.getByRole("spinbutton", { name: "Volume", exact: true });
  await volume.fill("");
  await volume.pressSequentially("42");
  await expect(volume).toBeFocused();
  await expect(volume).toHaveValue("42");
  await preferences.getByRole("button", { name: "Close dialog", exact: true }).click();

  const source = new URL("./Scratch%20sample.wav", page.url());
  const release = Promise.withResolvers<undefined>();
  await page.route(source.href, async (route) => {
    await release.promise;
    await route.fulfill({ path: new URL("../assets/flute-C4.wav", import.meta.url).pathname });
  });
  const editMenu = page.getByRole("combobox", { name: "Edit menu", exact: true });
  await editMenu.selectOption("Add Assets");
  const dialog = page.getByRole("dialog", { name: "Add Assets", exact: true });
  await expect(
    dialog.getByRole("link", { name: "Bundled asset credits and licenses" }),
  ).toHaveCount(0);
  const urls = dialog.getByRole("textbox", { name: /Asset \d+ URL$/u });
  const count = await urls.count();
  await dialog.getByRole("button", { name: "Add Asset", exact: true }).click();
  const url = urls.last();
  const insertion = "atch";
  const offset = source.href.indexOf(`${insertion}%20`);
  await url.pressSequentially(source.href.replace("Scratch%20", "Scr%20"));
  await url.evaluate((input, position) => {
    if (input instanceof HTMLInputElement) {
      input.setSelectionRange(position, position);
    }
  }, offset);
  await url.pressSequentially(insertion);
  await expect(url).toBeFocused();
  await expect(url).toHaveValue(source.href);
  expect(
    await url.evaluate((input) => input instanceof HTMLInputElement && input.selectionStart),
  ).toBe(offset + insertion.length);
  const sample = dialog.locator(".resource-entry").last();
  await sample.getByText("Playback metadata", { exact: true }).click();
  const rootKey = sample.getByRole("spinbutton", {
    name: "Scratch sample Root MIDI key",
    exact: true,
  });
  try {
    await expect(sample.getByText("Loading…", { exact: true })).toBeVisible();
    await rootKey.fill("");
  } finally {
    release.resolve(undefined);
  }
  await expect(sample.getByText("Ready", { exact: true })).toBeVisible();
  await expect(rootKey).toHaveValue("");
  await rootKey.pressSequentially("72");
  await expect(rootKey).toBeFocused();
  await expect(rootKey).toHaveValue("72");
  for (const input of ["128", "129"]) {
    await rootKey.fill(input);
    await expect(rootKey).toHaveValue(input);
    await rootKey.press("Enter");
    await expect(rootKey).toHaveValue("127");
  }
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await editMenu.selectOption("Add Assets");
  await expect(urls).toHaveCount(count);
});
