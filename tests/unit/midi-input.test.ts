import { expect, test } from "bun:test";

import { MidiInput } from "../../src/midi-input";

class FakeInput {
  public readonly id: string;
  public state: "connected" | "disconnected" = "connected";
  public onmidimessage: ((event: { data: Uint8Array | null }) => void) | null = null;

  public constructor(id: string) {
    this.id = id;
  }

  public send(...bytes: number[]): void {
    this.onmidimessage?.({ data: new Uint8Array(bytes) });
  }
}

class FakeAccess extends EventTarget {
  public readonly inputs = new Map<string, FakeInput>();

  public add(id: string): FakeInput {
    const input = new FakeInput(id);
    this.inputs.set(id, input);
    return input;
  }

  public changed(): void {
    this.dispatchEvent(new Event("statechange"));
  }
}

type Fixture = {
  access: FakeAccess;
  input: MidiInput;
  events: Array<[number, boolean]>;
  setKey: (value: number) => void;
};

const withMidi = async (
  run: (fixture: Fixture) => Promise<void>,
  request?: (access: FakeAccess) => Promise<FakeAccess>,
): Promise<void> => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const access = new FakeAccess();
  const events: Array<[number, boolean]> = [];
  let key = 0;
  const input = new MidiInput(
    (pitch, down) => {
      events.push([pitch, down]);
    },
    () => key,
  );
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      requestMIDIAccess: async (): Promise<FakeAccess> =>
        request ? await request(access) : access,
    },
  });
  try {
    await run({
      access,
      input,
      events,
      setKey: (value) => {
        key = value;
      },
    });
  } finally {
    input.disable();
    if (previous) {
      Object.defineProperty(globalThis, "navigator", previous);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  }
};

test("MIDI input decodes notes, zero-velocity releases, and ignores unrelated messages", async () => {
  await withMidi(async ({ access, input, events }) => {
    const keyboard = access.add("keyboard");
    await input.enable();
    keyboard.send(144, 60, 100);
    keyboard.send(144, 60, 100);
    keyboard.send(176, 1, 127);
    keyboard.send(248);
    keyboard.send(144, 11, 100);
    keyboard.send(128, 65, 0);
    expect(events).toEqual([[48, true]]);
    keyboard.send(144, 60, 0);
    keyboard.send(145, 64, 80);
    keyboard.send(129, 64, 64);
    expect(events).toEqual([
      [48, true],
      [48, false],
      [52, true],
      [52, false],
    ]);
  });
});

test("overlapping MIDI ports neither retrigger nor release another port's held note", async () => {
  await withMidi(async ({ access, input, events }) => {
    const first = access.add("usb");
    const second = access.add("virtual");
    await input.enable();
    first.send(144, 60, 100);
    second.send(144, 60, 100);
    expect(events).toEqual([[48, true]]);
    first.send(128, 60, 0);
    expect(events).toEqual([[48, true]]);
    second.send(128, 60, 0);
    expect(events).toEqual([
      [48, true],
      [48, false],
    ]);
  });
});

test("MIDI channels retain their own held notes when the same pitch overlaps", async () => {
  await withMidi(async ({ access, input, events }) => {
    const keyboard = access.add("layered-keyboard");
    await input.enable();
    keyboard.send(144, 60, 100);
    keyboard.send(145, 60, 100);
    keyboard.send(128, 60, 0);
    expect(events).toEqual([[48, true]]);
    keyboard.send(129, 60, 0);
    expect(events).toEqual([
      [48, true],
      [48, false],
    ]);
  });
});

test("MIDI note-off releases the original pitch after the song key changes", async () => {
  await withMidi(async ({ access, input, events, setKey }) => {
    const keyboard = access.add("keyboard");
    await input.enable();
    setKey(2);
    keyboard.send(144, 60, 100);
    setKey(7);
    keyboard.send(128, 60, 0);
    expect(events).toEqual([
      [46, true],
      [46, false],
    ]);
  });
});

test("removing a MIDI input detaches it and releases only notes no longer held elsewhere", async () => {
  await withMidi(async ({ access, input, events }) => {
    const first = access.add("usb");
    const second = access.add("virtual");
    await input.enable();
    first.send(144, 60, 100);
    first.send(144, 64, 100);
    second.send(144, 60, 100);
    events.length = 0;
    access.inputs.delete(first.id);
    access.changed();
    expect(first.onmidimessage).toBeNull();
    expect(events).toEqual([[52, false]]);
    second.send(128, 60, 0);
    expect(events).toEqual([
      [52, false],
      [48, false],
    ]);
  });
});

test("disconnect and disable release held notes and detach MIDI handlers", async () => {
  await withMidi(async ({ access, input, events }) => {
    const keyboard = access.add("keyboard");
    await input.enable();
    keyboard.send(144, 60, 100);
    keyboard.state = "disconnected";
    access.changed();
    expect(keyboard.onmidimessage).toBeNull();
    expect(events).toEqual([
      [48, true],
      [48, false],
    ]);
    keyboard.state = "connected";
    access.changed();
    keyboard.send(144, 64, 100);
    input.disable();
    expect(keyboard.onmidimessage).toBeNull();
    expect(events.at(-1)).toEqual([52, false]);
    access.changed();
    expect(keyboard.onmidimessage).toBeNull();
  });
});

test("disabling MIDI while permission is pending cannot reactivate input later", async () => {
  const pending = Promise.withResolvers<FakeAccess>();
  await withMidi(
    async ({ access, input, events }) => {
      const keyboard = access.add("keyboard");
      const enabling = input.enable();
      input.disable();
      pending.resolve(access);
      await enabling;
      expect(keyboard.onmidimessage).toBeNull();
      access.changed();
      keyboard.send(144, 60, 100);
      expect(events).toEqual([]);
    },
    async () => await pending.promise,
  );
});
