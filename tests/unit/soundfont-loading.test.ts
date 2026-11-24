import { expect, test } from "bun:test";

import { hasAudioResource, removeAudioResource } from "../../src/audio";
import { required } from "../../src/model";
import { loadSoundFont } from "../../src/soundfont-loader";

test("SoundFont loads serialize reading and skip cancelled queued assets", async () => {
  const data = await Bun.file(
    new URL("../assets/florestan-subset.sf2", import.meta.url),
  ).arrayBuffer();
  const reads: string[] = [];
  const completions: Array<(data: ArrayBuffer) => void> = [];
  const ids = ["queued-first", "queued-cancelled", "queued-last"] as const;
  const controller = new AbortController();
  const read = (id: string) => async (): Promise<ArrayBuffer> => {
    reads.push(id);
    return await new Promise((resolve) => {
      completions.push(resolve);
    });
  };
  const [firstId, cancelledId, lastId] = ids;
  try {
    const first = loadSoundFont(firstId, read(firstId));
    const cancelled = loadSoundFont(cancelledId, read(cancelledId), controller.signal);
    const last = loadSoundFont(lastId, read(lastId));
    await Promise.resolve();
    expect(reads).toEqual([firstId]);
    const reason = new Error("Cancelled queued font");
    const rejected = Promise.allSettled([cancelled]);
    controller.abort(reason);
    expect(await rejected).toEqual([{ status: "rejected", reason }]);
    required(completions.shift())(data);
    expect((await first).length).toBeGreaterThan(0);
    await Promise.resolve();
    expect(reads).toEqual([firstId, lastId]);
    required(completions.shift())(data);
    expect((await last).length).toBeGreaterThan(0);
    expect(hasAudioResource(cancelledId)).toBe(false);
  } finally {
    for (const id of ids) {
      removeAudioResource(id);
    }
  }
});

test("a failed SoundFont load releases the next queued asset", async () => {
  const data = await Bun.file(
    new URL("../assets/florestan-subset.sf2", import.meta.url),
  ).arrayBuffer();
  const first = loadSoundFont("queued-invalid", new ArrayBuffer(0));
  const next = loadSoundFont("queued-recovered", data);
  try {
    expect(await first.catch((error: unknown) => error)).toEqual(
      new Error("The file is not a valid SF2 or SF3 SoundFont."),
    );
    expect((await next).length).toBeGreaterThan(0);
  } finally {
    removeAudioResource("queued-invalid");
    removeAudioResource("queued-recovered");
  }
});
