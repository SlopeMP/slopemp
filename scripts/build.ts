import { cp, rm } from "node:fs/promises";

import { solidPlugin } from "./solid-plugin";

const outdir = new URL("../dist/web/", import.meta.url);
await rm(outdir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [
    "index.html",
    "audio-worklet.ts",
    "audio-worker.ts",
    "audio-track-worker.ts",
    "audio-export-worker.ts",
  ].map((entry) => new URL(`../src/${entry}`, import.meta.url).pathname),
  outdir: outdir.pathname,
  target: "browser",
  plugins: [solidPlugin],
  conditions: ["browser"],
  minify: true,
  publicPath: "./",
  naming: { asset: "[name].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) {
  throw new AggregateError(result.logs, "Browser build failed.");
}
await Bun.write(new URL(".nojekyll", outdir), "");

// Bun injects an inline HMR client in development; production needs neither it nor WebSockets.
const html = new URL("index.html", outdir);
await Bun.write(
  html,
  (await Bun.file(html).text())
    .replace("script-src 'self' 'unsafe-inline'", "script-src 'self'")
    .replaceAll(" ws://127.0.0.1:*", ""),
);

await cp(new URL("../public/", import.meta.url), outdir, { recursive: true });
await cp(new URL("../license/", import.meta.url), new URL("license/", outdir), { recursive: true });
await cp(new URL("../LICENSE", import.meta.url), new URL("LICENSE", outdir));

const serviceWorker = new URL("../src/service-worker/service-worker.ts", import.meta.url);
// Pages consumes _headers as configuration rather than serving it as an asset.
const precachePaths = Array.from(new Bun.Glob("**/*").scanSync(outdir.pathname))
  .filter((path) => path !== "_headers")
  .sort();
const revision = new Bun.CryptoHasher("sha256");
for (const path of precachePaths) {
  const contents = await Bun.file(new URL(path, outdir)).arrayBuffer();
  revision.update(JSON.stringify([path, contents.byteLength]));
  revision.update(contents);
}
revision.update(await Bun.file(serviceWorker).arrayBuffer());

await Bun.build({
  entrypoints: [serviceWorker.pathname],
  outdir: outdir.pathname,
  target: "browser",
  format: "iife",
  minify: true,
  define: {
    BUILD_REVISION: JSON.stringify(revision.digest("hex")),
    PRECACHE_PATHS: JSON.stringify(precachePaths),
  },
});
