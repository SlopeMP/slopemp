import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createSong } from "@slopemp/song";

import { createInstrument } from "../../src/instruments";
import { startMultiplayer } from "./multiplayer-server";
import { readStoredPreferences, writeStoredState } from "./stored-state";

const showConnection = async (page: Page): Promise<void> => {
  await page.getByRole("combobox", { name: "File menu" }).selectOption("Multiplayer…");
};

const join = async (page: Page, address: string, password: string): Promise<void> => {
  const dialog = page.getByRole("dialog", { name: "Multiplayer" });
  await dialog.getByLabel("Server WebSocket address").fill(address);
  await dialog.getByLabel("Password (optional)").fill(password);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
};

const dismiss = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Close dialog" }).click();
};

const tempo = (page: Page): ReturnType<Page["getByRole"]> =>
  page.getByRole("spinbutton", { name: "Tempo", exact: true });

test("joins only on request, shares edits and selections, and disconnects to local editing", async ({
  page,
  context,
}) => {
  const song = createSong();
  song.tempo = 132;
  const server = await startMultiplayer(song, "studio key");
  const { address } = server;
  const collaborator = await context.newPage();
  try {
    await Promise.all([page.goto("./"), collaborator.goto("./")]);
    await expect(tempo(page)).toHaveValue("150");
    await expect(tempo(collaborator)).toHaveValue("150");
    await writeStoredState(page, { preferences: { listeningVolume: 19 } });
    await page.reload();
    await page.getByRole("button", { name: "Play", exact: true }).click();

    await showConnection(page);
    await expect(page.getByText(/Save your local work before connecting/u)).toBeVisible();
    await join(page, address, "incorrect");
    await expect(page.getByRole("alert")).toHaveText("Incorrect server password.");
    await expect(tempo(page)).toHaveValue("150");
    await join(page, address, "studio key");
    await expect(page.getByText(address, { exact: true })).toBeVisible();
    await expect(tempo(page)).toHaveValue("132");

    await showConnection(collaborator);
    await join(collaborator, address, "studio key");
    await expect(tempo(collaborator)).toHaveValue("132");
    await expect(page.getByRole("listitem").filter({ hasText: "You" })).toHaveCount(1);
    await expect(page.getByRole("listitem").filter({ hasText: /Editor /u })).toHaveCount(1);
    await dismiss(page);
    await dismiss(collaborator);
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    await expect(pause).toBeVisible();
    await pause.click();
    expect(await readStoredPreferences(page)).toMatchObject({ listeningVolume: 19 });

    await collaborator.getByTestId("cell-1-2").click();
    await expect(page.getByTestId("cell-1-2").locator(".editor-color")).toHaveCount(1);
    await expect(collaborator.getByTestId("cell-1-2").getByTitle("You")).toBeVisible();

    await tempo(page).fill("160");
    await tempo(page).press("Enter");
    await expect(tempo(collaborator)).toHaveValue("160");
    const keys = collaborator.getByRole("combobox", { name: "Key", exact: true });
    await keys.selectOption("4");
    await expect(page.getByRole("combobox", { name: "Key", exact: true })).toHaveValue("4");

    const edits = page.getByRole("combobox", { name: "Edit menu" });
    await edits.selectOption("Undo");
    await expect(tempo(collaborator)).toHaveValue("132");
    await expect(keys).toHaveValue("4");
    await expect(edits.locator('option[value="Redo"]')).toBeEnabled();
    await edits.selectOption("Redo");
    await expect(tempo(collaborator)).toHaveValue("160");

    await page.getByRole("button", { name: "Multiplayer: Connected" }).click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("status")).toHaveText("Offline");
    await dismiss(page);
    await expect(tempo(page)).toHaveValue("160");
    await tempo(page).fill("176");
    await tempo(page).press("Enter");
    await expect(tempo(collaborator)).toHaveValue("160");
  } finally {
    await collaborator.close();
    await server.stop();
  }
});

test("pauses editing after connection loss and resumes against the server song in place", async ({
  page,
}) => {
  const song = createSong();
  song.tempo = 135;
  let server = await startMultiplayer(song);
  const { address, port } = server;
  try {
    await page.goto("./");
    const loadedAt = await page.evaluate(() => performance.timeOrigin);
    await showConnection(page);
    await join(page, address, "");
    await expect(tempo(page)).toHaveValue("135");
    await dismiss(page);
    await server.stop();
    await expect(page.getByRole("button", { name: /Disconnected/u })).toBeVisible();
    await expect(page.locator(".workspace")).toHaveAttribute("inert", "");
    await expect(tempo(page)).toHaveValue("135");
    song.tempo = 145;
    server = await startMultiplayer(song, "", port);
    await expect(page.getByRole("button", { name: "Multiplayer: Connected" })).toBeVisible();
    await expect(tempo(page)).toHaveValue("145");
    await expect(page.locator(".workspace")).not.toHaveAttribute("inert", "");
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
  } finally {
    await server.stop();
  }
});

test("recording holds a track lock through count-in and releases it when stopped", async ({
  page,
  context,
}) => {
  const song = createSong();
  const server = await startMultiplayer(song);
  const collaborator = await context.newPage();
  try {
    for (const editor of [page, collaborator]) {
      await editor.goto("./");
      await showConnection(editor);
      await join(editor, server.address, "");
      await expect(editor.getByRole("dialog").getByRole("status")).toHaveText("Connected");
      await dismiss(editor);
    }
    const otherTrack = collaborator.getByTestId("cell-1-0");
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await expect(page.getByText("Count-in…")).toBeVisible();
    await expect(collaborator.locator(".instrument-settings")).toHaveAttribute("inert", "");
    await otherTrack.click();
    await expect(collaborator.locator(".instrument-settings")).not.toHaveAttribute("inert", "");
    await collaborator.getByTestId("cell-0-0").click();
    await expect(collaborator.locator(".instrument-settings")).toHaveAttribute("inert", "");
    await page.getByRole("button", { name: "Stop Recording", exact: true }).click();
    await expect(collaborator.locator(".instrument-settings")).not.toHaveAttribute("inert", "");
  } finally {
    await collaborator.close();
    await server.stop();
  }
});

test("enlarged sound editors hold their own instrument lock until closed", async ({
  page,
  context,
}) => {
  const song = createSong();
  for (const track of song.channels.slice(0, 2)) {
    track.instruments = [createInstrument("Custom chip wave")];
  }
  const server = await startMultiplayer(song);
  const collaborator = await context.newPage();
  const drawingName = "Custom chip wave editor";
  const enlarge = (editor: Page): ReturnType<Page["getByRole"]> =>
    editor.getByRole("button", { name: "Enlarge Custom chip wave", exact: true });
  try {
    for (const editor of [page, collaborator]) {
      await editor.goto("./");
      await showConnection(editor);
      await join(editor, server.address, "");
      await expect(editor.getByRole("dialog").getByRole("status")).toHaveText("Connected");
      await dismiss(editor);
    }
    await enlarge(page).click();
    const drawing = page.getByRole("dialog", { name: drawingName });
    await expect(drawing).toBeVisible();
    await enlarge(collaborator).click();
    await expect(
      collaborator.getByText("This instrument is locked by another editor."),
    ).toBeVisible();

    await collaborator.getByTestId("cell-1-0").click();
    await enlarge(collaborator).click();
    const otherDrawing = collaborator.getByRole("dialog", { name: drawingName });
    await expect(otherDrawing).toBeVisible();
    await otherDrawing.getByRole("button", { name: "Close", exact: true }).click();

    // Commit a drawing while the first editor still holds its lock.
    const original = collaborator.locator('.mini-graph[aria-label="Custom chip wave"]');
    await collaborator.getByTestId("cell-0-0").click();
    const before = await original.innerHTML();
    const graph = drawing.getByRole("button", { name: "Custom chip wave", exact: true });
    await graph.focus();
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => await original.innerHTML()).not.toBe(before);
    await drawing.getByRole("button", { name: "Close", exact: true }).click();
    await enlarge(collaborator).click();
    await expect(otherDrawing).toBeVisible();
  } finally {
    await collaborator.close();
    await server.stop();
  }
});
