export class MidiInput {
  private access: MIDIAccess | null = null;
  private readonly active = new Map<string, Set<number>>();
  private readonly callback: (pitch: number, down: boolean) => void;
  private readonly key: () => number;
  public constructor(
    onNote: (pitch: number, down: boolean) => void,
    key: () => number = (): number => 0,
  ) {
    this.callback = onNote;
    this.key = key;
  }
  public async enable(): Promise<void> {
    if (typeof navigator.requestMIDIAccess !== "function") {
      throw new TypeError(
        "MIDI input is unavailable in this browser. Keyboard performance remains available.",
      );
    }
    this.access = await navigator.requestMIDIAccess();
    this.bind();
    this.access.addEventListener("statechange", this.rebind);
  }
  public disable(): void {
    if (this.access) {
      this.access.removeEventListener("statechange", this.rebind);
      for (const input of this.access.inputs.values()) {
        input.onmidimessage = null;
      }
    }
    for (const id of this.active.keys()) {
      this.release(id);
    }
    this.access = null;
  }
  private readonly rebind = (): void => {
    this.bind();
  };
  private release(id: string): void {
    for (const pitch of this.active.get(id) ?? []) {
      this.callback(pitch, false);
    }
    this.active.delete(id);
  }
  private bind(): void {
    if (!this.access) {
      return;
    }
    for (const input of this.access.inputs.values()) {
      if (input.state === "disconnected") {
        this.release(input.id);
        continue;
      }
      input.onmidimessage = (event): void => {
        const { data } = event;
        if (data === null || data.length < 3) {
          return;
        }
        const command = (data[0] ?? 0) & 240;
        const raw = data[1] ?? 0;
        const velocity = data[2] ?? 0;
        const pitch = raw - 12 - this.key();
        if (pitch < 0 || pitch > 108 || (command !== 144 && command !== 128)) {
          return;
        }
        let held = this.active.get(input.id);
        if (!held) {
          held = new Set();
          this.active.set(input.id, held);
        }
        const down = command === 144 && velocity > 0;
        if (down) {
          if (!held.has(pitch)) {
            held.add(pitch);
            this.callback(pitch, true);
          }
        } else if (held.delete(pitch)) {
          this.callback(pitch, false);
        }
      };
    }
  }
}
