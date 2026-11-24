import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createInstrument } from "../../src/instruments";
import { createNote, createSong, History, required } from "../../src/model";
import {
  decodeSong,
  encodeSong,
  parseSongBytes,
  serializeInstrumentClipboard,
  serializeSongBytes,
} from "../../src/storage";
import { readStoredPreferences, readStoredState, seedStorage } from "./stored-state";

// Like a shared SoundFont arrangement, this has a large URL without embedded audio.
const arrangement = (): History => {
  const song = createSong("Major");
  song.beatsPerBar = 4;
  song.loopEnd = 8;
  for (const [index, channel] of song.channels.entries()) {
    const instrument = createInstrument(index < 2 ? "SoundFont" : "harmonics");
    instrument.resourceId = index < 2 ? "bundled-fluid-r3-mono" : "";
    instrument.program = index === 1 ? 45 : 2;
    channel.instruments = [instrument];
    if (index === 2) {
      continue;
    }
    channel.cells = Array.from({ length: song.barCount }, (_, bar) => (bar < 8 ? bar + 1 : 0));
    for (const pattern of Object.values(channel.patterns)) {
      pattern.notes = Array.from({ length: 8 }, (_, beat) =>
        createNote(beat / 2, (beat + 1) / 2, index === 0 ? [60, 64, 67] : [48]),
      );
    }
  }
  const history = new History(song);
  for (let index = 0; index < 60; index++) {
    history.execute((draft) => {
      draft.tempo = 151 + index;
    });
  }
  return history;
};

const flush = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("pagehide"));
  });
};

const storedTempo = async (page: Page): Promise<number | undefined> => {
  const session = await readStoredState(page, "session");
  try {
    return session === undefined ? undefined : parseSongBytes(session).tempo;
  } catch {
    return undefined;
  }
};

for (const action of ["add a note", "change tempo"] as const) {
  test(`a large shared song can ${action} and restore undo/redo`, async ({ page }) => {
    const history = arrangement();
    const encoded = encodeSong(history.song);
    expect(encoded.length).toBeLessThan(JSON.stringify(history.song).length / 5);
    await seedStorage(page, { preferences: { listeningVolume: 25 } });
    // The same compressed protobuf representation serves links, storage, and history.
    await page.goto(`./#${encoded}`);
    const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
    await expect(tempo).toHaveValue("210");
    expect(decodeSong(await page.evaluate(() => location.hash.slice(1)))).toEqual(history.song);
    await expect(
      page.getByRole("combobox", { name: "Edit menu" }).locator('option[value="Undo"]'),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Preferences", exact: true }).click();
    await page.getByRole("switch", { name: "Display Song Data in URL", exact: true }).uncheck();
    await page.keyboard.press("Escape");
    await flush(page);
    const preferences = { listeningVolume: 25, songInUrl: false };
    await expect.poll(async () => await readStoredPreferences(page)).toMatchObject(preferences);
    const notes = page.getByTestId("note");
    const before = await notes.count();
    if (action === "add a note") {
      await page.getByTestId("note-grid").click({ position: { x: 80, y: 100 } });
      await expect(notes).toHaveCount(before + 1);
    } else {
      await tempo.fill("211");
      await tempo.press("Enter");
      await expect(tempo).toHaveValue("211");
    }
    await flush(page);
    await expect(page.getByRole("status")).toHaveCount(0);
    const expectedTempo = action === "change tempo" ? 211 : 210;
    const browser = await page.evaluate(() => {
      const state: unknown = globalThis.history.state;
      if (state === null || typeof state !== "object") {
        throw new Error("Browser history is empty.");
      }
      const entry: unknown = Reflect.get(state, "slopemp");
      const data: unknown =
        entry === null || typeof entry !== "object" ? undefined : Reflect.get(entry, "data");
      if (typeof data !== "string") {
        throw new TypeError("Browser history song is missing.");
      }
      return { state, session: data, hash: location.hash };
    });
    expect(browser.hash).toBe("");
    const historySong = decodeSong(browser.session);
    await expect
      .poll(async () => await readStoredState(page, "session"))
      .toEqual(serializeSongBytes(historySong));
    expect(historySong.tempo).toBe(expectedTempo);
    expect(browser.state).not.toHaveProperty("slopemp.song");
    expect(browser.state).not.toHaveProperty("slopemp.songs");
    expect(browser.state).not.toHaveProperty("slopemp.labels");
    expect(await readStoredPreferences(page)).toMatchObject(preferences);

    // With URL data disabled, browser history must still retain undo/redo across reloads.
    await page.reload();
    await expect(notes).toHaveCount(action === "add a note" ? before + 1 : before);
    await expect(tempo).toHaveValue(action === "change tempo" ? "211" : "210");
    const edit = page.getByRole("combobox", { name: "Edit menu", exact: true });
    await edit.selectOption("Undo");
    await expect(notes).toHaveCount(before);
    await expect(tempo).toHaveValue("210");
    await flush(page);
    await page.reload();
    await edit.selectOption("Redo");
    await expect(notes).toHaveCount(action === "add a note" ? before + 1 : before);
    await expect(tempo).toHaveValue(action === "change tempo" ? "211" : "210");
    await expect(page.getByRole("status")).toHaveCount(0);
  });
}

test("blocked storage still warns while song editing and sharing remain available", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      get: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
  });
  await page.goto("./");
  await page.getByTestId("note-grid").click({ position: { x: 80, y: 100 } });
  await expect(page.getByTestId("note")).toHaveCount(1);
  await flush(page);
  await expect(page.getByRole("status")).toContainText("Browser storage is unavailable");
  await expect.poll(async () => await page.evaluate(() => location.hash.length)).toBeGreaterThan(1);
  const url = page.url();
  await page.goto(url);
  await expect(page.getByTestId("note")).toHaveCount(1);
});

test("an aborted autosave preserves the last durable song and later edits can save", async ({
  page,
}) => {
  const saved = createSong();
  saved.tempo = 158;
  await seedStorage(page, {
    session: serializeSongBytes(saved),
    preferences: { songInUrl: false },
  });
  await page.addInitScript(() => {
    const transaction: unknown = Reflect.get(IDBDatabase.prototype, "transaction");
    if (typeof transaction !== "function") {
      throw new TypeError("Missing IndexedDB transaction API.");
    }
    Reflect.set(
      IDBDatabase.prototype,
      "transaction",
      new Proxy(transaction, {
        apply(target, database: unknown, args: unknown[]): unknown {
          const tx: unknown = Reflect.apply(target, database, args);
          if (
            tx instanceof IDBTransaction &&
            tx.mode === "readwrite" &&
            document.documentElement.dataset["abortSessionWrite"] === "true"
          ) {
            Object.defineProperty(tx, "commit", {
              value: (): void => {
                // Abort after the put has succeeded, before the transaction completes.
                tx.objectStore("state")
                  .get("session")
                  .addEventListener("success", () => {
                    tx.abort();
                  });
              },
            });
          }
          return tx;
        },
      }),
    );
  });
  await page.goto("./");
  const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
  await expect(tempo).toHaveValue("158");
  await page.evaluate(() => {
    document.documentElement.dataset["abortSessionWrite"] = "true";
  });
  await tempo.fill("169");
  await tempo.press("Enter");
  await flush(page);
  await expect(page.getByRole("status")).toContainText("Browser storage is unavailable");
  await expect(tempo).toHaveValue("169");
  expect(await storedTempo(page)).toBe(158);

  await page.evaluate(() => {
    delete document.documentElement.dataset["abortSessionWrite"];
  });
  await tempo.fill("172");
  await tempo.press("Enter");
  await flush(page);
  await expect.poll(async () => await storedTempo(page)).toBe(172);
  const reopened = await page.context().newPage();
  await reopened.goto("./");
  await expect(reopened.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue("172");
});

test("leaving the editor flushes the most recent committed edit", async ({ page }) => {
  await seedStorage(page, { preferences: { songInUrl: false } });
  await page.goto("./");
  await page.getByRole("spinbutton", { name: "Tempo", exact: true }).fill("176");
  await page.getByRole("spinbutton", { name: "Tempo", exact: true }).press("Enter");
  await page.goto("./?fresh");
  await expect(page.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue("176");
});

test("a copied instrument can be pasted into a different song in a fresh tab", async ({ page }) => {
  const source = createSong();
  const copied = createInstrument("harmonics");
  required(source.channels[0]).instruments = [copied];
  await page.goto(`./#${encodeSong(source)}`);
  await expect(page.locator("button.type-button")).toHaveText("harmonics");
  await page.keyboard.press("Shift+c");
  await expect
    .poll(async () => await readStoredState(page, "clipboard.instrument"))
    .toEqual(serializeInstrumentClipboard(copied));

  const destination = createSong();
  const original = required(required(destination.channels[0]).instruments[0]);
  const reopened = await page.context().newPage();
  await reopened.goto(`./#${encodeSong(destination)}`);
  await reopened.locator("button.type-button").click();
  await reopened.getByRole("button", { name: "Paste Instrument", exact: true }).click();
  await expect(reopened.locator("button.type-button")).toHaveText("harmonics");
  const pasted = decodeSong(await reopened.evaluate(() => location.hash));
  expect(required(pasted.channels[0]).instruments[0]).toEqual({ ...copied, id: original.id });
});

test("a corrupt URL restores the durable song", async ({ page }) => {
  const song = createSong();
  song.tempo = 187;
  await seedStorage(page, { session: serializeSongBytes(song) });
  await page.goto("./#invalid-song");
  const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
  await expect(tempo).toHaveValue("187");
  await expect(page.getByRole("status")).toContainText("Could not load song");
  await flush(page);
  expect(parseSongBytes(required(await readStoredState(page, "session")))).toEqual(song);
});

test("corrupt session data remains available for diagnosis until the first deliberate edit", async ({
  page,
}) => {
  const corrupt = serializeSongBytes(createSong()).subarray(0, 12);
  await seedStorage(page, { session: corrupt });
  await page.goto("./");
  await expect(page.getByRole("status")).toContainText("Could not load song");
  await flush(page);
  expect(await readStoredState(page, "session")).toEqual(corrupt);
  await page.getByRole("spinbutton", { name: "Tempo", exact: true }).fill("171");
  await page.getByRole("spinbutton", { name: "Tempo", exact: true }).press("Enter");
  await flush(page);
  await expect.poll(async () => await storedTempo(page)).toBe(171);
});

test("browser history write denial preserves editing and in-memory undo/redo", async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.History.prototype.pushState = (): void => {
      throw new DOMException("History storage denied", "SecurityError");
    };
  });
  await page.goto("./");
  const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
  const edit = page.getByRole("combobox", { name: "Edit menu", exact: true });
  await tempo.fill("180");
  await tempo.press("Enter");
  await expect(page.getByRole("status")).toContainText("could not save editing history");
  await tempo.fill("190");
  await tempo.press("Enter");
  await edit.selectOption("Undo");
  await expect(tempo).toHaveValue("180");
  await edit.selectOption("Undo");
  await expect(tempo).toHaveValue("150");
  await edit.selectOption("Redo");
  await expect(tempo).toHaveValue("180");
  await flush(page);
  await expect.poll(async () => await storedTempo(page)).toBe(180);
});

test("a corrupt browser history destination cannot replace the current edit", async ({ page }) => {
  await page.goto("./");
  const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
  await tempo.fill("184");
  await tempo.press("Enter");
  await page.evaluate(() => {
    history.replaceState({ slopemp: { data: "corrupt" } }, "", "#corrupt");
    globalThis.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("status")).toContainText("The current edit is preserved");
  await expect(tempo).toHaveValue("184");
  await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Undo");
  await expect(tempo).toHaveValue("150");
  await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Redo");
  await expect(tempo).toHaveValue("184");
});
