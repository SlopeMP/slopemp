import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import type { AudioCommand } from "../../src/audio";
import { createEffect, createEnvelope, createInstrument } from "../../src/instruments";
import { createSong, required } from "../../src/model";
import type { Song } from "../../src/model";
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

const midiSong = (): Song => {
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
  return song;
};

const setupMidi = async (page: Page, song = midiSong()): Promise<void> => {
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
};

test("MIDI layers and duplicate ports sustain one note until its last release or disconnect", async ({
  page,
}) => {
  await setupMidi(page);

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

const audioTime = async (page: Page): Promise<number> =>
  await page.evaluate(() => {
    const context: unknown = Reflect.get(globalThis, "audioOutputContext");
    if (!(context instanceof AudioContext)) {
      throw new TypeError("Missing audio output clock");
    }
    return context.currentTime;
  });

const waitForAudio = async (page: Page, seconds: number): Promise<void> => {
  const start = await audioTime(page);
  await expect
    .poll(async () => (await audioTime(page)) - start, { intervals: [20] })
    .toBeGreaterThan(seconds);
};

const outputRMS = async (page: Page): Promise<number> =>
  await page.evaluate(() => Number(Reflect.get(globalThis, "audioOutputRMS")));

test("held MIDI effect envelopes retain their decay through chord edits and transport bars", async ({
  page,
}) => {
  const song = midiSong();
  song.tempo = 300;
  song.beatsPerBar = 1;
  song.loopStart = 0;
  song.loopEnd = 2;
  const instrument = required(required(song.channels[0]).instruments[0]);
  instrument.volume = 0.02;
  const gain = createEffect("Gain");
  gain.parameters["gain"] = 24;
  instrument.effects = [gain];
  instrument.envelopes = [
    {
      ...createEnvelope(),
      type: "Decay",
      target: `effect:${gain.id}:gain`,
      timeBasis: "seconds",
      a: 1,
      b: 0,
      speed: 1,
    },
  ];
  await setupMidi(page, song);
  await sendMidi(page, "primary", [144, 60, 100]);
  await expectAudible(page);
  await waitForAudio(page, 1.5);
  const settled = await outputRMS(page);
  expect(settled).toBeGreaterThan(0.001);

  // A reset boosts the whole held chord by up to 24 dB. Adding a voice alone
  // stays within this generous bound, including oscillator phase differences.
  for (const message of [
    [144, 64, 100],
    [128, 64, 0],
  ]) {
    await sendMidi(page, "primary", message);
    await waitForAudio(page, 0.12);
    const level = await outputRMS(page);
    expect(level).toBeGreaterThan(settled * 0.5);
    expect(level).toBeLessThan(settled * 3);
  }

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await waitForAudio(page, 1.5);
  // Empty score bars last 200 ms. They must not restart a MIDI note's envelope.
  for (let bar = 0; bar < 3; bar++) {
    await waitForAudio(page, 0.2);
    const level = await outputRMS(page);
    expect(level).toBeGreaterThan(settled * 0.5);
    expect(level).toBeLessThan(settled * 2);
  }
  await sendMidi(page, "primary", [128, 60, 0]);
  await expectSilent(page);
});
