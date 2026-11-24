import { evaluateAutomation } from "./audio";
import { exportSequence } from "./formats";
import type { ExportOptions } from "./formats";
import { createEffect, presetInstrument } from "./instruments";
import {
  clone,
  createChannel,
  createNote,
  createSong,
  emptyPattern,
  notesTie,
  required,
  uid,
} from "./model";
import type { Note, Song } from "./model";
import { evaluatePin } from "./operations";
export const KEYBOARD_ROWS = [
  ["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Slash"],
  ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote"],
  [
    "KeyQ",
    "KeyW",
    "KeyE",
    "KeyR",
    "KeyT",
    "KeyY",
    "KeyU",
    "KeyI",
    "KeyO",
    "KeyP",
    "BracketLeft",
    "BracketRight",
    "Backslash",
  ],
  [
    "Digit1",
    "Digit2",
    "Digit3",
    "Digit4",
    "Digit5",
    "Digit6",
    "Digit7",
    "Digit8",
    "Digit9",
    "Digit0",
    "Minus",
    "Equal",
  ],
];
// Keyboard layouts map physical key positions to Wicki-Hayden, scale steps or piano intervals.
// Piano layouts may stay anchored to C/A or transpose to the song key.
export const keyboardPitch = (
  code: string,
  layout: string,
  octave: number,
  key = 0,
  scale: number[] = [0, 2, 4, 5, 7, 9, 11],
): number | undefined => {
  let row = -1;
  let column = -1;
  for (let r = 0; r < KEYBOARD_ROWS.length; r++) {
    const c = required(KEYBOARD_ROWS[r]).indexOf(code);
    if (c !== -1) {
      row = r;
      column = c;
      break;
    }
  }
  if (row < 0) {
    return undefined;
  }
  let pitch = Number.NaN;
  const name = layout.toLowerCase();
  if (name.includes("wicki")) {
    pitch = octave * 12 - 2 + column * 2 + row * 5;
  } else if (name.includes("selected") || name === "scale") {
    const index = column;
    const pitches = [...new Set(scale)].sort((a, b): number => a - b);
    pitch =
      octave * 12 +
      (row - 1) * 12 +
      Math.floor(index / pitches.length) * 12 +
      (pitches[index % pitches.length] ?? 0);
  } else {
    const minor = name.includes("minor");
    const transposing = name.includes("transposing");
    const white = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const black = minor
      ? [-1, 1, undefined, 4, 6, undefined, 9, 11]
      : [undefined, 1, 3, undefined, 6, 8, 10];
    const index = column % 7;
    const extra = Math.floor(column / 7) * 12;
    const interval = row % 2 === 0 ? white[index] : black[index];
    if (interval !== undefined) {
      pitch =
        octave * 12 +
        (row >= 2 ? 12 : 0) +
        extra +
        interval +
        (transposing ? 0 : (minor ? 9 : 0) - key);
    }
  }
  return Number.isFinite(pitch) && pitch >= 0 && pitch <= 108 ? pitch : undefined;
};
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
type CaptureEvent = {
  pitch: number;
  beat: number;
  down: boolean;
  order: number;
};
// Recording captures durations and chords, snapping to rhythm or 24 subdivisions per beat.
// Replace only bars receiving notes, split held notes at barlines, and undo the take as a group.
// Recorded expression is full strength; controllers, pitch wheel and program changes are ignored.
export class PerformanceRecorder {
  private readonly source: Song;
  private readonly channelIndex: number;
  private readonly start: number;
  private readonly snap: boolean;
  private readonly events: CaptureEvent[] = [];
  private readonly held = new Set<number>();
  private serial = 0;
  public constructor(song: Song, channelIndex: number, startBar = 0, snap = false) {
    if (song.channels[channelIndex]?.kind !== "track") {
      throw new Error("Recording requires a track.");
    }
    this.source = clone(song);
    this.channelIndex = channelIndex;
    this.start = startBar * song.beatsPerBar;
    this.snap = snap;
  }
  public noteOn(pitch: number, absoluteBeat: number): void {
    if (!Number.isInteger(pitch) || pitch < 0 || pitch > 108 || this.held.has(pitch)) {
      return;
    }
    this.held.add(pitch);
    this.events.push({
      pitch,
      beat: Math.max(this.start, absoluteBeat),
      down: true,
      order: this.serial++,
    });
  }
  public noteOff(pitch: number, absoluteBeat: number): void {
    if (!this.held.delete(pitch)) {
      return;
    }
    this.events.push({
      pitch,
      beat: Math.max(this.start, absoluteBeat),
      down: false,
      order: this.serial++,
    });
  }
  public finish(absoluteBeat: number): Song {
    for (const pitch of this.held) {
      this.noteOff(pitch, absoluteBeat);
    }
    const song = clone(this.source);
    const track = required(song.channels[this.channelIndex]);
    if (!this.events.some((event) => event.down)) {
      return song;
    }
    const subdivision = this.snap ? song.rhythm : 24;
    const tick = 1 / subdivision;
    const events = this.events
      .map((event) => ({ ...event, beat: Math.round(event.beat * subdivision) / subdivision }))
      .sort((a, b): number => a.beat - b.beat || a.order - b.order);
    const held = new Set<number>();
    const intervals: Array<{
      start: number;
      end: number;
      pitches: number[];
    }> = [];
    let previous = required(events[0]).beat;
    const onsets = new Map<number, number>();
    for (const event of events) {
      if (event.beat > previous && held.size > 0) {
        intervals.push({
          start: previous,
          end: event.beat,
          pitches: [...held].sort((a, b): number => a - b),
        });
      }
      if (event.down) {
        held.add(event.pitch);
        onsets.set(event.pitch, event.beat);
      } else {
        if ((onsets.get(event.pitch) ?? -Infinity) === event.beat) {
          intervals.push({ start: event.beat, end: event.beat + tick, pitches: [event.pitch] });
        }
        held.delete(event.pitch);
        onsets.delete(event.pitch);
      }
      previous = event.beat;
    }
    const byBar = new Map<number, Note[]>();
    for (const interval of intervals) {
      let position = interval.start;
      while (position < interval.end - 1e-9) {
        const bar = Math.floor((position + 1e-9) / song.beatsPerBar);
        const offset = position - bar * song.beatsPerBar;
        const end = Math.min(interval.end, (bar + 1) * song.beatsPerBar);
        const notes = byBar.get(bar) ?? [];
        notes.push({
          ...createNote(offset, end - bar * song.beatsPerBar, interval.pitches),
          continues: position > interval.start,
        });
        byBar.set(bar, notes);
        position = end;
      }
    }
    const lastBar = Math.max(...byBar.keys());
    if (lastBar >= song.barCount) {
      const oldCount = song.barCount;
      song.barCount = lastBar + 1;
      for (const row of song.channels) {
        for (let bar = oldCount; bar < song.barCount; bar++) {
          row.cells.push(0);
        }
      }
    }
    for (const [bar, notes] of byBar) {
      const used = new Set(track.cells);
      const number =
        Array.from({ length: song.patternCount }, (_, i): number => i + 1).find(
          (value) => !used.has(value),
        ) ?? song.patternCount + 1;
      if (number > song.patternCount) {
        song.patternCount = number;
        for (const row of song.channels) {
          row.patterns[number] ??= emptyPattern();
        }
      }
      // Chord interval normalization also retains taps that quantize to the same tick.
      const edges = [...new Set(notes.flatMap((note) => [note.start, note.end]))].sort(
        (a, b): number => a - b,
      );
      const normalized: Note[] = [];
      for (let index = 0; index < edges.length - 1; index++) {
        const start = required(edges[index]);
        const end = required(edges[index + 1]);
        const active = notes.filter((note) => note.start <= start + 1e-9 && note.end >= end - 1e-9);
        const pitches = [...new Set(active.flatMap((note) => note.pitches))];
        if (pitches.length > 0) {
          normalized.push({
            ...createNote(start, end, pitches),
            continues: active.every((note) => note.continues === true),
          });
        }
      }
      track.patterns[number] = { notes: normalized, lanes: [] };
      track.cells[bar] = number;
    }
    return song;
  }
}
export type Metronome = {
  click: (strong: boolean) => void;
  close: () => Promise<void>;
};
export const createMetronome = (): Metronome => {
  let context: AudioContext | null = null;
  return {
    click(strong): void {
      context ??= new AudioContext();
      void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.frequency.value = strong ? 1500 : 1000;
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(now + 0.05);
    },
    async close(): Promise<void> {
      if (context) {
        const closing = context;
        context = null;
        await closing.close();
      }
    },
  };
};
const midiProgram = (name: string): number => {
  const programs: Array<[RegExp, number]> = [
    [/bright piano/u, 1],
    [/electric grand/u, 2],
    [/honky/u, 3],
    [/electric piano 1/u, 4],
    [/electric piano 2/u, 5],
    [/harpsichord/u, 6],
    [/clavinet/u, 7],
    [/celesta/u, 8],
    [/glockenspiel/u, 9],
    [/music box/u, 10],
    [/vibraphone/u, 11],
    [/marimba/u, 12],
    [/xylophone/u, 13],
    [/tubular bell/u, 14],
    [/dulcimer/u, 15],
    [/organ/u, 16],
    [/accordion/u, 21],
    [/harmonica/u, 22],
    [/nylon guitar/u, 24],
    [/steel guitar/u, 25],
    [/jazz guitar/u, 26],
    [/clean guitar/u, 27],
    [/muted guitar/u, 28],
    [/overdrive/u, 29],
    [/distortion/u, 30],
    [/harmonics/u, 31],
    [/acoustic bass/u, 32],
    [/fingered bass/u, 33],
    [/picked bass/u, 34],
    [/fretless/u, 35],
    [/slap bass 1/u, 36],
    [/slap bass 2/u, 37],
    [/bass synth/u, 38],
    [/violin/u, 40],
    [/viola/u, 41],
    [/cello/u, 42],
    [/contrabass/u, 43],
    [/strings/u, 48],
    [/choir/u, 52],
    [/trumpet/u, 56],
    [/trombone/u, 57],
    [/tuba/u, 58],
    [/french horn/u, 60],
    [/sax/u, 65],
    [/oboe/u, 68],
    [/english horn/u, 69],
    [/bassoon/u, 70],
    [/clarinet/u, 71],
    [/piccolo/u, 72],
    [/flute/u, 73],
    [/recorder/u, 74],
    [/pan flute/u, 75],
    [/whistle/u, 78],
    [/ocarina/u, 79],
    [/square/u, 80],
    [/saw/u, 81],
    [/pad/u, 89],
    [/sitar/u, 104],
    [/banjo/u, 105],
    [/koto/u, 107],
    [/kalimba/u, 108],
    [/fiddle/u, 110],
    [/steel pan/u, 114],
    [/woodblock/u, 115],
  ];
  return programs.find(([pattern]): boolean => pattern.test(name))?.[1] ?? 0;
};
const programNames = [
  "grand piano",
  "bright piano",
  "electric grand",
  "honky-tonk piano",
  "electric piano 1",
  "electric piano 2",
  "harpsichord",
  "clavinet",
  "celesta",
  "glockenspiel",
  "music box 1",
  "vibraphone",
  "marimba",
  "xylophone",
  "tubular bell",
  "dulcimer",
];
const programName = (program: number): string =>
  programNames[program] ??
  (():
    | "chip noise"
    | "clarinet"
    | "drawbar organ 1"
    | "fingered bass"
    | "flute"
    | "nylon guitar"
    | "sitar"
    | "square lead"
    | "steel pan"
    | "strings"
    | "trumpet"
    | "violin"
    | "warm pad" => {
    if (program < 24) {
      return "drawbar organ 1";
    }
    return (():
      | "chip noise"
      | "clarinet"
      | "fingered bass"
      | "flute"
      | "nylon guitar"
      | "sitar"
      | "square lead"
      | "steel pan"
      | "strings"
      | "trumpet"
      | "violin"
      | "warm pad" => {
      if (program < 32) {
        return "nylon guitar";
      }
      return (():
        | "chip noise"
        | "clarinet"
        | "fingered bass"
        | "flute"
        | "sitar"
        | "square lead"
        | "steel pan"
        | "strings"
        | "trumpet"
        | "violin"
        | "warm pad" => {
        if (program < 40) {
          return "fingered bass";
        }
        return (():
          | "chip noise"
          | "clarinet"
          | "flute"
          | "sitar"
          | "square lead"
          | "steel pan"
          | "strings"
          | "trumpet"
          | "violin"
          | "warm pad" => {
          if (program < 48) {
            return "violin";
          }
          return (():
            | "chip noise"
            | "clarinet"
            | "flute"
            | "sitar"
            | "square lead"
            | "steel pan"
            | "strings"
            | "trumpet"
            | "warm pad" => {
            if (program < 56) {
              return "strings";
            }
            return (():
              | "chip noise"
              | "clarinet"
              | "flute"
              | "sitar"
              | "square lead"
              | "steel pan"
              | "trumpet"
              | "warm pad" => {
              if (program < 64) {
                return "trumpet";
              }
              return (():
                | "chip noise"
                | "clarinet"
                | "flute"
                | "sitar"
                | "square lead"
                | "steel pan"
                | "warm pad" => {
                if (program < 72) {
                  return "clarinet";
                }
                return (():
                  "chip noise" | "flute" | "sitar" | "square lead" | "steel pan" | "warm pad" => {
                  if (program < 80) {
                    return "flute";
                  }
                  return ((): "chip noise" | "sitar" | "square lead" | "steel pan" | "warm pad" => {
                    if (program < 88) {
                      return "square lead";
                    }
                    return ((): "chip noise" | "sitar" | "steel pan" | "warm pad" => {
                      if (program < 104) {
                        return "warm pad";
                      }
                      return ((): "chip noise" | "sitar" | "steel pan" => {
                        if (program < 112) {
                          return "sitar";
                        }
                        return program < 120 ? "steel pan" : "chip noise";
                      })();
                    })();
                  })();
                })();
              })();
            })();
          })();
        })();
      })();
    })();
  })();
const variableLength = (value: number): number[] => {
  let number = Math.max(0, Math.round(value));
  const bytes = [number & 127];
  while ((number >>>= 7) > 0) {
    bytes.unshift((number & 127) | 128);
  }
  return bytes;
};
const uint32 = (value: number): number[] => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];
const uint16 = (value: number): number[] => [(value >>> 8) & 255, value & 255];
type MidiEvent = { time: number; data: number[] };
type MidiSpan = { bar: number; start: number; end: number; times: number[] };
const midiPriority = (event: MidiEvent): number => {
  const kind = (event.data[0] ?? 0) & 240;
  if (kind === 128) {
    return 0;
  }
  if (kind === 144) {
    return 3;
  }
  return kind === 224 ? 2 : 1;
};
const encodeMidiTrack = (events: MidiEvent[], end: number): number[] => {
  events.sort((a, b) => a.time - b.time || midiPriority(a) - midiPriority(b));
  let previous = 0;
  const bytes: number[] = [];
  for (const event of events) {
    bytes.push(...variableLength(event.time - previous), ...event.data);
    previous = event.time;
  }
  bytes.push(...variableLength(Math.max(0, end - previous)), 255, 47, 0);
  return [77, 84, 114, 107, ...uint32(bytes.length), ...bytes];
};
const midiSampleTimes = (song: Song, bar: number, end: number): number[] => {
  const times = new Set<number>([0]);
  for (let tick = 1; tick / 24 < end; tick++) {
    times.add(tick / 24);
  }
  for (const track of song.channels) {
    const pattern = track.patterns[track.cells[bar] ?? 0];
    for (const lane of pattern?.lanes ?? []) {
      for (const point of lane.points) {
        if (point.time < end) {
          times.add(point.time);
        }
      }
      const last = lane.points.at(-1)?.time;
      if (last !== undefined && last + 1 / 480 < end) {
        times.add(last + 1 / 480);
      }
    }
    for (const note of pattern?.notes ?? []) {
      for (const time of [note.start, note.end, ...note.pins.map((pin) => note.start + pin.time)]) {
        if (time < end) {
          times.add(time);
        }
      }
    }
  }
  return [...times].filter((time) => time >= 0).sort((a, b) => a - b);
};
const midiSpans = (song: Song, sequence: number[]): MidiSpan[] => {
  let start = 0;
  return sequence.map((bar) => {
    let end = song.beatsPerBar;
    for (const track of song.channels) {
      if (track.kind !== "automation" || track.target.kind !== "song" || !track.enabled) {
        continue;
      }
      for (const lane of track.patterns[track.cells[bar] ?? 0]?.lanes ?? []) {
        if (
          !lane.enabled ||
          (lane.effectId !== undefined && lane.effectId !== "") ||
          lane.target !== "nextBar"
        ) {
          continue;
        }
        for (const point of lane.points) {
          end = Math.min(end, Math.max(1 / 24, point.time));
        }
      }
    }
    const span = { bar, start, end, times: midiSampleTimes(song, bar, end) };
    start += end;
    return span;
  });
};
const midiKeySignature = (song: Song): number[] => {
  const minor = song.scale.toLowerCase().includes("minor");
  const relativeMajor = (song.key + (minor ? 3 : 0)) % 12;
  const accidentals = required([0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5][relativeMajor]);
  return [accidentals & 255, minor ? 1 : 0];
};
const boundedMidi = (value: number): number => Math.max(0, Math.min(127, Math.round(value)));
const noteEvents = (
  song: Song,
  track: Song["channels"][number],
  span: MidiSpan,
  channel: number,
  tiedStart = false,
  tiedEnd = false,
  pitchOffset = 0,
): MidiEvent[] => {
  const events: MidiEvent[] = [];
  const instrument = required(track.instruments[0]);
  const percussion = instrument.type === "drumset";
  for (const note of track.patterns[track.cells[span.bar] ?? 0]?.notes ?? []) {
    if (note.start >= span.end) {
      continue;
    }
    const offset = note.start === 0 ? pitchOffset : 0;
    for (const [index, rawPitch] of note.pitches.entries()) {
      const raw = rawPitch - offset;
      const pitch = boundedMidi(percussion ? 35 + (raw % 12) : raw + song.key + 12);
      const start =
        span.start + note.start + (instrument.chords === "strum" ? index / song.rhythm / 2 : 0);
      const end = span.start + Math.min(note.end, span.end);
      if (start >= end) {
        continue;
      }
      const add = (onset: number, finish: number): void => {
        if (!(tiedStart && note.start === 0)) {
          events.push({ time: Math.round(onset * 480), data: [144 | channel, pitch, 100] });
        }
        if (!(tiedEnd && note.end === song.beatsPerBar)) {
          events.push({ time: Math.round(finish * 480), data: [128 | channel, pitch, 0] });
        }
      };
      if (
        instrument.chords === "arpeggio" &&
        note.pitches.length > 1 &&
        instrument.arpeggioSpeed > 0
      ) {
        const step = 1 / song.rhythm / instrument.arpeggioSpeed;
        for (let beat = start + index * step; beat < end; beat += step * note.pitches.length) {
          add(beat, Math.min(end, beat + step));
        }
      } else {
        add(start, end);
      }
    }
  }
  return events;
};
// MIDI exports performed notes, tempo/meter/key, supported expression and pitch bends.
// Timbres and audio effects are approximations; articulation becomes performed note events.
export const exportMidi = (song: Song, options: ExportOptions = {}): Uint8Array<ArrayBuffer> => {
  const sequence = exportSequence(song, options);
  const spans = midiSpans(song, sequence);
  const duration = spans.reduce((total, span) => total + span.end, 0);
  const master: MidiEvent[] = [
    { time: 0, data: [255, 88, 4, song.beatsPerBar, 2, 24, 8] },
    { time: 0, data: [255, 89, 2, ...midiKeySignature(song)] },
  ];
  let previousTempo = -1;
  for (const span of spans) {
    for (const beat of span.times) {
      const microseconds = Math.round(60_000_000 / evaluateAutomation(song, span.bar, beat).tempo);
      if (microseconds === previousTempo) {
        continue;
      }
      previousTempo = microseconds;
      master.push({
        time: Math.round((span.start + beat) * 480),
        data: [
          255,
          81,
          3,
          (microseconds >>> 16) & 255,
          (microseconds >>> 8) & 255,
          microseconds & 255,
        ],
      });
    }
  }
  const tracks: number[][] = [encodeMidiTrack(master, Math.round(duration * 480))];
  let melodic = 0;
  for (const track of song.channels) {
    if (track.kind !== "track") {
      continue;
    }
    const instrument = required(track.instruments[0]);
    const percussion = instrument.type === "drumset";
    let channel = 9;
    if (!percussion) {
      channel = melodic++ % 15;
      if (channel >= 9) {
        channel++;
      }
    }
    const pan = [...instrument.effects, ...track.effects].findLast(
      (effect) => effect.enabled && effect.type === "Pan",
    )?.parameters["position"];
    const position = typeof pan === "number" ? pan : 0;
    const title = new TextEncoder().encode(track.name);
    const events: MidiEvent[] = [
      { time: 0, data: [255, 3, ...variableLength(title.length), ...title] },
      { time: 0, data: [192 | channel, midiProgram(instrument.preset || instrument.name)] },
      { time: 0, data: [176 | channel, 10, boundedMidi(64 + (position / 100) * 64)] },
    ];
    let tiedPitchOffset = 0;
    let previousNote: Note | null = null;
    let previousEnd = 0;
    const contours = spans.flatMap((span) => {
      const notes = track.patterns[track.cells[span.bar] ?? 0]?.notes ?? [];
      const [first] = notes;
      if (
        previousNote &&
        first &&
        instrument.chords !== "arpeggio" &&
        previousEnd === song.beatsPerBar &&
        notesTie(previousNote, first, song.beatsPerBar)
      ) {
        tiedPitchOffset += previousNote.pins.at(-1)?.interval ?? 0;
      } else {
        tiedPitchOffset = 0;
      }
      const values = notes.flatMap((note) =>
        note.pins.map((pin) => Math.abs(pin.interval + (note.start === 0 ? tiedPitchOffset : 0))),
      );
      previousNote = notes.at(-1) ?? null;
      previousEnd = span.end;
      if (previousNote !== first) {
        tiedPitchOffset = 0;
      }
      return values;
    });
    const detunes = spans.flatMap((span) =>
      span.times.map((beat) => Math.abs(evaluateAutomation(song, span.bar, beat).detune) / 100),
    );
    const bendRange = Math.max(
      2,
      Math.min(127, Math.ceil(Math.max(0, ...contours) + Math.max(0, ...detunes))),
    );
    if (!percussion) {
      for (const [controller, value] of [
        [101, 0],
        [100, 0],
        [6, bendRange],
        [38, 0],
        [101, 127],
        [100, 127],
      ]) {
        events.push({ time: 0, data: [176 | channel, required(controller), required(value)] });
      }
    }
    let previousVolume = -1;
    let previousExpression = -1;
    let previousBend = -1;
    let pitchOffset = 0;
    for (const [spanIndex, span] of spans.entries()) {
      const previousSpan = spans[spanIndex - 1];
      const nextSpan = spans[spanIndex + 1];
      const previous =
        previousSpan && track.patterns[track.cells[previousSpan.bar] ?? 0]?.notes.at(-1);
      const first = track.patterns[track.cells[span.bar] ?? 0]?.notes[0];
      const last = track.patterns[track.cells[span.bar] ?? 0]?.notes.at(-1);
      const next = nextSpan && track.patterns[track.cells[nextSpan.bar] ?? 0]?.notes[0];
      const sustain = instrument.chords !== "arpeggio";
      const tiedStart =
        sustain &&
        previous !== undefined &&
        first !== undefined &&
        previousSpan?.end === song.beatsPerBar &&
        notesTie(previous, first, song.beatsPerBar);
      const tiedEnd =
        sustain &&
        last !== undefined &&
        next !== undefined &&
        span.end === song.beatsPerBar &&
        notesTie(last, next, song.beatsPerBar);
      pitchOffset = tiedStart ? pitchOffset + (previous.pins.at(-1)?.interval ?? 0) : 0;
      events.push(...noteEvents(song, track, span, channel, tiedStart, tiedEnd, pitchOffset));
      const notes = track.patterns[track.cells[span.bar] ?? 0]?.notes ?? [];
      for (const beat of span.times) {
        const time = Math.round((span.start + beat) * 480);
        const globals = evaluateAutomation(song, span.bar, beat);
        const volume = boundedMidi(((instrument.volume * globals.volume) / 100) * 127);
        if (volume !== previousVolume) {
          events.push({ time, data: [176 | channel, 7, volume] });
          previousVolume = volume;
        }
        const note = notes.find((value) => value.start <= beat && value.end > beat);
        const contour = note ? evaluatePin(note, beat - note.start) : { interval: 0, volume: 3 };
        const expression = boundedMidi((contour.volume / 3) * 127);
        if (expression !== previousExpression) {
          events.push({ time, data: [176 | channel, 11, expression] });
          previousExpression = expression;
        }
        if (percussion) {
          continue;
        }
        const semitones = Math.max(
          -bendRange,
          Math.min(
            bendRange,
            globals.detune / 100 + contour.interval + (note?.start === 0 ? pitchOffset : 0),
          ),
        );
        const bend = 8192 + Math.round((semitones / bendRange) * (semitones < 0 ? 8192 : 8191));
        if (bend !== previousBend) {
          events.push({ time, data: [224 | channel, bend & 127, (bend >>> 7) & 127] });
          previousBend = bend;
        }
      }
      if (last !== first) {
        pitchOffset = 0;
      }
    }
    tracks.push(encodeMidiTrack(events, Math.round(duration * 480)));
  }
  return Uint8Array.from([
    77,
    84,
    104,
    100,
    ...uint32(6),
    ...uint16(1),
    ...uint16(tracks.length),
    ...uint16(480),
    ...tracks.flat(),
  ]);
};
// MIDI-file import replaces the song and interprets timing, velocities, bends and programs.
// Live MIDI input instead performs into the selected channel and records only when capturing.
export const importMidi = (input: ArrayBuffer | Uint8Array): Song => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let offset = 0;
  const read = (length: number): number => {
    if (offset + length > bytes.length) {
      throw new Error("Truncated MIDI file.");
    }
    let number = 0;
    for (let index = 0; index < length; index++) {
      number = number * 256 + (bytes[offset++] ?? 0);
    }
    return number;
  };
  const text = (length: number): string => {
    if (offset + length > bytes.length) {
      throw new Error("Truncated MIDI file.");
    }
    const value = new TextDecoder().decode(bytes.slice(offset, offset + length));
    offset += length;
    return value;
  };
  const vlq = (): number => {
    let value = 0;
    for (let count = 0; count < 4; count++) {
      const byte = read(1);
      value = value * 128 + (byte & 127);
      if (byte < 128) {
        return value;
      }
    }
    throw new Error("Invalid MIDI variable-length value.");
  };
  if (text(4) !== "MThd") {
    throw new Error("The file is not a MIDI song.");
  }
  const headerLength = read(4);
  const format = read(2);
  const trackCount = read(2);
  const division = read(2);
  if (headerLength < 6 || format > 1 || division & 32_768 || division === 0) {
    throw new Error("Unsupported MIDI format or timing.");
  }
  offset += headerLength - 6;
  const notes: Array<{
    channel: number;
    start: number;
    end: number;
    pitch: number;
    velocity: number;
  }> = [];
  const controllers = new Map<number, Array<{ beat: number; controller: number; value: number }>>();
  const bendSensitivity = new Map<
    number,
    { semitones: number; cents: number; msb: number; lsb: number }
  >();
  const programs = new Map<number, number>();
  const names = new Map<number, string>();
  const tempos: Array<{
    beat: number;
    tempo: number;
  }> = [];
  const bends = new Map<
    number,
    Array<{
      beat: number;
      value: number;
    }>
  >();
  let meter = 8;
  let key = 0;
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    if (text(4) !== "MTrk") {
      throw new Error("Invalid MIDI track header.");
    }
    const length = read(4);
    const end = offset + length;
    if (end > bytes.length) {
      throw new Error("Truncated MIDI track.");
    }
    let tick = 0;
    let status = 0;
    let name = "";
    const held = new Map<
      string,
      {
        start: number;
        velocity: number;
      }
    >();
    while (offset < end) {
      tick += vlq();
      let command = read(1);
      if (command < 128) {
        offset--;
        command = status;
      } else if (command < 240) {
        status = command;
      }
      if (command === 0) {
        throw new Error("Invalid MIDI running status.");
      }
      if (command === 255) {
        const kind = read(1);
        const size = vlq();
        const begin = offset;
        if (begin + size > end) {
          throw new Error("Invalid MIDI meta event.");
        }
        if (kind === 81 && size === 3) {
          const microseconds = read(3);
          if (microseconds > 0) {
            tempos.push({
              beat: tick / division,
              tempo: Math.max(1, Math.min(300, 60_000_000 / microseconds)),
            });
          }
        } else if (kind === 88 && size >= 2) {
          const numerator = read(1);
          const denominator = 2 ** read(1);
          meter = Math.max(1, Math.min(64, Math.round((numerator * 4) / denominator)));
        } else if (kind === 89 && size >= 2) {
          const sharps = read(1);
          const signed = sharps > 127 ? sharps - 256 : sharps;
          const minor = read(1);
          key = (((signed * 7 + (minor ? 9 : 0)) % 12) + 12) % 12;
        } else if (kind === 3) {
          name = text(size);
        }
        offset = begin + size;
        if (kind === 47) {
          break;
        }
      } else if (command === 240 || command === 247) {
        offset += vlq();
        if (offset > end) {
          throw new Error("Invalid MIDI system event.");
        }
      } else {
        const kind = command & 240;
        const channel = command & 15;
        const first = read(1);
        const second = kind === 192 || kind === 208 ? 0 : read(1);
        const id = `${channel}-${first}`;
        const beat = tick / division;
        if (kind === 144 && second > 0) {
          const previous = held.get(id);
          if (previous) {
            notes.push({
              channel,
              pitch: first,
              start: previous.start,
              end: beat,
              velocity: previous.velocity,
            });
          }
          held.set(id, { start: beat, velocity: second });
          if (name) {
            names.set(channel, name);
          }
        } else if (kind === 128 || kind === 144) {
          const note = held.get(id);
          if (note) {
            notes.push({
              channel,
              pitch: first,
              start: note.start,
              end: Math.max(note.start + 1 / 24, beat),
              velocity: note.velocity,
            });
            held.delete(id);
          }
        } else if (kind === 192) {
          programs.set(channel, first);
        } else if (kind === 176) {
          if (first === 7 || first === 11 || first === 10) {
            const values = controllers.get(channel) ?? [];
            values.push({ beat, controller: first, value: second });
            controllers.set(channel, values);
          }
          const sensitivity = bendSensitivity.get(channel) ?? {
            semitones: 2,
            cents: 0,
            msb: 127,
            lsb: 127,
          };
          if (first === 101) {
            sensitivity.msb = second;
          }
          if (first === 100) {
            sensitivity.lsb = second;
          }
          if (sensitivity.msb === 0 && sensitivity.lsb === 0) {
            if (first === 6) {
              sensitivity.semitones = second;
            }
            if (first === 38) {
              sensitivity.cents = second;
            }
          }
          bendSensitivity.set(channel, sensitivity);
        } else if (kind === 224) {
          const array = bends.get(channel) ?? [];
          const sensitivity = bendSensitivity.get(channel);
          const range = (sensitivity?.semitones ?? 2) + (sensitivity?.cents ?? 0) / 100;
          const displacement = (second << 7) + first - 8192;
          array.push({ beat, value: (displacement / (displacement < 0 ? 8192 : 8191)) * range });
          bends.set(channel, array);
        }
      }
    }
    for (const [id, note] of held) {
      const [channel, pitch] = id.split("-").map(Number);
      notes.push({
        channel: required(channel),
        pitch: required(pitch),
        start: note.start,
        end: Math.max(note.start + 1 / 24, tick / division),
        velocity: note.velocity,
      });
    }
    offset = end;
  }
  if (notes.length === 0) {
    throw new Error("The MIDI file has no notes.");
  }
  const song = createSong();
  song.title = "Imported MIDI";
  song.key = key;
  song.tempo = Math.round(tempos.find((tempo) => tempo.beat === 0)?.tempo ?? 150);
  song.beatsPerBar = meter;
  song.barCount = Math.max(1, Math.ceil(Math.max(...notes.map((note) => note.end)) / meter));
  song.loopStart = 0;
  song.loopEnd = song.barCount;
  song.patternCount = Math.max(8, song.barCount);
  song.channels = [];
  for (const channel of new Set(notes.map((note) => note.channel))) {
    const track = createChannel("track", song.barCount, song.patternCount);
    track.name = names.get(channel) ?? `MIDI ${channel + 1}`;
    track.cells.fill(0);
    track.instruments = [
      presetInstrument(
        channel === 9 ? "standard drumset" : programName(programs.get(channel) ?? 0),
      ),
    ];
    const controls = (controllers.get(channel) ?? []).toSorted((a, b) => a.beat - b.beat);
    const controlAt = (controller: number, beat: number, fallback: number): number =>
      controls.findLast((value) => value.controller === controller && value.beat <= beat)?.value ??
      fallback;
    const importedInstrument = required(track.instruments[0]);
    importedInstrument.volume = 1;
    const pan = controlAt(10, 0, 64);
    if (pan !== 64) {
      const effect = createEffect("Pan");
      effect.parameters["position"] = ((pan - 64) / 64) * 100;
      importedInstrument.effects.push(effect);
    }
    const channelNotes = notes.filter((note) => note.channel === channel);
    for (let bar = 0; bar < song.barCount; bar++) {
      const begin = bar * meter;
      const end = begin + meter;
      const intersections = channelNotes.filter((note) => note.start < end && note.end > begin);
      if (intersections.length === 0) {
        continue;
      }
      const boundaries = [
        ...new Set(
          intersections.flatMap((note) => [Math.max(begin, note.start), Math.min(end, note.end)]),
        ),
      ].sort((a, b): number => a - b);
      const pattern = emptyPattern();
      for (let index = 0; index < boundaries.length - 1; index++) {
        const start = required(boundaries[index]);
        const finish = required(boundaries[index + 1]);
        const active = intersections.filter(
          (note) => note.start <= start + 1e-9 && note.end >= finish - 1e-9,
        );
        const pitches = [
          ...new Set(
            active
              .map((note) => (channel === 9 ? (note.pitch - 35 + 120) % 12 : note.pitch - 12 - key))
              .filter((pitch) => pitch >= 0 && pitch <= 108),
          ),
        ];
        if (pitches.length === 0) {
          continue;
        }
        const strength = Math.max(...active.map((item) => item.velocity)) / 127;
        const note = createNote(start - begin, finish - begin, pitches);
        note.continues = start === begin && active.every((item) => item.start < begin);
        const pitchBends = (bends.get(channel) ?? []).toSorted((a, b) => a.beat - b.beat);
        const contourTimes = [
          ...new Set([
            start,
            finish,
            ...pitchBends
              .filter((bend) => bend.beat > start && bend.beat < finish)
              .map((bend) => bend.beat),
            ...controls
              .filter(
                (control) =>
                  (control.controller === 7 || control.controller === 11) &&
                  control.beat > start &&
                  control.beat < finish,
              )
              .map((control) => control.beat),
          ]),
        ].sort((a, b) => a - b);
        note.pins = contourTimes.map((at) => {
          const moment = at === finish ? Math.max(start, finish - 1e-9) : at;
          return {
            time: at - start,
            interval: pitchBends.findLast((bend) => bend.beat <= moment)?.value ?? 0,
            volume: Math.max(
              0,
              Math.min(
                3,
                ((((strength * controlAt(7, moment, 100)) / 127) * controlAt(11, moment, 127)) /
                  127) *
                  3,
              ),
            ),
          };
        });
        pattern.notes.push(note);
      }
      track.patterns[bar + 1] = pattern;
      track.cells[bar] = bar + 1;
    }
    song.channels.push(track);
  }
  if (tempos.some((tempo) => tempo.beat > 0)) {
    const track = createChannel("automation", song.barCount, song.patternCount);
    track.name = "MIDI tempo";
    track.cells.fill(0);
    for (let bar = 0; bar < song.barCount; bar++) {
      let base = song.tempo;
      for (const tempo of tempos) {
        if (tempo.beat <= bar * meter) {
          base = tempo.tempo;
        }
      }
      const points = [
        { time: 0, value: base },
        ...tempos
          .filter((tempo) => tempo.beat > bar * meter && tempo.beat < (bar + 1) * meter)
          .map((tempo) => ({ time: tempo.beat - bar * meter, value: tempo.tempo })),
        { time: meter, value: base },
      ];
      required(points.at(-1)).value = required(points.at(-2)).value;
      track.patterns[bar + 1] = {
        notes: [],
        lanes: [{ id: uid(), target: "tempo", enabled: true, interpolation: "hold", points }],
      };
      track.cells[bar] = bar + 1;
    }
    song.channels.push(track);
  }
  return song;
};
