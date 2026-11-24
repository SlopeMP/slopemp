import { expect, test } from "@playwright/test";

import { startPWAServer } from "./pwa-server";

test.use({ serviceWorkers: "allow" });

test("the editor advertises its install manifest and icons", async ({ page, request }) => {
  await page.goto("./");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "./manifest.webmanifest",
  );
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "./favicon.ico");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "./apple-touch-icon.png",
  );

  const response = await request.get("./manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const icons = [
    { src: "./icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "./icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "./icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ];
  expect(await response.json()).toMatchObject({
    name: "SlopeMP",
    start_url: "./",
    scope: "./",
    display: "standalone",
    icons,
  });
  for (const path of ["./favicon.ico", "./apple-touch-icon.png", ...icons.map(({ src }) => src)]) {
    expect((await request.get(path)).ok()).toBe(true);
  }
});

test("the service worker uses the network before its precache", async ({
  browserName,
  context,
  page,
  request,
}) => {
  const path = "./manifest.webmanifest";
  const cachedBody = "cached manifest";
  const networkResponse = await request.get(path);
  expect(networkResponse.ok()).toBe(true);

  await page.goto("./");
  await expect
    .poll(async () => await page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe("activated");

  await page.evaluate(
    async ({ url, body }) => {
      const [cacheName] = await caches.keys();
      if (cacheName === undefined) {
        throw new Error("The service worker precache is missing.");
      }
      const cache = await caches.open(cacheName);
      await cache.put(url, new Response(body));
    },
    { url: path, body: cachedBody },
  );

  const fetchManifest = async (): Promise<string> =>
    await page.evaluate(async (url) => {
      const response = await fetch(url);
      return await response.text();
    }, path);

  expect(await fetchManifest()).toBe(await networkResponse.text());

  // Firefox's offline emulation does not apply to service worker requests.
  if (browserName === "chromium") {
    await context.setOffline(true);
    expect(await fetchManifest()).toBe(cachedBody);
  }
});

test("the editor and bundled audio assets work offline after installation", async ({
  context,
  page,
}) => {
  await page.goto("./");
  await expect
    .poll(async () => await page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe("activated");

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue("150");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  const assets = await page.evaluate(async () => {
    const paths = ["assets/fluid-r3-mono.sf3"];
    return await Promise.all(
      paths.map(async (path) => {
        const response = await fetch(path);
        return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
      }),
    );
  });
  expect(assets).toHaveLength(1);
  expect(assets[0]?.status).toBe(200);
  expect(assets[0]?.bytes).toBeGreaterThan(0);

  const position = page.locator(".speaker span");
  await expect(position).toHaveText("1:1");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(position).not.toHaveText("1:1");
});

for (const missingAsset of [false, true]) {
  test(`an ${missingAsset ? "incomplete" : "updated"} deployment keeps the correct offline app with editor tabs open`, async ({
    context,
    page,
  }) => {
    const server = await startPWAServer();
    try {
      await page.goto(server.url);
      await expect
        .poll(async () => await page.evaluate(() => navigator.serviceWorker.controller?.state))
        .toBe("activated");
      const tempo = page.getByRole("spinbutton", { name: "Tempo", exact: true });
      await tempo.fill("173");
      await page.getByTestId("note-grid").click({ position: { x: 80, y: 100 } });
      const songURL = page.url();
      const other = await context.newPage();
      await other.goto(songURL);
      await expect(other.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue(
        "173",
      );

      server.deploy("second", missingAsset);
      await page.reload();
      await expect(tempo).toHaveValue("173");
      await expect(page.getByTestId("note")).toHaveCount(1);
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        await registration.update();
      });
      await expect
        .poll(
          async () =>
            await page.evaluate(async () => {
              const registration = await navigator.serviceWorker.ready;
              return registration.installing === null;
            }),
        )
        .toBe(true);

      // Actual connection refusal exercises both browsers' offline fetch handling.
      await server.stop();
      const response = await page.reload();
      const revision = missingAsset ? "first" : "second";
      expect(response?.headers()["x-test-revision"]).toBe(revision);
      await expect(tempo).toHaveValue("173");
      await expect(page.getByTestId("note")).toHaveCount(1);
      expect(page.url()).toBe(songURL);
      await expect(page.getByRole("status")).toHaveCount(0);
      expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

      const revisions = await page.evaluate(async () => {
        const paths = [
          ...Array.from(
            document.querySelectorAll("script[src]"),
            (script) => script.getAttribute("src") ?? "",
          ),
          "audio-worker.js",
          "audio-track-worker.js",
          "audio-export-worker.js",
          "audio-worklet.js",
          "assets/fluid-r3-mono.sf3",
        ];
        return await Promise.all(
          paths.map(async (path) => (await fetch(path)).headers.get("X-Test-Revision")),
        );
      });
      expect(new Set(revisions)).toEqual(new Set([revision]));
      const position = page.locator(".speaker span");
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect(position).not.toHaveText("1:1");
      await expect(other.getByRole("spinbutton", { name: "Tempo", exact: true })).toHaveValue(
        "173",
      );
    } finally {
      await server.stop();
    }
  });
}
