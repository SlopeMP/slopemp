import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { createSong } from "../../src/model";
import { encodeSong } from "../../src/storage";

const guitarUrl = "./test-assets/guitar.wav";
const fixture = (filename: string): string =>
  new URL(`../assets/${filename}`, import.meta.url).pathname;
const dialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Add Assets", exact: true });
const editAssets = async (page: Page): Promise<void> => {
  await page.getByRole("combobox", { name: "Edit menu", exact: true }).selectOption("Add Assets");
};
const openSong = async (page: Page, includeAsset = false): Promise<void> => {
  const song = createSong();
  song.resources = includeAsset ? [{ id: "sample-guitar", url: guitarUrl }] : [];
  await page.goto(`./#${encodeSong(song)}`);
  await editAssets(page);
};
const ready = (page: Page): Locator => dialog(page).getByText("Ready", { exact: true });
const retry = (page: Page): Locator =>
  dialog(page).getByRole("button", { name: "Retry guitar", exact: true });
const okay = (page: Page): Locator =>
  dialog(page).getByRole("button", { name: "Okay", exact: true });
const addSample = async (page: Page): Promise<void> => {
  await dialog(page).getByRole("button", { name: "Add Asset", exact: true }).click();
  const url = dialog(page).getByRole("textbox", { name: /Asset \d+ URL$/u });
  await url.fill(guitarUrl);
  await url.press("Tab");
};

test("an unfavorited sample survives reload and only Retry downloads a replacement", async ({
  page,
}) => {
  let requests = 0;
  let source = "piano-C4.wav";
  await page.route("**/test-assets/guitar.wav", async (route) => {
    requests++;
    await route.fulfill({ path: fixture(source) });
  });
  await openSong(page);
  await addSample(page);
  await expect(ready(page)).toBeVisible();
  const favorite = dialog(page).getByRole("button", { name: "Favorite guitar", exact: true });
  await expect(favorite).toHaveAttribute("aria-pressed", "false");
  const controls = dialog(page).locator(".resource-entry header button");
  await expect(controls.nth(0)).toHaveAccessibleName("Retry guitar");
  await expect(controls.nth(1)).toHaveAccessibleName("Favorite guitar");
  const showMetadata = async (): Promise<void> => {
    await dialog(page).getByText("Playback metadata", { exact: true }).click();
  };
  const end = dialog(page).getByRole("spinbutton", { name: "guitar Loop end", exact: true });
  await showMetadata();
  const originalLength = await end.inputValue();
  expect(Number(originalLength)).toBeGreaterThan(0);
  await okay(page).click();
  await expect(dialog(page)).toBeHidden();
  expect(requests).toBe(1);

  source = "flute-C4.wav";
  await page.reload();
  await editAssets(page);
  await expect(ready(page)).toBeVisible();
  await showMetadata();
  await expect(end).toHaveValue(originalLength);
  expect(requests).toBe(1);

  await retry(page).click();
  await expect(ready(page)).toBeVisible();
  await expect(end).not.toHaveValue(originalLength);
  const replacementLength = await end.inputValue();
  expect(Number(replacementLength)).toBeGreaterThan(0);
  expect(requests).toBe(2);
  await okay(page).click();
  await expect(dialog(page)).toBeHidden();

  await page.reload();
  await editAssets(page);
  await expect(ready(page)).toBeVisible();
  await showMetadata();
  await expect(end).toHaveValue(replacementLength);
  expect(requests).toBe(2);
});

test("a broken cached sample can only be repaired with Retry", async ({ page }) => {
  let requests = 0;
  await page.route("**/test-assets/guitar.wav", async (route) => {
    requests++;
    await route.fulfill({ path: fixture("piano-C4.wav") });
  });
  await openSong(page, true);
  await expect(ready(page)).toBeVisible();
  expect(requests).toBe(1);
  await page.evaluate(async (source) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("slopemp-assets");
      request.addEventListener("success", () => {
        resolve(request.result);
      });
      request.addEventListener("error", () => {
        reject(request.error ?? new Error("Could not open the asset cache."));
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("assets", "readwrite");
        transaction
          .objectStore("assets")
          .put(new ArrayBuffer(4), new URL(source, document.baseURI).href);
        transaction.addEventListener("complete", () => {
          resolve();
        });
        transaction.addEventListener("abort", () => {
          reject(transaction.error ?? new Error("Could not seed the asset cache."));
        });
      });
    } finally {
      database.close();
    }
  }, guitarUrl);

  await page.reload();
  await editAssets(page);
  await expect(dialog(page).getByText("Error", { exact: true })).toBeVisible();
  expect(requests).toBe(1);
  await retry(page).click();
  await expect(ready(page)).toBeVisible();
  expect(requests).toBe(2);
  await okay(page).click();
  await expect(dialog(page)).toBeHidden();

  await page.reload();
  await editAssets(page);
  await expect(ready(page)).toBeVisible();
  expect(requests).toBe(2);
});

test("a failed cache read does not trigger a download", async ({ page }) => {
  let requests = 0;
  await page.route("**/test-assets/guitar.wav", async (route) => {
    requests++;
    await route.fulfill({ path: fixture("piano-C4.wav") });
  });
  await page.addInitScript(() => {
    const get: unknown = Reflect.get(IDBObjectStore.prototype, "get");
    if (typeof get !== "function") {
      throw new TypeError("Missing IndexedDB read API.");
    }
    Reflect.set(
      IDBObjectStore.prototype,
      "get",
      new Proxy(get, {
        apply(target, store: unknown, args: unknown[]): unknown {
          const request: unknown = Reflect.apply(target, store, args);
          if (
            store instanceof IDBObjectStore &&
            store.name === "assets" &&
            sessionStorage.getItem("blockAssetReads") === "true"
          ) {
            store.transaction.abort();
          }
          return request;
        },
      }),
    );
  });
  await openSong(page, true);
  await expect(ready(page)).toBeVisible();
  await page.evaluate(() => {
    sessionStorage.setItem("blockAssetReads", "true");
  });
  await page.reload();
  await editAssets(page);
  await expect(dialog(page).getByText("Error", { exact: true })).toBeVisible();
  expect(requests).toBe(1);

  await retry(page).click();
  await expect(ready(page)).toBeVisible();
  expect(requests).toBe(2);
});

test("Okay does not repeat a failed draft download", async ({ page }) => {
  let requests = 0;
  await page.route("**/test-assets/guitar.wav", async (route) => {
    if (++requests === 1) {
      await route.fulfill({ status: 503 });
    } else {
      await route.fulfill({ path: fixture("piano-C4.wav") });
    }
  });
  await openSong(page);
  await addSample(page);
  await expect(dialog(page).getByText("Error", { exact: true })).toBeVisible();
  await okay(page).click();
  await okay(page).click();
  await expect(dialog(page).getByText("Error", { exact: true })).toBeVisible();
  expect(requests).toBe(1);

  await retry(page).click();
  await expect(ready(page)).toBeVisible();
  expect(requests).toBe(2);
  await okay(page).click();
  await expect(dialog(page)).toBeHidden();
});
