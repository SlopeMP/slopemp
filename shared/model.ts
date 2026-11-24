import { BUNDLED_RESOURCES } from "./bundled-resources";
import { uid } from "./identity";
import { PRESET_GROUPS, presetInstrument, validateEffect, validateInstrument } from "./instruments";
import type { Effect, Instrument } from "./instruments";
import { dictionary, isRecord, matchesShape, optional } from "./shape";
export { uid } from "./identity";
export type { Effect, Instrument } from "./instruments";
export type Pin = {
  time: number;
  interval: number;
  volume: number;
};
export type Note = {
  id: string;
  start: number;
  end: number;
  pitches: number[];
  pins: Pin[];
  // A note at beat zero may sustain the matching chord from the previous bar.
  continues?: boolean;
};
// Compare the preceding chord at its final bend, independent of pitch order.
export const notesTie = (previous: Note, next: Note, beatsPerBar: number): boolean => {
  const interval = previous.pins.at(-1)?.interval ?? 0;
  return (
    previous.end === beatsPerBar &&
    next.start === 0 &&
    next.continues === true &&
    previous.pitches.length === next.pitches.length &&
    previous.pitches.every((pitch) => next.pitches.includes(pitch + interval))
  );
};
export type AutomationPoint = {
  time: number;
  value: number;
};
export type AutomationLane = {
  id: string;
  target: string;
  points: AutomationPoint[];
  interpolation: "hold" | "linear";
  effectId?: string;
  enabled: boolean;
};
export type Pattern = {
  notes: Note[];
  lanes: AutomationLane[];
};
export type AutomationTarget = {
  kind: "channel" | "instrument" | "song";
  channelId?: string;
  instrumentId?: string;
};
export type Channel = {
  id: string;
  name: string;
  kind: "automation" | "track";
  octave: number;
  octaves: number;
  cells: number[];
  patterns: Record<number, Pattern>;
  instruments: Instrument[];
  effects: Effect[];
  target: AutomationTarget;
  enabled: boolean;
};
export const trackOctave = (track: Channel): number => Math.min(track.octave, 9 - track.octaves);
export type ResourceMetadata = {
  bundled?: boolean;
  license?: string;
  revision?: string;
};
export type Resource = {
  id: string;
  url: string;
  rootKey?: number;
  start?: number;
  loopStart?: number;
  loopEnd?: number;
  mode?: string;
  backwards?: boolean;
  metadata?: ResourceMetadata;
};
export type Song = {
  version: number;
  id: string;
  title: string;
  key: number;
  scale: string;
  customScale: number[];
  tempo: number;
  rhythm: 3 | 4 | 6 | 8 | 24;
  beatsPerBar: number;
  barCount: number;
  patternCount: number;
  loopStart: number;
  loopEnd: number;
  volume: number;
  detune: number;
  channels: Channel[];
  resources: Resource[];
};
export const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Required song data is missing.");
  }
  return value;
};
export const clone = <T>(value: T): T => structuredClone(value);
export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
export const integer = (value: number, min: number, max = Number.MAX_SAFE_INTEGER): number =>
  Math.round(clamp(value, min, max));
export const emptyPattern = (): Pattern => ({ notes: [], lanes: [] });
export const createNote = (
  start: number,
  end: number,
  pitches: number[] | number,
  volume = 3,
): Note => ({
  id: uid(),
  start,
  end,
  pitches: typeof pitches === "number" ? [pitches] : [...new Set(pitches)],
  pins: [
    { time: 0, interval: 0, volume },
    { time: end - start, interval: 0, volume },
  ],
});
// Fresh channels start with one random factory preset, one attenuation step below maximum.
const factoryInstrument = (): Instrument => {
  const presets = Object.values(PRESET_GROUPS).flat();
  return presetInstrument(presets[Math.floor(Math.random() * presets.length)] ?? "square wave");
};
export const createChannel = (
  kind: "automation" | "track" = "track",
  barCount = 16,
  patternCount = 8,
): Channel => ({
  id: uid(),
  name: kind === "automation" ? "Automation" : "Track",
  kind,
  octave: 3,
  octaves: 3,
  cells: Array.from({ length: barCount }, () => 0),
  patterns: Object.fromEntries(
    Array.from({ length: patternCount }, (_, i) => [i + 1, emptyPattern()]),
  ),
  instruments: kind === "track" ? [factoryInstrument()] : [],
  effects: [],
  target: { kind: "song" },
  enabled: true,
});
export const createSong = (scale = "Free", customScale = [0, 2, 4, 5, 7, 9, 11]): Song => ({
  version: 1,
  id: uid(),
  title: "Song",
  key: 0,
  scale,
  customScale: [...customScale],
  tempo: 150,
  rhythm: 4,
  beatsPerBar: 8,
  barCount: 16,
  patternCount: 8,
  loopStart: 0,
  loopEnd: 4,
  volume: 100,
  detune: 0,
  resources: clone(BUNDLED_RESOURCES),
  channels: Array.from({ length: 3 }, (_, i) => {
    const channel = createChannel();
    channel.name = `Track ${i + 1}`;
    channel.octave = 4 - i;
    return channel;
  }),
});
export const scales: Record<string, number[]> = {
  Free: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  "Pentatonic major": [0, 2, 4, 7, 9],
  "Pentatonic minor": [0, 3, 5, 7, 10],
  Ryukyu: [0, 4, 5, 7, 11],
  "Pelog selisir": [0, 1, 3, 7, 8],
  "Blues major": [0, 2, 3, 4, 7, 9],
  Blues: [0, 3, 5, 6, 7, 10],
  "Double harmonic major": [0, 1, 4, 5, 7, 8, 11],
  "Double harmonic minor": [0, 2, 3, 6, 7, 8, 11],
  "Whole tone": [0, 2, 4, 6, 8, 10],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
  Lydian: [0, 2, 4, 6, 7, 9, 11],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Phrygian: [0, 1, 3, 5, 7, 8, 10],
  Locrian: [0, 1, 3, 5, 6, 8, 10],
  "Lydian dominant": [0, 2, 4, 6, 7, 9, 10],
  "Phrygian dominant": [0, 1, 4, 5, 7, 8, 10],
  "Harmonic major": [0, 2, 4, 5, 7, 8, 11],
  "Harmonic minor": [0, 2, 3, 5, 7, 8, 11],
  "Melodic minor": [0, 2, 3, 5, 7, 9, 11],
  Altered: [0, 1, 3, 4, 6, 8, 10],
  Octatonic: [0, 2, 3, 5, 6, 8, 9, 11],
  Hexatonic: [0, 3, 4, 7, 8, 11],
};
export const scalePitches = (song: Song): number[] =>
  song.scale === "Custom" ? song.customScale : (scales[song.scale] ?? required(scales["Free"]));
export const isInScale = (song: Song, pitch: number): boolean =>
  scalePitches(song).includes(((pitch % 12) + 12) % 12);
export const nearestScalePitch = (song: Song, pitch: number): number => {
  const value = integer(pitch, 0, 108);
  for (let d = 0; d <= 12; d++) {
    if (value - d >= 0 && isInScale(song, value - d)) {
      return value - d;
    }
    if (value + d <= 108 && isInScale(song, value + d)) {
      return value + d;
    }
  }
  return value;
};
export const validateResources = (resources: readonly Resource[]): void => {
  const resourceIds = new Set<string>();
  for (const resource of resources) {
    if (
      !resource.id ||
      resourceIds.has(resource.id) ||
      typeof resource.url !== "string" ||
      !resource.url.trim() ||
      /^\s*(?:data|blob):/iu.test(resource.url.replaceAll(/[\t\n\r]/gu, ""))
    ) {
      throw new Error("Invalid or duplicate resource identity.");
    }
    resourceIds.add(resource.id);
    for (const field of ["rootKey", "start", "loopStart", "loopEnd"] as const) {
      const value = resource[field];
      if (
        value !== undefined &&
        (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))
      ) {
        throw new Error(`Invalid resource ${field}.`);
      }
    }
    if ((resource.rootKey ?? 60) > 127) {
      throw new Error("Invalid resource tuning.");
    }
    if (resource.loopEnd !== undefined && (resource.loopStart ?? 0) >= resource.loopEnd) {
      throw new Error("Invalid sample loop interval.");
    }
  }
};

const resourceShape = {
  id: "",
  url: "",
  rootKey: optional(0),
  start: optional(0),
  loopStart: optional(0),
  loopEnd: optional(0),
  mode: optional(""),
  backwards: optional(false),
  metadata: optional({
    bundled: optional(false),
    license: optional(""),
    revision: optional(""),
  }),
};
const patternShape = {
  notes: [
    {
      id: "",
      start: 0,
      end: 0,
      pitches: [0],
      pins: [{ time: 0, interval: 0, volume: 0 }],
      continues: optional(false),
    },
  ],
  lanes: [
    {
      id: "",
      target: "",
      points: [{ time: 0, value: 0 }],
      interpolation: "",
      enabled: true,
      effectId: optional(""),
    },
  ],
};
const channelShape = {
  id: "",
  name: "",
  kind: "",
  octave: 0,
  octaves: 0,
  cells: [0],
  patterns: dictionary(
    patternShape,
    (key) => /^[1-9]\d*$/u.test(key) && Number.isSafeInteger(Number(key)),
  ),
  instruments: [],
  effects: [validateEffect],
  target: { kind: "", channelId: optional(""), instrumentId: optional("") },
  enabled: true,
};
const songShape = {
  version: 1,
  id: "",
  title: "",
  key: 0,
  scale: "",
  customScale: [0],
  tempo: 0,
  rhythm: 0,
  beatsPerBar: 0,
  barCount: 0,
  patternCount: 0,
  loopStart: 0,
  loopEnd: 0,
  volume: 0,
  detune: 0,
  channels: [channelShape],
  resources: [resourceShape],
};
const hasSongShape = (value: unknown): value is Song => matchesShape(value, songShape);

export const validateSong: (song: unknown) => asserts song is Song = (song) => {
  if (!isRecord(song) || song["version"] !== 1) {
    throw new Error("Unsupported SlopeMP song version.");
  }
  if (!hasSongShape(song) || !song.id) {
    throw new Error("Invalid song data.");
  }
  if (!Array.isArray(song.channels) || !song.channels.some((channel) => channel.kind === "track")) {
    throw new Error("A song must contain a track.");
  }
  for (const [name, value, min, max] of [
    ["tempo", song.tempo, 30, 300],
    ["beats per bar", song.beatsPerBar, 1, 64],
    ["song length", song.barCount, 1, Number.MAX_SAFE_INTEGER],
    ["pattern count", song.patternCount, 1, Number.MAX_SAFE_INTEGER],
    ["key", song.key, 0, 11],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Invalid ${name}.`);
    }
  }
  if (
    ![3, 4, 6, 8, 24].includes(song.rhythm) ||
    !Number.isInteger(song.loopStart) ||
    !Number.isInteger(song.loopEnd) ||
    song.loopStart < 0 ||
    song.loopEnd > song.barCount ||
    song.loopStart >= song.loopEnd
  ) {
    throw new Error("Invalid rhythm or loop interval.");
  }
  if (
    (song.scale !== "Custom" && !Object.hasOwn(scales, song.scale)) ||
    !song.customScale.includes(0) ||
    song.customScale.some((pitch) => !Number.isInteger(pitch) || pitch < 0 || pitch > 11)
  ) {
    throw new Error("Invalid scale.");
  }
  for (const [name, value, min, max] of [
    ["volume", song.volume, 0, 100],
    ["detune", song.detune, -250, 250],
  ] as const) {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Invalid song ${name}.`);
    }
  }
  const identities = new Set<string>();
  const instrumentIdentities = new Set<string>();
  for (const channel of song.channels) {
    if (!channel.id || identities.has(channel.id)) {
      throw new Error("Duplicate channel identity.");
    }
    identities.add(channel.id);
    if (
      !["track", "automation"].includes(channel.kind) ||
      !["song", "channel", "instrument"].includes(channel.target.kind)
    ) {
      throw new Error("Invalid channel kind or target.");
    }
    if (!Number.isInteger(channel.octave) || channel.octave < 0 || channel.octave > 8) {
      throw new Error("Invalid track octave position.");
    }
    if (!Number.isInteger(channel.octaves) || channel.octaves < 1 || channel.octaves > 9) {
      throw new Error("Invalid track octave range.");
    }
    if (
      channel.cells.length !== song.barCount ||
      channel.cells.some(
        (cell) =>
          !Number.isInteger(cell) ||
          cell < 0 ||
          cell > song.patternCount ||
          (cell !== 0 && !channel.patterns[cell]),
      )
    ) {
      throw new Error("Invalid arrangement reference.");
    }
    if (channel.kind === "track" && channel.instruments.length === 0) {
      throw new Error("Tracks require an instrument.");
    }
    for (const instrument of channel.instruments) {
      if (
        !validateInstrument(instrument) ||
        !instrument.id ||
        instrumentIdentities.has(instrument.id)
      ) {
        throw new Error("Invalid instrument or duplicate instrument identity.");
      }
      instrumentIdentities.add(instrument.id);
    }
    for (const chain of [
      channel.effects,
      ...channel.instruments.map((instrument) => instrument.effects),
    ]) {
      const effectIds = new Set<string>();
      for (const effect of chain) {
        if (!effect.id || effectIds.has(effect.id)) {
          throw new Error("Invalid effect identity.");
        }
        effectIds.add(effect.id);
      }
    }
    for (const [number, pattern] of Object.entries(channel.patterns)) {
      if (Number(number) > song.patternCount) {
        throw new Error("Invalid pattern slot.");
      }
      const noteIds = new Set<string>();
      let previousEnd = 0;
      for (const note of [...pattern.notes].sort((a, b) => a.start - b.start)) {
        if (
          !note.id ||
          noteIds.has(note.id) ||
          note.pins.length < 2 ||
          note.pins[0]?.time !== 0 ||
          Math.abs((note.pins.at(-1)?.time ?? 0) - (note.end - note.start)) > 1e-8 ||
          !Number.isFinite(note.start) ||
          !Number.isFinite(note.end) ||
          note.start < previousEnd - 1e-8 ||
          note.start < 0 ||
          note.end > song.beatsPerBar + 1e-8 ||
          note.end <= note.start ||
          note.pitches.length === 0 ||
          note.pitches.some((pitch) => !Number.isFinite(pitch) || pitch < 0 || pitch > 108) ||
          note.pins.some(
            (pin, index) =>
              (index > 0 && pin.time <= (note.pins[index - 1]?.time ?? 0)) ||
              !Number.isFinite(pin.time) ||
              pin.time < 0 ||
              pin.time > note.end - note.start + 1e-8 ||
              !Number.isFinite(pin.interval) ||
              !Number.isFinite(pin.volume) ||
              pin.volume < 0 ||
              pin.volume > 3,
          )
        ) {
          throw new Error("Invalid note timing, pitch, or contour.");
        }
        noteIds.add(note.id);
        previousEnd = note.end;
      }
      const laneIds = new Set<string>();
      for (const lane of pattern.lanes) {
        if (!lane.id || laneIds.has(lane.id)) {
          throw new Error("Invalid or duplicate automation lane identity.");
        }
        laneIds.add(lane.id);
        if (
          !["hold", "linear"].includes(lane.interpolation) ||
          typeof lane.target !== "string" ||
          lane.points.some(
            (point) =>
              !Number.isFinite(point.time) ||
              !Number.isFinite(point.value) ||
              point.time < 0 ||
              point.time > song.beatsPerBar,
          )
        ) {
          throw new Error("Invalid automation point.");
        }
      }
    }
  }
  validateResources(song.resources);
};
