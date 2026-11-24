import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspect } from "node:util";

import { createMultiplayerServer } from "./server";
import { loadSong, saveSong } from "./song-file";

const runtimeDirectory = resolve("run-server");
await mkdir(runtimeDirectory, { recursive: true });
const configPath = resolve(runtimeDirectory, "config.toml");
const defaults = { host: "127.0.0.1", port: 4174, password: "", saveInterval: 60_000 };
const defaultConfig = `host = "${defaults.host}"
port = ${defaults.port}
password = "${defaults.password}"
save_interval_ms = ${defaults.saveInterval}
# tls_cert = "cert.pem"
# tls_key = "key.pem"
`;

const configText = await readFile(configPath, "utf8").catch(async (error: unknown) => {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }

  const temporary = resolve(runtimeDirectory, `.config.toml.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, defaultConfig, { flag: "wx", mode: 0o600 });
    // Publish the complete file without replacing a config created by another startup.
    await link(temporary, configPath);
    return defaultConfig;
  } catch (creationError) {
    if (
      creationError instanceof Error &&
      "code" in creationError &&
      creationError.code === "EEXIST"
    ) {
      return await readFile(configPath, "utf8");
    }
    throw creationError;
  } finally {
    await rm(temporary, { force: true });
  }
});
const config: Record<string, unknown> = { ...Bun.TOML.parse(configText) };
const hostname = config["host"] ?? defaults.host;
const port = config["port"] ?? defaults.port;
const password = config["password"] ?? defaults.password;
const certificate = config["tls_cert"];
const key = config["tls_key"];
const saveInterval = config["save_interval_ms"] ?? defaults.saveInterval;
const songPath = resolve(runtimeDirectory, "currentsong.slopemp");

if (typeof hostname !== "string" || typeof password !== "string") {
  throw new TypeError(`host and password in ${configPath} must be strings.`);
}
if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`port in ${configPath} must be an integer from 0 to 65535.`);
}
if (certificate !== undefined || key !== undefined) {
  if (typeof certificate !== "string" || typeof key !== "string") {
    throw new TypeError(`Set both tls_cert and tls_key in ${configPath} to enable TLS.`);
  }
}
if (
  typeof saveInterval !== "number" ||
  !Number.isInteger(saveInterval) ||
  saveInterval < 1 ||
  saveInterval > 2_147_483_647
) {
  throw new Error(`save_interval_ms in ${configPath} must be an integer from 1 to 2147483647.`);
}

const server = createMultiplayerServer({
  song: await loadSong(songPath),
  hostname,
  port,
  password,
  ...(typeof certificate === "string" &&
    typeof key === "string" && {
      tls: {
        cert: Bun.file(resolve(runtimeDirectory, certificate)),
        key: Bun.file(resolve(runtimeDirectory, key)),
      },
    }),
});
const save = async (): Promise<void> => {
  await saveSong(songPath, server.getSong());
};
let saving: Promise<void> | null = null;
const savePeriodically = async (): Promise<void> => {
  try {
    await save();
  } catch (error) {
    process.stderr.write(`Could not save ${songPath}. ${inspect(error)}\n`);
  } finally {
    saving = null;
  }
};
const timer = setInterval(() => {
  saving ??= savePeriodically();
}, saveInterval);

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  clearInterval(timer);
  try {
    try {
      await server.stop(true);
    } finally {
      if (saving) {
        await saving;
      }
      await save();
    }
  } catch (error) {
    process.stderr.write(`Could not finish shutdown and save ${songPath}. ${inspect(error)}\n`);
    process.exitCode = 1;
  }
};
const stop = (): void => {
  void shutdown();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const address = new URL(server.url);
address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
process.stdout.write(`SlopeMP multiplayer server listening at ${address.href}\n`);
