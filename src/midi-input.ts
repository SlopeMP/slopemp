type InputNotes = { input: MIDIInput; notes: Map<number, number> };

export class MidiInput {
  private access: MIDIAccess | null = null;
  private request = 0;
  private readonly inputs = new Map<string, InputNotes>();
  private readonly active = new Map<number, number>();
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
    this.disable();
    if (typeof navigator.requestMIDIAccess !== "function") {
      throw new TypeError(
        "MIDI input is unavailable in this browser. Keyboard performance remains available.",
      );
    }
    const { request } = this;
    const access = await navigator.requestMIDIAccess();
    if (request !== this.request) {
      return;
    }
    this.access = access;
    this.bind();
    access.addEventListener("statechange", this.rebind);
  }
  public disable(): void {
    this.request++;
    this.access?.removeEventListener("statechange", this.rebind);
    for (const id of this.inputs.keys()) {
      this.unbind(id);
    }
    this.access = null;
  }
  private readonly rebind = (): void => {
    this.bind();
  };
  private release(held: InputNotes, note: number): void {
    const pitch = held.notes.get(note);
    if (pitch === undefined) {
      return;
    }
    held.notes.delete(note);
    const count = this.active.get(pitch) ?? 0;
    if (count > 1) {
      this.active.set(pitch, count - 1);
    } else {
      this.active.delete(pitch);
      this.callback(pitch, false);
    }
  }
  private unbind(id: string): void {
    const held = this.inputs.get(id);
    if (!held) {
      return;
    }
    held.input.onmidimessage = null;
    for (const note of held.notes.keys()) {
      this.release(held, note);
    }
    this.inputs.delete(id);
  }
  private receive(held: InputNotes, data: Uint8Array | null): void {
    if (data === null || data.length < 3) {
      return;
    }
    const status = data[0] ?? 0;
    const command = status & 240;
    if (command !== 144 && command !== 128) {
      return;
    }
    const raw = data[1] ?? 0;
    const velocity = data[2] ?? 0;
    const note = (status & 15) * 128 + raw;
    if (command === 128 || velocity === 0) {
      // Match the note-on identity even if the song's key changed while held.
      this.release(held, note);
      return;
    }
    const pitch = raw - 12 - this.key();
    if (pitch < 0 || pitch > 108 || held.notes.has(note)) {
      return;
    }
    held.notes.set(note, pitch);
    const count = this.active.get(pitch) ?? 0;
    this.active.set(pitch, count + 1);
    // Layered channels and duplicate device ports must share one sounding note.
    if (count === 0) {
      this.callback(pitch, true);
    }
  }
  private bind(): void {
    if (!this.access) {
      return;
    }
    for (const [id, held] of this.inputs) {
      if (this.access.inputs.get(id) !== held.input || held.input.state === "disconnected") {
        this.unbind(id);
      }
    }
    for (const input of this.access.inputs.values()) {
      if (input.state === "disconnected" || this.inputs.has(input.id)) {
        continue;
      }
      const held: InputNotes = { input, notes: new Map() };
      this.inputs.set(input.id, held);
      input.onmidimessage = (event): void => {
        this.receive(held, event.data);
      };
    }
  }
}
