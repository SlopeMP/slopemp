import { expect, test } from "bun:test";

import { AssetLoads } from "../../src/asset-loads";
import { required } from "../../src/model";

test("discarding a source aborts its load without allowing its completion to discard a replacement", async () => {
  const loads = new AssetLoads();
  const signals: AbortSignal[] = [];
  const completions: Array<() => void> = [];
  const load = async (signal: AbortSignal): Promise<void> => {
    signals.push(signal);
    await new Promise<void>((resolve) => {
      completions.push(resolve);
    });
  };
  loads.start("font", load);
  loads.start("font", load);
  const original = required(loads.get("font"));
  await Promise.resolve();
  expect(signals).toHaveLength(1);
  expect(required(signals[0]).aborted).toBe(false);

  loads.retain(new Set());
  expect(required(signals[0]).aborted).toBe(true);
  expect(loads.has("font")).toBe(false);
  loads.start("font", load);
  const replacement = required(loads.get("font"));
  expect(replacement).not.toBe(original);
  await Promise.resolve();
  required(completions[0])();
  await original;
  expect(loads.get("font")).toBe(replacement);
  expect(required(signals[1]).aborted).toBe(false);
  required(completions[1])();
  await replacement;
  expect(loads.has("font")).toBe(false);
});

test("retaining sources cancels queued work before it starts while preserving wanted work", async () => {
  const loads = new AssetLoads();
  const started: string[] = [];
  for (const key of ["wanted", "removed"]) {
    loads.start(key, async () => {
      started.push(key);
      await Promise.resolve();
    });
  }
  const wanted = required(loads.get("wanted"));
  const removed = required(loads.get("removed"));
  loads.retain(new Set(["wanted"]));
  await Promise.all([wanted, removed]);
  expect(started).toEqual(["wanted"]);
  expect(loads.has("wanted")).toBe(false);
  expect(loads.has("removed")).toBe(false);
});
