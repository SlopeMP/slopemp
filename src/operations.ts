import { evaluateLane } from "./automation";
import {
  clamp,
  clone,
  createChannel,
  emptyPattern,
  integer,
  isInScale,
  nearestScalePitch,
  required,
  uid,
} from "./model";
import type { AutomationLane, Channel, Note, Pattern, Pin, Selection, Song } from "./model";
export { evaluateLane } from "./automation";
const range = (start: number, end: number): number[] =>
  Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
export const normalizeSelection = (song: Song, selection: Selection): Selection => ({
  ...selection,
  channelStart: integer(
    Math.min(selection.channelStart, selection.channelEnd),
    0,
    song.channels.length - 1,
  ),
  channelEnd: integer(
    Math.max(selection.channelStart, selection.channelEnd),
    0,
    song.channels.length - 1,
  ),
  barStart: integer(Math.min(selection.barStart, selection.barEnd), 0, song.barCount - 1),
  barEnd: integer(Math.max(selection.barStart, selection.barEnd), 0, song.barCount - 1),
});
const cells = (song: Song, selection: Selection): Array<[Channel, number]> => {
  const s = normalizeSelection(song, selection);
  return range(s.channelStart, s.channelEnd).flatMap((t) =>
    range(s.barStart, s.barEnd).map((b): [Channel, number] => [required(song.channels[t]), b]),
  );
};
const hasTime = (selection: Selection): boolean =>
  selection.timeStart !== undefined &&
  selection.timeEnd !== undefined &&
  selection.timeEnd > selection.timeStart;
const timeRange = (song: Song, selection: Selection): [number, number] =>
  hasTime(selection)
    ? [
        clamp(required(selection.timeStart), 0, song.beatsPerBar),
        clamp(required(selection.timeEnd), 0, song.beatsPerBar),
      ]
    : [0, song.beatsPerBar];
const contentJSON = (value: unknown): string =>
  JSON.stringify(value, (_key, child: unknown) =>
    typeof child === "number" && !Number.isFinite(child) ? String(child) : child,
  );
const patternContent = (pattern: Pattern): string =>
  contentJSON({
    notes: pattern.notes.map(({ id: _id, ...note }) => note),
    lanes: pattern.lanes.map(({ id: _id, ...lane }) => lane),
  });
const samePattern = (a: Pattern, b: Pattern): boolean => patternContent(a) === patternContent(b);
export const setPatternCount = (song: Song, count: number): void => {
  song.patternCount = integer(count, 1);
  for (const channel of song.channels) {
    for (let i = 1; i <= song.patternCount; i++) {
      channel.patterns[i] ??= emptyPattern();
    }
    channel.patterns = Object.fromEntries(
      Object.entries(channel.patterns).filter(([key]) => Number(key) <= song.patternCount),
    );
    channel.cells = channel.cells.map((cell) => (cell > song.patternCount ? 0 : cell));
  }
};
export const allocatePattern = (
  song: Song,
  channel: Channel,
  content = emptyPattern(),
  preferred = 0,
): number => {
  const used = new Set(channel.cells);
  const canUsePreferred =
    preferred > 0 &&
    preferred <= song.patternCount &&
    (!used.has(preferred) || samePattern(channel.patterns[preferred] ?? emptyPattern(), content));
  let number = canUsePreferred ? preferred : 0;
  if (number === 0) {
    let firstUnused = 0;
    for (let slot = 1; slot <= song.patternCount; slot++) {
      if (used.has(slot)) {
        continue;
      }
      const pattern = channel.patterns[slot];
      if (!pattern || (pattern.notes.length === 0 && pattern.lanes.length === 0)) {
        number = slot;
        break;
      }
      firstUnused ||= slot;
    }
    number ||= firstUnused;
  }
  if (number === 0) {
    setPatternCount(song, song.patternCount + 1);
    number = song.patternCount;
  }
  channel.patterns[number] = clone(content);
  return number;
};
export const ensurePattern = (song: Song, channelIndex: number, bar: number): Pattern => {
  const channel = song.channels[channelIndex];
  if (!channel || bar < 0 || bar >= song.barCount) {
    throw new Error("Invalid editing cell.");
  }
  let number = required(channel.cells[bar]);
  if (!number) {
    number = allocatePattern(song, channel);
    channel.cells[bar] = number;
  }
  return (channel.patterns[number] ??= emptyPattern());
};
export const assignPattern = (song: Song, selection: Selection, number: number): void => {
  const value = integer(number, 0, song.patternCount);
  for (const [channel, bar] of cells(song, selection)) {
    channel.cells[bar] = value;
  }
};
export const evaluatePin = (note: Note, at: number): Pin => {
  const time = clamp(at, 0, note.end - note.start);
  const { pins } = note;
  const left = pins.findLast((pin) => pin.time <= time) ??
    pins[0] ?? { time: 0, interval: 0, volume: 3 };
  const right = pins.find((pin) => pin.time > time) ?? left;
  const fraction = right.time === left.time ? 0 : (time - left.time) / (right.time - left.time);
  return {
    time,
    interval: left.interval + (right.interval - left.interval) * fraction,
    volume: left.volume + (right.volume - left.volume) * fraction,
  };
};
export const cropNote = (note: Note, start: number, end: number, shift = 0): Note | null => {
  const left = Math.max(note.start, start);
  const right = Math.min(note.end, end);
  if (left >= right) {
    return null;
  }
  const offset = left - note.start;
  const first = evaluatePin(note, offset);
  const last = evaluatePin(note, right - note.start);
  return {
    ...clone(note),
    id: left === note.start && right === note.end ? note.id : uid(),
    continues: left + shift === 0 && (note.start < left || note.continues === true),
    start: left + shift,
    end: right + shift,
    pins: [
      { ...first, time: 0 },
      ...note.pins
        .filter((pin) => pin.time > offset && pin.time < right - note.start)
        .map((pin) => ({ ...pin, time: pin.time - offset })),
      { ...last, time: right - left },
    ],
  };
};
export const removeNoteTime = (notes: Note[], start: number, end: number): Note[] =>
  notes
    .flatMap((note) => {
      if (note.end <= start || note.start >= end) {
        return [note];
      }
      const left = cropNote(note, 0, start);
      const right = cropNote(note, end, Infinity);
      return [left, right].filter((fragment): fragment is Note => fragment !== null);
    })
    .sort((a, b) => a.start - b.start);
const separateReusedPatterns = (song: Song, channel: Channel, start: number, end: number): void => {
  const outside = new Set([...channel.cells.slice(0, start), ...channel.cells.slice(end + 1)]);
  const replacements = new Map<number, number>();
  for (let bar = start; bar <= end; bar++) {
    const number = required(channel.cells[bar]);
    if (number === 0 || !outside.has(number)) {
      continue;
    }
    let replacement = replacements.get(number);
    if (replacement === undefined) {
      replacement = allocatePattern(song, channel, channel.patterns[number]);
      replacements.set(number, replacement);
    }
    channel.cells[bar] = replacement;
  }
};
export const duplicateReusedPatterns = (song: Song, selection: Selection): void => {
  const { channelStart, channelEnd, barStart, barEnd } = normalizeSelection(song, selection);
  for (let row = channelStart; row <= channelEnd; row++) {
    separateReusedPatterns(song, required(song.channels[row]), barStart, barEnd);
  }
};
const selectedPatterns = (song: Song, selection: Selection, tracksOnly = false): Set<Pattern> => {
  const { channelStart, channelEnd, barStart, barEnd } = normalizeSelection(song, selection);
  const patterns = new Set<Pattern>();
  for (let row = channelStart; row <= channelEnd; row++) {
    const channel = required(song.channels[row]);
    if (tracksOnly && channel.kind !== "track") {
      continue;
    }
    if (channelStart !== channelEnd || barStart !== barEnd) {
      separateReusedPatterns(song, channel, barStart, barEnd);
    }
    for (let bar = barStart; bar <= barEnd; bar++) {
      const pattern = channel.patterns[required(channel.cells[bar])];
      if (pattern) {
        patterns.add(pattern);
      }
    }
  }
  return patterns;
};
const cropLane = (
  lane: AutomationLane,
  start: number,
  end: number,
  shift = 0,
): AutomationLane | null => {
  if (start >= end) {
    return null;
  }
  const points = lane.points
    .filter((point) => point.time >= start && point.time <= end)
    .map((point) => ({ ...point, time: point.time + shift }));
  const left = lane.target === "nextBar" ? undefined : evaluateLane(lane, start);
  const right = lane.target === "nextBar" ? undefined : evaluateLane(lane, end);
  if (left !== undefined && !points.some((point) => point.time === start + shift)) {
    points.unshift({ time: start + shift, value: left });
  }
  if (right !== undefined && !points.some((point) => point.time === end + shift)) {
    points.push({ time: end + shift, value: right });
  }
  return points.length > 0
    ? {
        ...clone(lane),
        id: start > 0 || shift !== 0 ? uid() : lane.id,
        points,
      }
    : null;
};
const cropNotes = (notes: Note[], start: number, end: number, shift = 0): Note[] =>
  notes.map((note) => cropNote(note, start, end, shift)).filter((note) => note !== null);
const cropPattern = (pattern: Pattern, start: number, end: number, shift = 0): Pattern => ({
  notes: cropNotes(pattern.notes, start, end, shift),
  lanes: pattern.lanes
    .map((lane) => cropLane(lane, start, end, shift))
    .filter((lane) => lane !== null),
});
const removeLaneTime = (
  lanes: AutomationLane[],
  start: number,
  end: number,
  beatsPerBar: number,
): AutomationLane[] =>
  lanes.flatMap((lane) =>
    [cropLane(lane, 0, start), cropLane(lane, end, beatsPerBar)].filter((part) => part !== null),
  );
const replacePatternTime = (
  pattern: Pattern,
  start: number,
  end: number,
  beatsPerBar: number,
  content: Pattern,
): Pattern => ({
  notes: [...removeNoteTime(pattern.notes, start, end), ...content.notes].sort(
    (a, b) => a.start - b.start,
  ),
  lanes: [...removeLaneTime(pattern.lanes, start, end, beatsPerBar), ...content.lanes],
});
export const eraseTime = (song: Song, selection: Selection): void => {
  const [start, end] = timeRange(song, selection);
  for (const pattern of selectedPatterns(song, selection)) {
    pattern.notes = removeNoteTime(pattern.notes, start, end);
    pattern.lanes = removeLaneTime(pattern.lanes, start, end, song.beatsPerBar);
  }
};
export type ClipboardRow = {
  channelId: string;
  kind: "automation" | "track";
  cells: number[];
  patterns: Record<number, Pattern>;
};
export type PatternClipboard = {
  version: 1;
  songId: string;
  wholeBars: boolean;
  duration: number;
  rows: ClipboardRow[];
};
// Copy keeps pattern references for the source channel and snapshots content for other channels.
// A time selection crops notes and contours and makes their times relative to its start.
export const copyPatterns = (song: Song, selection: Selection): PatternClipboard => {
  const s = normalizeSelection(song, selection);
  const [start, end] = timeRange(song, s);
  return {
    version: 1,
    songId: song.id,
    wholeBars: !hasTime(s),
    duration: end - start,
    rows: range(s.channelStart, s.channelEnd).map((t) => {
      const channel = required(song.channels[t]);
      const copiedCells = channel.cells.slice(s.barStart, s.barEnd + 1);
      return {
        channelId: channel.id,
        kind: channel.kind,
        cells: copiedCells,
        patterns: Object.fromEntries(
          [...new Set(copiedCells)]
            .filter(Boolean)
            .map((number) => [
              number,
              cropPattern(required(channel.patterns[number]), start, end, -start),
            ]),
        ),
      };
    }),
  };
};
export const cutPatterns = (song: Song, selection: Selection): PatternClipboard => {
  const clipboard = copyPatterns(song, selection);
  if (hasTime(selection)) {
    eraseTime(song, selection);
  } else {
    const selected = normalizeSelection(song, selection);
    for (const row of range(selected.channelStart, selected.channelEnd)) {
      const channel = required(song.channels[row]);
      for (const bar of range(selected.barStart, selected.barEnd)) {
        const number = required(channel.cells[bar]);
        if (number) {
          channel.patterns[number] = emptyPattern();
        }
      }
    }
    assignPattern(song, selection, 0);
  }
  return clipboard;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const validateClipboard = (value: unknown): value is PatternClipboard => {
  if (
    !isRecord(value) ||
    value["version"] !== 1 ||
    typeof value["songId"] !== "string" ||
    typeof value["wholeBars"] !== "boolean" ||
    typeof value["duration"] !== "number" ||
    !Number.isFinite(value["duration"]) ||
    value["duration"] < 1 / 24 ||
    value["duration"] > 64 ||
    !Array.isArray(value["rows"]) ||
    value["rows"].length === 0
  ) {
    return false;
  }
  const { duration } = value;
  return value["rows"].every((row: unknown) => {
    if (
      !isRecord(row) ||
      typeof row["channelId"] !== "string" ||
      (row["kind"] !== "track" && row["kind"] !== "automation") ||
      !Array.isArray(row["cells"]) ||
      row["cells"].length === 0 ||
      !isRecord(row["patterns"])
    ) {
      return false;
    }
    const { patterns } = row;
    return row["cells"].every((cell: unknown) => {
      if (typeof cell !== "number" || !Number.isInteger(cell) || cell < 0) {
        return false;
      }
      if (!cell) {
        return true;
      }
      const pattern = patterns[cell];
      if (
        !isRecord(pattern) ||
        !Array.isArray(pattern["notes"]) ||
        !Array.isArray(pattern["lanes"])
      ) {
        return false;
      }
      let previous = 0;
      const notesValid = pattern["notes"].every((note: unknown) => {
        if (
          !isRecord(note) ||
          typeof note["id"] !== "string" ||
          typeof note["start"] !== "number" ||
          typeof note["end"] !== "number" ||
          !Number.isFinite(note["start"]) ||
          !Number.isFinite(note["end"]) ||
          note["start"] < previous ||
          note["end"] <= note["start"] ||
          note["end"] > duration ||
          !Array.isArray(note["pitches"]) ||
          note["pitches"].length === 0 ||
          !note["pitches"].every(
            (pitch: unknown) =>
              typeof pitch === "number" && Number.isFinite(pitch) && pitch >= 0 && pitch <= 108,
          ) ||
          !Array.isArray(note["pins"])
        ) {
          return false;
        }
        previous = note["end"];
        return note["pins"].every(
          (pin: unknown) =>
            isRecord(pin) &&
            typeof pin["time"] === "number" &&
            Number.isFinite(pin["time"]) &&
            typeof pin["interval"] === "number" &&
            Number.isFinite(pin["interval"]) &&
            typeof pin["volume"] === "number" &&
            Number.isFinite(pin["volume"]),
        );
      });
      return (
        notesValid &&
        pattern["lanes"].every(
          (lane: unknown) =>
            isRecord(lane) &&
            typeof lane["id"] === "string" &&
            typeof lane["target"] === "string" &&
            Array.isArray(lane["points"]) &&
            lane["points"].every(
              (point: unknown) =>
                isRecord(point) &&
                typeof point["time"] === "number" &&
                Number.isFinite(point["time"]) &&
                point["time"] >= 0 &&
                point["time"] <= duration &&
                typeof point["value"] === "number" &&
                Number.isFinite(point["value"]),
            ),
        )
      );
    });
  });
};
const tiledPattern = (pattern: Pattern, duration: number, start: number, end: number): Pattern => {
  const result = emptyPattern();
  for (let position = start; position < end - 1e-8; position += duration) {
    const part = cropPattern(pattern, 0, Math.min(duration, end - position), position);
    result.notes.push(...part.notes.map((note) => ({ ...note, id: uid() })));
    result.lanes.push(...part.lanes.map((lane) => ({ ...lane, id: uid() })));
  }
  return result;
};
const reuseOrAllocatePastedPattern = (
  song: Song,
  channel: Channel,
  content: Pattern,
  preferred: number,
): number => {
  const preferredPattern = channel.patterns[preferred];
  if (preferredPattern && samePattern(preferredPattern, content)) {
    return preferred;
  }
  if (content.notes.length > 0 || content.lanes.length > 0) {
    const key = patternContent(content);
    for (const number of new Set(channel.cells)) {
      const pattern = channel.patterns[number];
      if (number > 0 && pattern && patternContent(pattern) === key) {
        return number;
      }
    }
  }
  return allocatePattern(song, channel, content, preferred);
};
export const pastePatterns = (
  song: Song,
  selection: Selection,
  clipboard: PatternClipboard,
): string[] => {
  if (!validateClipboard(clipboard)) {
    return [];
  }
  const warnings = new Set<string>();
  const s = normalizeSelection(song, selection);
  const singleDestination = s.barStart === s.barEnd && s.channelStart === s.channelEnd;
  const height = singleDestination
    ? Math.min(clipboard.rows.length, song.channels.length - s.channelStart)
    : s.channelEnd - s.channelStart + 1;
  const width = singleDestination
    ? Math.min(required(clipboard.rows[0]).cells.length, song.barCount - s.barStart)
    : s.barEnd - s.barStart + 1;
  const single = height === 1 && width === 1;
  const wholeBars = !hasTime(s);
  const { beatsPerBar, patternCount } = song;
  const [start, end] = timeRange(song, s);
  for (let r = 0; r < height; r++) {
    const channel = required(song.channels[s.channelStart + r]);
    const row = required(clipboard.rows[r % clipboard.rows.length]);
    if (channel.kind !== row.kind) {
      warnings.add("Skipped incompatible pitch and automation rows.");
      continue;
    }
    const reusePatternNumbers =
      wholeBars &&
      clipboard.wholeBars &&
      clipboard.songId === song.id &&
      row.channelId === channel.id;
    if (!wholeBars && !single) {
      separateReusedPatterns(song, channel, s.barStart, s.barStart + width - 1);
    }
    const originalNumbers = channel.cells.slice(s.barStart, s.barStart + width);
    const bindings = new Set(channel.effects.map((effect) => effect.id));
    const remap = new Map<number, number>();
    const originals =
      !single && !wholeBars
        ? originalNumbers.map((number) => clone(channel.patterns[number] ?? emptyPattern()))
        : [];
    const fragments = new Map<string, number>();
    const claims = new Map<number, string>();
    for (let c = 0; c < width; c++) {
      const bar = s.barStart + c;
      const sourceNumber = required(row.cells[c % row.cells.length]);
      if (reusePatternNumbers && sourceNumber <= patternCount) {
        channel.cells[bar] = sourceNumber;
        continue;
      }
      const source = sourceNumber ? clone(required(row.patterns[sourceNumber])) : emptyPattern();
      if (channel.kind === "automation") {
        source.lanes = source.lanes.filter((lane) => {
          const valid =
            lane.effectId === undefined ||
            lane.effectId.length === 0 ||
            bindings.has(lane.effectId);
          if (!valid) {
            warnings.add("Skipped automation with unavailable effect bindings.");
          }
          return valid;
        });
      }
      const content = tiledPattern(source, clipboard.duration, start, end);
      if (!single && !wholeBars) {
        const original = required(originals[c]);
        if ((originalNumbers[c] ?? 0) === 0 && !sourceNumber) {
          continue;
        }
        const replacement = replacePatternTime(original, start, end, beatsPerBar, content);
        const key = `${sourceNumber}:${patternContent(replacement)}`;
        let number = fragments.get(key);
        if (number === undefined) {
          number = originalNumbers[c] ?? 0;
          if (!number || (claims.has(number) && claims.get(number) !== key)) {
            number = allocatePattern(
              song,
              channel,
              replacement,
              claims.has(sourceNumber) ? 0 : sourceNumber,
            );
          }
          channel.patterns[number] = replacement;
          fragments.set(key, number);
          claims.set(number, key);
        }
        channel.cells[bar] = number;
        continue;
      }
      if (single) {
        if ((channel.cells[bar] ?? 0) === 0 && !sourceNumber) {
          continue;
        }
        const assigned = channel.cells[bar] ?? 0;
        const destination =
          assigned ||
          (wholeBars
            ? reuseOrAllocatePastedPattern(song, channel, content, sourceNumber)
            : allocatePattern(song, channel, content, sourceNumber));
        channel.cells[bar] = destination;
        const pattern = required(channel.patterns[destination]);
        const replacement = replacePatternTime(pattern, start, end, beatsPerBar, content);
        if (!samePattern(pattern, replacement)) {
          Object.assign(pattern, replacement);
        }
      } else if (!sourceNumber) {
        channel.cells[bar] = 0;
      } else {
        let destinationNumber = remap.get(sourceNumber);
        if (destinationNumber === undefined) {
          destinationNumber = reuseOrAllocatePastedPattern(song, channel, content, sourceNumber);
          remap.set(sourceNumber, destinationNumber);
        }
        channel.cells[bar] = destinationNumber;
      }
    }
    if (!single && wholeBars && !reusePatternNumbers) {
      for (const number of new Set(originalNumbers)) {
        if (number && !channel.cells.includes(number)) {
          channel.patterns[number] = emptyPattern();
        }
      }
    }
  }
  return [...warnings];
};
export const transpose = (
  song: Song,
  selection: Selection,
  direction: number,
  chromatic = false,
  octave = false,
): void => {
  if (direction === 0) {
    return;
  }
  const [start, end] = timeRange(song, selection);
  const shift = (pitch: number): number => {
    if (octave || chromatic) {
      return clamp(pitch + direction * (octave ? 12 : 1), 0, 108);
    }
    let value = Math.round(pitch);
    do {
      value += Math.sign(direction);
    } while (value > 0 && value < 108 && !isInScale(song, value));
    return clamp(value, 0, 108);
  };
  for (const pattern of selectedPatterns(song, selection, true)) {
    const kept = removeNoteTime(pattern.notes, start, end);
    const transformed = cropNotes(pattern.notes, start, end).map((note) => {
      const old = required(note.pitches[0]);
      note.pitches = [...new Set(note.pitches.map(shift))];
      for (const pin of note.pins) {
        pin.interval = shift(old + pin.interval) - required(note.pitches[0]);
      }
      return note;
    });
    pattern.notes = [...kept, ...transformed].sort((a, b) => a.start - b.start);
  }
};
export const snapToScale = (song: Song, selection: Selection): void => {
  const [start, end] = timeRange(song, selection);
  for (const pattern of selectedPatterns(song, selection, true)) {
    const transformed = cropNotes(pattern.notes, start, end).map((note) => {
      const root = required(note.pitches[0]);
      note.pitches = [...new Set(note.pitches.map((pitch) => nearestScalePitch(song, pitch)))];
      for (const pin of note.pins) {
        pin.interval = nearestScalePitch(song, root + pin.interval) - required(note.pitches[0]);
      }
      return note;
    });
    pattern.notes = [...removeNoteTime(pattern.notes, start, end), ...transformed].sort(
      (a, b) => a.start - b.start,
    );
  }
};
export const snapToRhythm = (song: Song, selection: Selection): void => {
  const [begin, finish] = timeRange(song, selection);
  for (const pattern of selectedPatterns(song, selection, true)) {
    let previous = begin;
    const snapped = cropNotes(pattern.notes, begin, finish).flatMap((note) => {
      const start = Math.max(previous, begin, Math.round(note.start * song.rhythm) / song.rhythm);
      const end = Math.min(
        finish,
        Math.max(start + 1 / song.rhythm, Math.round(note.end * song.rhythm) / song.rhythm),
      );
      if (start >= end) {
        return [];
      }
      const ratio = (end - start) / (note.end - note.start);
      note.start = start;
      note.end = end;
      note.pins = note.pins.map((pin) => ({ ...pin, time: pin.time * ratio }));
      previous = end;
      return [note];
    });
    pattern.notes = [...removeNoteTime(pattern.notes, begin, finish), ...snapped].sort(
      (a, b) => a.start - b.start,
    );
  }
};
export const setBeatsPerBar = (song: Song, beats: number): void => {
  const next = integer(beats, 1, 64);
  if (next === song.beatsPerBar) {
    return;
  }
  song.beatsPerBar = next;
  for (const channel of song.channels) {
    for (const [number, pattern] of Object.entries(channel.patterns)) {
      channel.patterns[Number(number)] = cropPattern(pattern, 0, song.beatsPerBar);
    }
  }
};
export const setSongLength = (song: Song, length: number): void => {
  song.barCount = integer(length, 1);
  for (const channel of song.channels) {
    channel.cells = Array.from({ length: song.barCount }, (_, i) => channel.cells[i] ?? 0);
  }
  song.loopStart = integer(song.loopStart, 0, song.barCount - 1);
  song.loopEnd = integer(song.loopEnd, song.loopStart + 1, song.barCount);
};
const insertChannel = (song: Song, kind: Channel["kind"], index: number, number: number): void => {
  const channel = createChannel(kind, song.barCount, song.patternCount);
  channel.name = `${channel.name} ${number}`;
  song.channels.splice(index, 0, channel);
};
export const insertChannelBelow = (song: Song, index: number): void => {
  const { kind } = required(song.channels[index]);
  const count = song.channels.filter((channel) => channel.kind === kind).length;
  insertChannel(song, kind, index + 1, count + 1);
};
export const setChannelCount = (song: Song, kind: "automation" | "track", count: number): void => {
  const target = integer(count, kind === "track" ? 1 : 0);
  let current = song.channels.filter((channel) => channel.kind === kind).length;
  while (current > target) {
    const index = song.channels.findLastIndex((channel) => channel.kind === kind);
    song.channels.splice(index, 1);
    current--;
  }
  while (current < target) {
    const firstAutomation = song.channels.findIndex((item) => item.kind === "automation");
    const index =
      kind === "track" && firstAutomation !== -1 ? firstAutomation : song.channels.length;
    insertChannel(song, kind, index, current + 1);
    current++;
  }
};
export const insertBars = (song: Song, selection: Selection): void => {
  const s = normalizeSelection(song, selection);
  const count = s.barEnd - s.barStart + 1;
  const at = s.barEnd + 1;
  for (const channel of song.channels) {
    channel.cells.splice(at, 0, ...Array<number>(count).fill(0));
  }
  song.barCount += count;
  if (at <= song.loopStart) {
    song.loopStart += count;
  }
  if (at < song.loopEnd) {
    song.loopEnd += count;
  }
};
export const deleteBars = (song: Song, selection: Selection): void => {
  if (hasTime(selection)) {
    eraseTime(song, selection);
    return;
  }
  const s = normalizeSelection(song, selection);
  const count = Math.min(s.barEnd - s.barStart + 1, song.barCount - 1);
  if (!count) {
    return;
  }
  for (const channel of song.channels) {
    channel.cells.splice(s.barStart, count);
  }
  const map = (position: number): number =>
    position <= s.barStart ? position : Math.max(s.barStart, position - count);
  song.loopStart = map(song.loopStart);
  song.loopEnd = map(song.loopEnd);
  song.barCount -= count;
  song.loopStart = clamp(song.loopStart, 0, song.barCount - 1);
  song.loopEnd = clamp(song.loopEnd, song.loopStart + 1, song.barCount);
};
export const deleteChannels = (song: Song, selection: Selection): void => {
  const s = normalizeSelection(song, selection);
  let trackCount = song.channels.filter((channel) => channel.kind === "track").length;
  song.channels = song.channels.filter((channel, i) => {
    if (i < s.channelStart || i > s.channelEnd) {
      return true;
    }
    if (channel.kind === "track") {
      if (trackCount <= 1) {
        return true;
      }
      trackCount--;
    }
    return false;
  });
};
export const moveChannels = (song: Song, selection: Selection, direction: number): void => {
  const s = normalizeSelection(song, selection);
  if (
    (direction < 0 && s.channelStart === 0) ||
    (direction > 0 && s.channelEnd === song.channels.length - 1)
  ) {
    return;
  }
  const group = song.channels.splice(s.channelStart, s.channelEnd - s.channelStart + 1);
  song.channels.splice(s.channelStart + Math.sign(direction), 0, ...group);
};
// Shift the whole song by up to one bar in either direction, including Auto lanes.
// Overflow carries/splits notes across bars; wrap rotates each pattern within its bar.
export const moveAllNotes = (song: Song, offset: number, wrap: boolean): void => {
  const beats = song.beatsPerBar;
  const shift = Math.round(clamp(offset, -beats, beats) * 24) / 24;
  if (!shift) {
    return;
  }
  if (wrap) {
    for (const channel of song.channels) {
      for (const [number, pattern] of Object.entries(channel.patterns)) {
        const result = emptyPattern();
        for (const delta of [shift - beats, shift, shift + beats]) {
          const moved = cropPattern(pattern, -delta, beats - delta, delta);
          result.notes.push(...moved.notes);
          result.lanes.push(...moved.lanes);
        }
        result.notes.sort((a, b) => a.start - b.start);
        channel.patterns[Number(number)] = result;
      }
    }
    return;
  }
  for (const channel of song.channels) {
    const oldPatterns = clone(channel.patterns);
    const oldCells = [...channel.cells];
    const results = Array.from({ length: song.barCount }, emptyPattern);
    for (let bar = 0; bar < song.barCount; bar++) {
      const pattern = oldPatterns[required(oldCells[bar])];
      if (!pattern) {
        continue;
      }
      for (const destination of [bar - 1, bar, bar + 1]) {
        if (destination < 0 || destination >= song.barCount) {
          continue;
        }
        const delta = (bar - destination) * beats + shift;
        const fragment = cropPattern(pattern, -delta, beats - delta, delta);
        required(results[destination]).notes.push(...fragment.notes);
        required(results[destination]).lanes.push(...fragment.lanes);
      }
    }
    channel.cells.fill(0);
    const assigned = new Map<string, number>();
    for (let bar = 0; bar < song.barCount; bar++) {
      const result = required(results[bar]);
      result.notes.sort((a, b) => a.start - b.start);
      if (result.notes.length === 0 && result.lanes.length === 0) {
        continue;
      }
      const key = patternContent(result);
      let number = assigned.get(key);
      if (number === undefined) {
        number = allocatePattern(song, channel, result);
        assigned.set(key, number);
      }
      channel.cells[bar] = number;
    }
  }
};
export const setKey = (song: Song, key: number): void => {
  const next = integer(key, 0, 11);
  const delta = song.key - next;
  if (!delta) {
    return;
  }
  for (const channel of song.channels) {
    for (const pattern of Object.values(channel.patterns)) {
      for (const note of pattern.notes) {
        note.pitches = [...new Set(note.pitches.map((pitch) => clamp(pitch + delta, 0, 108)))];
      }
    }
  }
  song.key = next;
};
export const detectKey = (song: Song): number => {
  const weights = Array<number>(12).fill(0);
  for (const channel of song.channels) {
    for (const cell of channel.cells) {
      for (const note of channel.patterns[cell]?.notes ?? []) {
        for (const pitch of note.pitches) {
          const index = (Math.round(pitch) + song.key) % 12;
          weights[index] =
            required(weights[index]) + (note.end - note.start) * (note.pins[0]?.volume ?? 3);
        }
      }
    }
  }
  const next = weights.indexOf(Math.max(...weights));
  const delta = song.key - next;
  if (!delta) {
    return next;
  }
  for (const channel of song.channels) {
    for (const pattern of Object.values(channel.patterns)) {
      for (const note of pattern.notes) {
        note.pitches = note.pitches.map((pitch) => clamp(pitch + delta, 0, 108));
      }
    }
  }
  song.key = next;
  return next;
};
