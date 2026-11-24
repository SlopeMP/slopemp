import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import { encodeWire } from "@slopemp/song";
import type { Song } from "@slopemp/song";

export const startMultiplayer = async (
  song: Song,
  password = "",
  port = 0,
): Promise<{ address: string; port: number; stop: () => Promise<void> }> => {
  const child = spawn("bun", ["tests/e2e/run-multiplayer-server.ts"], {
    env: {
      ...process.env,
      SLOPEMP_TEST_SONG: encodeWire(song),
      SLOPEMP_TEST_SERVER_PASSWORD: password,
      SLOPEMP_TEST_SERVER_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const address = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`Test multiplayer server exited with code ${String(code)}.`));
    });
    lines.once("line", resolve);
  });
  lines.close();
  return {
    address,
    port: Number(new URL(address).port),
    stop: async (): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill();
        await stopped;
      }
    },
  };
};
