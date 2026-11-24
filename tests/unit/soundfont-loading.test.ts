import { expect, test } from "bun:test";

import { hasAudioResource, removeAudioResource } from "../../src/audio";
import { required } from "../../src/model";
import { loadSoundFont } from "../../src/soundfont-loader";

test("SoundFont loads serialize fetching and skip cancelled queued assets", async () => {
  const data = await Bun.file(
    new URL("../assets/florestan-subset.sf2", import.meta.url),
  ).arrayBuffer();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const responses: Array<(response: Response) => void> = [];
  const ids = ["queued-first", "queued-cancelled", "queued-last"];
  const controller = new AbortController();
  try {
    const fetchFont = async (input: RequestInfo | URL): Promise<Response> => {
      requests.push(input instanceof Request ? input.url : String(input));
      return await new Promise<Response>((resolve) => {
        responses.push(resolve);
      });
    };
    Reflect.set(globalThis, "fetch", fetchFont);
    const first = loadSoundFont(required(ids[0]), "https://fonts.test/first.sf2");
    const cancelled = loadSoundFont(
      required(ids[1]),
      "https://fonts.test/cancelled.sf2",
      controller.signal,
    );
    const last = loadSoundFont(required(ids[2]), "https://fonts.test/last.sf2");
    await Promise.resolve();
    expect(requests).toEqual(["https://fonts.test/first.sf2"]);
    const reason = new Error("Cancelled queued font");
    const rejected = Promise.allSettled([cancelled]);
    controller.abort(reason);
    expect(await rejected).toEqual([{ status: "rejected", reason }]);
    required(responses.shift())(new Response(data));
    expect((await first).length).toBeGreaterThan(0);
    await Promise.resolve();
    expect(requests).toEqual(["https://fonts.test/first.sf2", "https://fonts.test/last.sf2"]);
    required(responses.shift())(new Response(data));
    expect((await last).length).toBeGreaterThan(0);
    expect(hasAudioResource(required(ids[1]))).toBe(false);
  } finally {
    Reflect.set(globalThis, "fetch", originalFetch);
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
