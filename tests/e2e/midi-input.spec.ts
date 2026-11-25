import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import type { AudioCommand } from "../../src/audio";
import { createInstrument } from "../../src/instruments";
import { createSong, required } from "../../src/model";
import { encodeSong } from "../../src/storage";
import { expectAudible, probeOutput } from "./audio-output";
import { seedStorage } from "./stored-state";

const sendMidi = async (page: Page, input: string, data: number[]): Promise<void> => {
  await page.evaluate(
    (message) => {
      const send: unknown = Reflect.get(globalThis, "sendTestMidi");
      if (typeof send !== "function") {
        throw new TypeError("Missing MIDI input fixture");
      }
      Reflect.apply(send, undefined, [message.input, message.data]);
      Reflect.set(globalThis, "audioOutputRMS", Number.NaN);
    },
    { input, data },
  );
};

const commands = async (page: Page): Promise<unknown> =>
  await page.evaluate((): unknown => Reflect.get(globalThis, "midiAudioCommands"));

const expectSilent = async (page: Page): Promise<void> => {
  await expect
    .poll(async () => await page.evaluate(() => Number(Reflect.get(globalThis, "audioOutputRMS"))))
    .toBeLessThan(0.000001);
};

test("MIDI layers and duplicate ports sustain one note until its last release or disconnect", async ({
  page,
}) => {
  await seedStorage(page, { preferences: { midi: true, audioThreads: 1 } });
  await probeOutput(page);
  await page.addInitScript(() => {
    type Input = {
      id: string;
      state: "connected" | "disconnected";
      onmidimessage: ((event: { data: Uint8Array }) => void) | null;
    };
    const inputs = new Map<string, Input>(
      ["primary", "duplicate"].map((id) => [id, { id, state: "connected", onmidimessage: null }]),
    );
    const access = Object.assign(new EventTarget(), { inputs });
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      value: async (): Promise<typeof access> => {
        await Promise.resolve();
        return access;
      },
    });
    Reflect.set(globalThis, "testMidiReady", () =>
      [...inputs.values()].every((input) => typeof input.onmidimessage === "function"),
    );
    Reflect.set(globalThis, "sendTestMidi", (id: string, data: number[]) => {
      const input = inputs.get(id);
      if (!input?.onmidimessage) {
        throw new TypeError("MIDI input is not listening");
      }
      input.onmidimessage({ data: Uint8Array.from(data) });
    });
    Reflect.set(globalThis, "disconnectTestMidi", (id: string) => {
      inputs.delete(id);
      access.dispatchEvent(new Event("statechange"));
      Reflect.set(globalThis, "audioOutputRMS", Number.NaN);
    });
    const observed: Array<{ type: string; pitch: number }> = [];
    Reflect.set(globalThis, "midiAudioCommands", observed);
    class ObservedWorker extends Worker {
      public override postMessage(
        command: AudioCommand,
        options: StructuredSerializeOptions | Transferable[] = [],
      ): void {
        if (command.type === "audition" || command.type === "release") {
          observed.push({ type: command.type, pitch: command.pitch });
        }
        super.postMessage(command, Array.isArray(options) ? { transfer: options } : options);
      }
    }
    Reflect.set(globalThis, "Worker", ObservedWorker);
  });
  const song = createSong();
  song.key = 0;
  const channel = required(song.channels[0]);
  song.channels = [channel];
  channel.cells.fill(0);
  const instrument = createInstrument("Custom chip wave");
  instrument.attack = 0;
  instrument.release = 0;
  instrument.effects = [];
  channel.instruments = [instrument];
  await page.goto(`./#${encodeSong(song)}`);
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const ready: unknown = Reflect.get(globalThis, "testMidiReady");
          return typeof ready === "function" && Reflect.apply(ready, undefined, []) === true;
        }),
    )
    .toBe(true);

  // A trusted piano press unlocks browser audio before synthetic MIDI messages.
  const piano = page.getByRole("button", { name: "Play C 4", exact: true });
  await piano.hover();
  await page.mouse.down();
  await expectAudible(page);
  await page.mouse.up();
  await expectSilent(page);
  await page.evaluate(() => {
    const observed: unknown = Reflect.get(globalThis, "midiAudioCommands");
    if (!Array.isArray(observed)) {
      throw new TypeError("Missing MIDI audio command observer");
    }
    observed.length = 0;
  });

  await sendMidi(page, "primary", [144, 60, 100]);
  await sendMidi(page, "primary", [145, 60, 100]);
  await sendMidi(page, "duplicate", [144, 60, 100]);
  await expect.poll(async () => await commands(page)).toEqual([{ type: "audition", pitch: 48 }]);
  await expectAudible(page);
  await sendMidi(page, "primary", [128, 60, 0]);
  expect(await commands(page)).toEqual([{ type: "audition", pitch: 48 }]);
  await expectAudible(page);
  await sendMidi(page, "primary", [145, 60, 0]);
  expect(await commands(page)).toEqual([{ type: "audition", pitch: 48 }]);
  await expectAudible(page);
  await sendMidi(page, "duplicate", [128, 60, 0]);
  expect(await commands(page)).toEqual([
    { type: "audition", pitch: 48 },
    { type: "release", pitch: 48 },
  ]);
  await expectSilent(page);

  await sendMidi(page, "primary", [144, 64, 100]);
  await sendMidi(page, "duplicate", [144, 64, 100]);
  await expectAudible(page);
  for (const [index, id] of ["primary", "duplicate"].entries()) {
    await page.evaluate((input) => {
      const disconnect: unknown = Reflect.get(globalThis, "disconnectTestMidi");
      if (typeof disconnect !== "function") {
        throw new TypeError("Missing MIDI disconnect fixture");
      }
      Reflect.apply(disconnect, undefined, [input]);
    }, id);
    expect(await commands(page)).toEqual([
      { type: "audition", pitch: 48 },
      { type: "release", pitch: 48 },
      { type: "audition", pitch: 52 },
      ...(index === 1 ? [{ type: "release", pitch: 52 }] : []),
    ]);
    if (index === 0) {
      await expectAudible(page);
    } else {
      await expectSilent(page);
    }
  }
});
