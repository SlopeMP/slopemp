import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative } from "node:path";

// A separate origin lets tests replace a deployment and really stop its server,
// including in Firefox where offline emulation does not affect service workers.
export const startPWAServer = async (): Promise<{
  url: string;
  deploy: (revision: string, missingAsset?: boolean) => void;
  stop: () => Promise<void>;
}> => {
  const root = new URL("../../dist/web/", import.meta.url).pathname;
  const paths = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== "service-worker.js")
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
  let revision = "first";
  let worker = "";
  const deploy = (nextRevision: string, missingAsset = false): void => {
    revision = nextRevision;
    worker = execFileSync(
      "bun",
      [
        "build",
        new URL("../../src/service-worker/service-worker.ts", import.meta.url).pathname,
        "--target=browser",
        "--format=iife",
        "--define",
        `BUILD_REVISION=${JSON.stringify(revision)}`,
        "--define",
        `PRECACHE_PATHS=${JSON.stringify(missingAsset ? [...paths, "missing.txt"] : paths)}`,
      ],
      { encoding: "utf8" },
    );
  };
  deploy(revision);

  const server = createServer((request, response) => {
    const serve = async (): Promise<void> => {
      const { pathname } = new URL(request.url ?? "/", "http://localhost");
      const path = pathname === "/slopemp/" ? "index.html" : pathname.slice("/slopemp/".length);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      response.setHeader("X-Test-Revision", revision);
      if (path === "service-worker.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(worker);
        return;
      }
      const types: Record<string, string> = {
        html: "text/html",
        js: "text/javascript",
        css: "text/css",
        wasm: "application/wasm",
        webmanifest: "application/manifest+json",
      };
      try {
        const body = await readFile(join(root, path));
        response.setHeader(
          "Content-Type",
          types[path.split(".").at(-1) ?? ""] ?? "application/octet-stream",
        );
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end("Not found");
      }
    };
    void serve();
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The PWA test server did not bind a port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/slopemp/`,
    deploy,
    stop: async (): Promise<void> => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeAllConnections();
      });
    },
  };
};
