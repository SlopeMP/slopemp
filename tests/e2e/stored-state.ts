import type { Page } from "@playwright/test";

import { parsePreferences, serializePreferences } from "../../src/preferences";
import type { Preferences } from "../../src/preferences";

type StorageKey = "clipboard.instrument" | "clipboard.pattern" | "preferences" | "session";
type StoredState = Partial<Record<StorageKey, Uint8Array>>;
type StorageSeed = Omit<StoredState, "preferences"> & { preferences?: Partial<Preferences> };
type StorageOperation = { deleteKey: StorageKey } | { entries: StoredState } | { key: StorageKey };

const accessStoredState = async (operation: StorageOperation): Promise<unknown> => {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("slopemp", 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore("state");
    });
    request.addEventListener("success", () => {
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Could not open test storage."));
    });
  });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(
        "state",
        "key" in operation ? "readonly" : "readwrite",
      );
      const store = transaction.objectStore("state");
      const request: IDBRequest<unknown> | undefined =
        "key" in operation ? store.get(operation.key) : undefined;
      if ("entries" in operation) {
        for (const [key, value] of Object.entries(operation.entries)) {
          store.put(value, key);
        }
      }
      if ("deleteKey" in operation) {
        store.delete(operation.deleteKey);
      }
      transaction.addEventListener("complete", () => {
        resolve(request?.result);
      });
      transaction.addEventListener("abort", () => {
        reject(transaction.error ?? new Error("The test storage transaction was aborted."));
      });
    });
  } finally {
    database.close();
  }
};

export const writeStoredState = async (
  page: Page,
  { preferences, ...entries }: StorageSeed,
): Promise<void> => {
  const values: StoredState = entries;
  if (preferences !== undefined) {
    values.preferences = serializePreferences(preferences);
  }
  await page.evaluate(accessStoredState, { entries: values });
};

export const readStoredState = async (
  page: Page,
  key: StorageKey,
): Promise<Uint8Array | undefined> => {
  const value = await page.evaluate(accessStoredState, { key });
  if (value !== undefined && !(value instanceof Uint8Array)) {
    throw new TypeError(`Expected binary data for ${key}.`);
  }
  return value;
};

export const readStoredPreferences = async (page: Page): Promise<Preferences | undefined> => {
  const value = await readStoredState(page, "preferences");
  return value === undefined ? undefined : parsePreferences(value);
};

export const deleteStoredState = async (page: Page, key: StorageKey): Promise<void> => {
  await page.evaluate(accessStoredState, { deleteKey: key });
};

export const seedStorage = async (
  page: Page,
  entries: StorageSeed,
  seedURL = "./__storage_seed__",
): Promise<void> => {
  const seedPage = await page.context().newPage();
  try {
    // Commit the seed on the app's origin before its startup can read the database.
    await seedPage.route("**/__storage_seed__", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
    });
    await seedPage.goto(seedURL);
    await writeStoredState(seedPage, entries);
  } finally {
    await seedPage.close();
  }
};
