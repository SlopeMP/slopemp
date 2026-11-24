import { describe, expect, test } from "bun:test";

import { expandSequence, exportSequence, sanitizeFilename } from "../../src/formats";
import { createEnvelope } from "../../src/instruments";
import {
  clone,
  createChannel,
  createNote,
  createSong,
  History,
  isInScale,
  nearestScalePitch,
  required,
  scalePitches,
  scales,
  validateSong,
} from "../../src/model";
import type { AutomationLane, Note, Selection, Song } from "../../src/model";
import {
  assignPattern,
  copyPatterns,
  cropNote,
  cutPatterns,
  deleteBars,
  deleteChannels,
  detectKey,
  duplicateReusedPatterns,
  ensurePattern,
  eraseTime,
  evaluateLane,
  evaluatePin,
  insertBars,
  insertChannelBelow,
  moveAllNotes,
  moveChannels,
  pastePatterns,
  removeNoteTime,
  setBeatsPerBar,
  setChannelCount,
  setKey,
  setPatternCount,
  setSongLength,
  snapToRhythm,
  snapToScale,
  transpose,
  validateClipboard,
} from "../../src/operations";
import {
  decodeSong,
  encodeSong,
  loadClipboard,
  readSongData,
  readStoredSession,
  saveClipboard,
  saveStoredSession,
  songURL,
} from "../../src/storage";
const cell = (bar = 0, channel = 0): Selection => ({
  channelStart: channel,
  channelEnd: channel,
  barStart: bar,
  barEnd: bar,
});
const addNote = (song: Song, channel: number, bar: number, note: Note): void => {
  const pattern = ensurePattern(song, channel, bar);
  const safe = required(cropNote(note, 0, song.beatsPerBar));
  pattern.notes = [...removeNoteTime(pattern.notes, safe.start, safe.end), safe].sort(
    (a, b) => a.start - b.start,
  );
};
const phrase = (): Song => {
  const song = createSong();
  required(song.channels[0]).cells.fill(1, 0, 4);
  addNote(song, 0, 0, createNote(0, 2, [48, 52, 55]));
  return song;
};
const lane = (target = "tempo"): AutomationLane => ({
  id: "lane",
  target,
  points: [
    { time: 0, value: 100 },
    { time: 4, value: 200 },
  ],
  interpolation: "linear",
  enabled: true,
});
describe("scope and validation regressions", () => {
  test("song key changes retain sounding pitches and can be undone", () => {
    const history = new History(phrase());
    history.execute((song) => {
      setKey(song, 7);
    });
    expect(history.song.key).toBe(7);
    expect(
      required(required(required(history.song.channels[0]).patterns[1]).notes[0]).pitches,
    ).toEqual([41, 45, 48]);
    history.undo();
    expect(
      required(required(required(history.song.channels[0]).patterns[1]).notes[0]).pitches,
    ).toEqual([48, 52, 55]);
  });
  test("undo and redo restore captured editing context while navigation keeps redo", () => {
    const history = new History();
    let context = { bar: 3, channel: 1, selection: [1, 3] };
    history.setContextHandlers(
      () => context,
      (value) => {
        context = value;
      },
    );
    history.execute((song) => {
      song.tempo = 200;
    });
    context = { bar: 7, channel: 2, selection: [2, 7] };
    history.updateContext();
    context.bar = 12;
    history.undo();
    expect(context).toEqual({ bar: 3, channel: 1, selection: [1, 3] });
    context.bar = 8;
    expect(history.canRedo).toBe(true);
    history.redo();
    expect(context).toEqual({ bar: 7, channel: 2, selection: [2, 7] });
  });
  test("provisional edits expose preview state without entering history", () => {
    const history = new History();
    expect(history.isPreview).toBe(false);
    history.preview((song) => {
      song.volume = 50;
    });
    expect(history.isPreview).toBe(true);
    history.commitPreview();
    expect(history.isPreview).toBe(false);
    history.undo();
    expect(history.song.volume).toBe(100);
  });
  test("time-selected rhythm snap preserves material outside its interval", () => {
    const song = createSong();
    addNote(song, 0, 0, createNote(0.12, 0.64, 48));
    addNote(song, 0, 0, createNote(2.12, 2.64, 60));
    snapToRhythm(song, { ...cell(), timeStart: 2, timeEnd: 3 });
    expect(
      required(required(song.channels[0]).patterns[1]).notes.map((note) => [note.start, note.end]),
    ).toEqual([
      [0.12, 0.64],
      [2, 2.75],
    ]);
  });
  test("note-only transformations leave Auto pattern references untouched", () => {
    const song = phrase();
    const auto = createChannel("automation");
    auto.cells[0] = 1;
    required(auto.patterns[1]).lanes = [lane()];
    song.channels.push(auto);
    const before = clone(auto);
    transpose(song, { ...cell(), channelEnd: 3, barEnd: 1 }, 1);
    expect(song.channels[3]).toEqual(before);
  });
  test("multi-cell time paste separates different source fragments sharing destination pattern", () => {
    const source = createSong();
    required(source.channels[0]).cells[1] = 2;
    addNote(source, 0, 0, createNote(0, 1, 48));
    addNote(source, 0, 1, createNote(0, 1, 60));
    const clip = copyPatterns(source, { ...cell(), barEnd: 1, timeStart: 0, timeEnd: 1 });
    const destination = createSong();
    required(destination.channels[0]).cells.fill(1, 0, 3);
    addNote(destination, 0, 0, createNote(6, 7, 72));
    pastePatterns(destination, { ...cell(), barEnd: 1, timeStart: 0, timeEnd: 1 }, clip);
    const channel = required(destination.channels[0]);
    expect(channel.cells[0]).not.toBe(channel.cells[1]);
    expect(
      required(channel.patterns[required(channel.cells[0])]).notes.map((note) => note.pitches),
    ).toEqual([[48], [72]]);
    expect(
      required(channel.patterns[required(channel.cells[1])]).notes.map((note) => note.pitches),
    ).toEqual([[60], [72]]);
    expect(required(channel.patterns[1]).notes.map((note) => note.pitches)).toEqual([[72]]);
    validateSong(destination);
  });
  test("multi-cell time paste preserves independent outside destination material", () => {
    const source = phrase();
    const destination = createSong();
    required(destination.channels[0]).cells[1] = 2;
    addNote(destination, 0, 0, createNote(6, 7, 72));
    addNote(destination, 0, 1, createNote(6, 7, 84));
    pastePatterns(
      destination,
      { ...cell(), barEnd: 1, timeStart: 0, timeEnd: 1 },
      copyPatterns(source, { ...cell(), timeStart: 0, timeEnd: 1 }),
    );
    const channel = required(destination.channels[0]);
    expect(
      required(required(channel.patterns[required(channel.cells[0])]).notes[1]).pitches,
    ).toEqual([72]);
    expect(
      required(required(channel.patterns[required(channel.cells[1])]).notes[1]).pitches,
    ).toEqual([84]);
  });
  test("incompatible time-paste rows are left completely unchanged", () => {
    const source = phrase();
    const destination = createSong();
    const auto = createChannel("automation");
    auto.cells[0] = 1;
    required(auto.patterns[1]).lanes = [lane()];
    destination.channels.push(auto);
    const before = clone(auto);
    pastePatterns(
      destination,
      { ...cell(0, 3), barEnd: 1, timeStart: 0, timeEnd: 1 },
      copyPatterns(source, cell()),
    );
    expect(destination.channels[3]).toEqual(before);
  });
  test("pasted phrase repeats have independent note identities", () => {
    const source = phrase();
    const destination = createSong();
    pastePatterns(
      destination,
      cell(),
      copyPatterns(source, { ...cell(), timeStart: 0, timeEnd: 1 }),
    );
    const { notes } = required(required(destination.channels[0]).patterns[1]);
    expect(notes).toHaveLength(8);
    expect(new Set(notes.map((note) => note.id)).size).toBe(8);
  });
  test("pasting identical single-cell content is a true history no-op", () => {
    const history = new History(phrase());
    const clip = copyPatterns(history.song, cell());
    expect(
      history.execute((song) => {
        pastePatterns(song, cell(), clip);
      }),
    ).toBe(false);
  });
  test("malformed clipboard contours cannot create an invalid project", () => {
    const clip = copyPatterns(phrase(), cell());
    required(required(required(required(clip.rows[0]).patterns[1]).notes[0]).pins[0]).interval =
      Number.NaN;
    expect(validateClipboard(clip)).toBe(false);
    expect(validateClipboard({ version: 1, duration: 1e-30, rows: [] })).toBe(false);
  });
  test("explicit corrupt song values are reported instead of replaced with defaults", () => {
    const song = phrase();
    for (const field of ["tempo", "key", "beatsPerBar", "volume"] as const) {
      expect(() => readSongData({ ...song, [field]: "invalid" })).toThrow();
    }
    expect(() => readSongData({ ...song, rhythm: 5 })).toThrow();
    expect(() => readSongData({ ...song, scale: "constructor" })).toThrow();
    expect(() => readSongData({ ...song, detune: -251 })).toThrow();
    expect(() => readSongData({ ...song, resources: [{}] })).toThrow();
  });
  test("current format out-of-bounds arrangement and malformed instruments are rejected", () => {
    const song = phrase();
    required(song.channels[0]).cells[0] = 999;
    expect(() => readSongData(song)).toThrow("arrangement reference");
    required(song.channels[0]).cells[0] = 1;
    required(required(song.channels[0]).instruments[0]).volume = 2.51;
    expect(() => readSongData(song)).toThrow();
  });
  test("all structural edits and their undo preserve model invariants", () => {
    const history = new History(phrase());
    let seed = 42;
    const random = (max: number): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed % max;
    };
    for (let step = 0; step < 80; step++) {
      const before = encodeSong(history.song);
      const operation = random(7);
      const changed = history.execute((song) => {
        if (operation === 0) {
          setSongLength(song, 1 + random(24));
        }
        if (operation === 1) {
          setBeatsPerBar(song, 1 + random(16));
        }
        if (operation === 2) {
          setChannelCount(song, "track", 1 + random(5));
        }
        if (operation === 3) {
          setChannelCount(song, "automation", random(4));
        }
        if (operation === 4) {
          insertBars(song, cell(random(song.barCount)));
        }
        if (operation === 5) {
          deleteBars(song, cell(random(song.barCount)));
        }
        if (operation === 6) {
          setPatternCount(song, 1 + random(12));
        }
      });
      validateSong(history.song);
      if (changed) {
        history.undo();
        expect(encodeSong(history.song)).toBe(before);
        history.redo();
        validateSong(history.song);
      }
    }
  });
});
describe("song model", () => {
  test("fresh song follows documented structure and distinct stable identities", () => {
    const song = createSong();
    expect(song.channels).toHaveLength(3);
    expect(song.barCount).toBe(16);
    expect(song.patternCount).toBe(8);
    expect(song.beatsPerBar).toBe(8);
    expect(song.tempo).toBe(150);
    expect(song.key).toBe(0);
    expect(song.scale).toBe("Free");
    expect([song.loopStart, song.loopEnd]).toEqual([0, 4]);
    for (const channel of song.channels) {
      expect(channel.cells).toEqual(Array<number>(song.barCount).fill(0));
    }
    expect(song.channels.map((channel) => channel.octave)).toEqual([4, 3, 2]);
    expect(new Set(song.channels.map((channel) => channel.id)).size).toBe(3);
    expect(song.volume).toBe(100);
    expect(song.detune).toBe(0);
    expect(() => {
      validateSong(song);
    }).not.toThrow();
  });
  test("zero assignment preserves reusable notes", () => {
    const song = phrase();
    assignPattern(song, cell(), 0);
    expect(required(required(song.channels[0]).patterns[1]).notes).toHaveLength(1);
    expect(required(song.channels[0]).cells[1]).toBe(1);
  });
  test("first note on zero allocates a distinct available slot", () => {
    const song = phrase();
    addNote(song, 0, 4, createNote(2, 3, 60));
    expect(required(song.channels[0]).cells[4]).not.toBe(0);
    expect(required(song.channels[0]).cells[4]).not.toBe(1);
    expect(required(required(required(song.channels[0]).patterns[1]).notes[0]).pitches).toEqual([
      48, 52, 55,
    ]);
  });
  test("all scale identities are distinct and custom always has tonic", () => {
    expect(new Set(Object.values(scales).map((value) => value.join(","))).size).toBe(
      Object.keys(scales).length,
    );
    const song = createSong("Custom", [0, 1, 7]);
    expect(scalePitches(song)).toEqual([0, 1, 7]);
    expect(isInScale(song, 13)).toBe(true);
    expect(isInScale(song, 14)).toBe(false);
    expect(nearestScalePitch(song, 14)).toBe(13);
  });
  test("rejects invalid overlap, missing tracks and arrangement references", () => {
    const song = phrase();
    required(required(song.channels[0]).patterns[1]).notes.push(createNote(1, 3, 60));
    expect(() => {
      validateSong(song);
    }).toThrow("Invalid note");
    song.channels = [createChannel("automation")];
    expect(() => {
      validateSong(song);
    }).toThrow("track");
    song.channels = [createChannel()];
    required(song.channels[0]).cells[0] = 99;
    expect(() => {
      validateSong(song);
    }).toThrow("arrangement");
  });
});
describe("reversible Changes", () => {
  test("all installed state is immutable, with exact undo and redo", () => {
    const history = new History(phrase());
    const before = encodeSong(history.song);
    expect(() => {
      history.song.tempo = 190;
    }).toThrow();
    expect(
      history.execute((song) => {
        song.tempo = 190;
      }),
    ).toBe(true);
    expect(history.song.tempo).toBe(190);
    history.undo();
    expect(encodeSong(history.song)).toBe(before);
    history.redo();
    expect(history.song.tempo).toBe(190);
  });
  test("validation failure and throwing recipes leave state/history intact", () => {
    const history = new History();
    expect(() =>
      history.execute((song) => {
        song.channels = [];
      }),
    ).toThrow();
    expect(() =>
      history.execute((song) => {
        song.tempo = 230;
        throw new Error("fail");
      }),
    ).toThrow();
    expect(history.song.tempo).toBe(150);
    expect(history.canUndo).toBe(false);
  });
  test("no-ops preserve redo and have no history entry", () => {
    const history = new History();
    history.execute((song) => {
      song.tempo = 160;
    });
    history.undo();
    expect(
      history.execute((value) => {
        value.tempo = 150;
      }),
    ).toBe(false);
    expect(history.canRedo).toBe(true);
  });
  test("new committed changes discard redo", () => {
    const history = new History();
    history.execute((song) => {
      song.tempo = 160;
    });
    history.undo();
    history.execute((song) => {
      song.key = 4;
    });
    expect(history.canRedo).toBe(false);
  });
  test("preview gestures commit once and cancel restores prior state", () => {
    const history = new History();
    history.preview((song) => {
      song.tempo = 180;
    });
    history.preview((song) => {
      song.tempo = 190;
    });
    expect(history.song.tempo).toBe(190);
    expect(history.canUndo).toBe(false);
    history.cancelPreview();
    expect(history.song.tempo).toBe(150);
    history.preview((song) => {
      song.tempo = 210;
    });
    history.commitPreview();
    expect(history.canUndo).toBe(true);
    history.undo();
    expect(history.song.tempo).toBe(150);
    expect(history.canUndo).toBe(false);
  });
  test("bounded history keeps complete edits and notifies subscribers", () => {
    const history = new History();
    let notifications = 0;
    const unsubscribe = history.subscribe(() => {
      notifications++;
    });
    for (let i = 0; i < 110; i++) {
      history.execute((song) => {
        song.tempo = 151 + i;
      });
    }
    expect(notifications).toBe(110);
    unsubscribe();
    let undone = 0;
    while (history.undo()) {
      undone++;
    }
    expect(undone).toBe(100);
    expect(history.song.tempo).toBe(160);
    expect(notifications).toBe(110);
  });
});
describe("note contour and edit scopes", () => {
  test("removing occupied time trims both neighbors without overlap", () => {
    const notes = removeNoteTime([createNote(0, 2, [48, 52, 55])], 0.5, 1.5);
    expect(notes.map((note) => [note.start, note.end])).toEqual([
      [0, 0.5],
      [1.5, 2],
    ]);
  });
  test("cropping interpolates bends and expression at boundaries", () => {
    const note = createNote(1, 5, 48);
    note.pins = [
      { time: 0, interval: 0, volume: 0 },
      { time: 4, interval: 12, volume: 3 },
    ];
    expect(evaluatePin(note, 2)).toEqual({ time: 2, interval: 6, volume: 1.5 });
    const fragment = required(cropNote(note, 2, 4, -2));
    expect([fragment.start, fragment.end]).toEqual([0, 2]);
    expect(fragment.pins).toEqual([
      { time: 0, interval: 3, volume: 0.75 },
      { time: 2, interval: 9, volume: 2.25 },
    ]);
  });
  test("single-cell transformation preserves reuse", () => {
    const song = phrase();
    transpose(song, cell(), 1, true);
    expect(required(song.channels[0]).cells.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(required(required(required(song.channels[0]).patterns[1]).notes[0]).pitches).toEqual([
      49, 53, 56,
    ]);
  });
  test("multi-cell edits separate patterns reused outside selection", () => {
    const song = phrase();
    transpose(song, { ...cell(), barEnd: 1 }, 1, true);
    const channel = required(song.channels[0]);
    expect(channel.cells[0]).toBe(channel.cells[1]);
    expect(channel.cells[0]).not.toBe(channel.cells[2]);
    expect(
      required(required(channel.patterns[required(channel.cells[0])]).notes[0]).pitches,
    ).toEqual([49, 53, 56]);
    expect(required(required(channel.patterns[1]).notes[0]).pitches).toEqual([48, 52, 55]);
  });
  test("duplicate reused patterns preserves sharing within selection", () => {
    const song = phrase();
    duplicateReusedPatterns(song, { ...cell(), barEnd: 1 });
    const channel = required(song.channels[0]);
    expect(channel.cells[0]).toBe(channel.cells[1]);
    expect(channel.cells[0]).not.toBe(1);
    expect(channel.cells[2]).toBe(1);
  });
  test("selected interval erase splits notes and preserves outside contour", () => {
    const song = phrase();
    eraseTime(song, { ...cell(), timeStart: 0.5, timeEnd: 1.5 });
    expect(
      required(required(song.channels[0]).patterns[1]).notes.map((note) => [note.start, note.end]),
    ).toEqual([
      [0, 0.5],
      [1.5, 2],
    ]);
  });
  test("scale transposition follows permitted scale classes", () => {
    const song = phrase();
    song.scale = "Major";
    transpose(song, cell(), 1);
    expect(required(required(required(song.channels[0]).patterns[1]).notes[0]).pitches).toEqual([
      50, 53, 57,
    ]);
    transpose(song, cell(), -1, false, true);
    expect(required(required(required(song.channels[0]).patterns[1]).notes[0]).pitches).toEqual([
      38, 41, 45,
    ]);
  });
  test("changing a scale does not rewrite notes; explicit snap does", () => {
    const song = phrase();
    song.scale = "Major";
    required(required(required(song.channels[0]).patterns[1]).notes[0]).pitches = [49];
    expect(required(required(required(song.channels[0]).patterns[1]).notes[0]).pitches).toEqual([
      49,
    ]);
    snapToScale(song, cell());
    expect(required(required(required(song.channels[0]).patterns[1]).notes[0]).pitches).toEqual([
      48,
    ]);
  });
  test("rhythm snapping has finite nonoverlapping results", () => {
    const song = createSong();
    addNote(song, 0, 0, createNote(0.11, 0.49, 48));
    addNote(song, 0, 0, createNote(0.5, 0.73, 50));
    song.rhythm = 4;
    snapToRhythm(song, cell());
    expect(
      required(required(song.channels[0]).patterns[1]).notes.map((note) => [note.start, note.end]),
    ).toEqual([
      [0, 0.5],
      [0.5, 0.75],
    ]);
    validateSong(song);
  });
});
describe("clipboard snapshots, tiling and slot identity", () => {
  test("copy is detached, includes zero and empty nonzero patterns", () => {
    const song = phrase();
    required(song.channels[0]).cells[1] = 0;
    required(song.channels[0]).cells[2] = 2;
    const clip = copyPatterns(song, { ...cell(), barEnd: 2 });
    required(required(song.channels[0]).patterns[1]).notes = [];
    expect(required(clip.rows[0]).cells).toEqual([1, 0, 2]);
    expect(required(required(clip.rows[0]).patterns[1]).notes).toHaveLength(1);
    expect(required(required(clip.rows[0]).patterns[2]).notes).toHaveLength(0);
  });
  test("copy selection does not discard redo", () => {
    const history = new History(phrase());
    history.execute((song) => {
      song.tempo = 200;
    });
    history.undo();
    copyPatterns(history.song, cell());
    expect(history.canRedo).toBe(true);
  });
  test("cut cells clears assignments and stored content while preserving the clipboard", () => {
    const song = phrase();
    const clip = cutPatterns(song, { ...cell(), barEnd: 1 });
    expect(song.barCount).toBe(16);
    expect(required(song.channels[0]).cells.slice(0, 4)).toEqual([0, 0, 1, 1]);
    expect(required(required(song.channels[0]).patterns[1]).notes).toHaveLength(0);
    expect(required(required(song.channels[0]).patterns[1]).lanes).toEqual([]);
    expect(required(required(clip.rows[0]).patterns[1]).notes).toHaveLength(1);
    expect(required(clip.rows[0]).cells).toEqual([1, 1]);
  });
  test("time cut remembers copied duration and erases original interval", () => {
    const song = phrase();
    const clip = cutPatterns(song, { ...cell(), timeStart: 0.5, timeEnd: 1.5 });
    expect(clip.duration).toBe(1);
    expect(
      required(required(clip.rows[0]).patterns[1]).notes.map((note) => [note.start, note.end]),
    ).toEqual([[0, 1]]);
    expect(
      required(required(song.channels[0]).patterns[1]).notes.map((note) => [note.start, note.end]),
    ).toEqual([
      [0, 0.5],
      [1.5, 2],
    ]);
  });
  test("single paste edits destination assigned pattern preserving its number", () => {
    const source = phrase();
    const destination = createSong();
    const instrument = clone(required(destination.channels[0]).instruments);
    required(destination.channels[0]).cells[0] = 3;
    pastePatterns(destination, cell(), copyPatterns(source, cell()));
    expect(required(destination.channels[0]).cells[0]).toBe(3);
    expect(
      required(required(required(destination.channels[0]).patterns[3]).notes[0]).pitches,
    ).toEqual([48, 52, 55]);
    expect(required(destination.channels[0]).instruments).toEqual(instrument);
  });
  test("time fragments repeat into destination and crop last repeat", () => {
    const source = phrase();
    const clip = copyPatterns(source, { ...cell(), timeStart: 0, timeEnd: 1 });
    const destination = createSong();
    pastePatterns(destination, { ...cell(), timeStart: 2, timeEnd: 4.5 }, clip);
    expect(
      required(required(destination.channels[0]).patterns[1]).notes.map((note) => [
        note.start,
        note.end,
      ]),
    ).toEqual([
      [2, 3],
      [3, 4],
      [4, 4.5],
    ]);
  });
  test("multi-cell paste preserves source reuse and leaves outside pattern intact", () => {
    const source = phrase();
    const destination = phrase();
    required(source.channels[0]).cells[1] = 0;
    const clip = copyPatterns(source, { ...cell(), barEnd: 2 });
    pastePatterns(destination, { ...cell(4), barEnd: 9 }, clip);
    const channel = required(destination.channels[0]);
    expect(channel.cells[4]).toBe(channel.cells[6]);
    expect(channel.cells[4]).toBe(channel.cells[7]);
    expect(channel.cells[5]).toBe(0);
    expect(channel.cells[8]).toBe(0);
    expect(required(channel.patterns[1]).notes).toHaveLength(1);
  });
  test("whole-cell pastes reuse matching content under a different pattern number", () => {
    const source = phrase();
    const destination = createSong();
    const channel = required(destination.channels[0]);
    channel.cells.fill(0);
    channel.cells[0] = 1;
    channel.cells[1] = 3;
    addNote(destination, 0, 0, createNote(0, 2, 72));
    addNote(destination, 0, 1, createNote(0, 2, [48, 52, 55]));
    const matching = clone(required(channel.patterns[3]));
    const { patternCount } = destination;
    const clip = copyPatterns(source, cell());

    pastePatterns(destination, cell(2), clip);
    pastePatterns(destination, { ...cell(3), barEnd: 4 }, clip);

    expect(channel.cells.slice(0, 5)).toEqual([1, 3, 3, 3, 3]);
    expect(channel.patterns[3]).toEqual(matching);
    expect(destination.patternCount).toBe(patternCount);
  });
  test("incompatible rows are skipped without compressing offsets", () => {
    const source = phrase();
    source.channels.splice(1, 0, createChannel("automation"));
    required(source.channels[1]).cells[0] = 1;
    required(required(source.channels[1]).patterns[1]).lanes = [lane()];
    const destination = phrase();
    const warnings = pastePatterns(
      destination,
      cell(),
      copyPatterns(source, { ...cell(), channelEnd: 2 }),
    );
    expect(warnings).toContain("Skipped incompatible pitch and automation rows.");
    expect(required(required(destination.channels[1]).patterns[1]).notes).toEqual([]);
  });
  test("zero-length and malformed clipboard are rejected", () => {
    expect(validateClipboard({ version: 1, duration: 0, rows: [] })).toBe(false);
    expect(
      validateClipboard({
        version: 1,
        songId: "song",
        wholeBars: true,
        duration: 1,
        rows: [{ channelId: "track", kind: "track", cells: [99], patterns: {} }],
      }),
    ).toBe(false);
  });
  test("paste allocation and cleanup are exactly reversible", () => {
    const history = new History(phrase());
    const before = encodeSong(history.song);
    const source = createSong();
    addNote(source, 0, 0, createNote(1, 3, 70));
    const clip = copyPatterns(source, { ...cell(), barEnd: 1 });
    history.execute((song) => {
      pastePatterns(song, { ...cell(), barEnd: 1 }, clip);
    });
    history.undo();
    expect(encodeSong(history.song)).toBe(before);
    history.redo();
    expect(
      required(
        required(
          required(history.song.channels[0]).patterns[
            required(required(history.song.channels[0]).cells[0])
          ],
        ).notes[0],
      ).pitches,
    ).toEqual([70]);
  });
});
describe("structural edits and timing", () => {
  test("growing meter splices at end; shrinking trims notes and automation", () => {
    const song = phrase();
    const auto = createChannel("automation");
    song.channels.push(auto);
    auto.cells[0] = 1;
    required(auto.patterns[1]).lanes = [lane()];
    setBeatsPerBar(song, 12);
    expect(required(required(required(song.channels[0]).patterns[1]).notes[0]).end).toBe(2);
    setBeatsPerBar(song, 1);
    expect(required(required(required(song.channels[0]).patterns[1]).notes[0]).end).toBe(1);
    expect(required(required(required(auto.patterns[1]).lanes[0]).points.at(-1)).time).toBe(1);
    validateSong(song);
  });
  test("same meter is a history no-op", () => {
    const history = new History(phrase());
    expect(
      history.execute((song) => {
        setBeatsPerBar(song, 8);
      }),
    ).toBe(false);
  });
  test("length and capacity shrink repair references and loop", () => {
    const song = phrase();
    song.loopStart = 12;
    song.loopEnd = 16;
    setSongLength(song, 2);
    expect([song.loopStart, song.loopEnd]).toEqual([1, 2]);
    setPatternCount(song, 1);
    expect(song.channels.every((channel) => channel.cells.length === 2)).toBe(true);
    validateSong(song);
  });
  test("insert and delete bars affect all rows and retain stored patterns", () => {
    const song = phrase();
    song.channels.push(createChannel("automation"));
    insertBars(song, { ...cell(), barEnd: 1 });
    expect(song.barCount).toBe(18);
    expect(
      song.channels.every((channel) => channel.cells.slice(2, 4).every((value) => value === 0)),
    ).toBe(true);
    deleteBars(song, { ...cell(2), barEnd: 3 });
    expect(song.barCount).toBe(16);
    expect(required(required(song.channels[0]).patterns[1]).notes).toHaveLength(1);
    deleteBars(song, { ...cell(), barEnd: 15 });
    expect(song.barCount).toBe(1);
    validateSong(song);
  });
  test("inserting a track creates an empty arrangement", () => {
    const song = phrase();
    insertChannelBelow(song, 0);
    expect(song.channels).toHaveLength(4);
    expect(required(song.channels[1]).cells).toEqual(Array<number>(song.barCount).fill(0));
  });
  test("channel counts and deletion retain at least one track", () => {
    const song = createSong();
    setChannelCount(song, "track", 0);
    expect(song.channels).toHaveLength(1);
    setChannelCount(song, "automation", 2);
    expect(song.channels).toHaveLength(3);
    deleteChannels(song, { ...cell(), channelEnd: 2 });
    expect(song.channels).toHaveLength(1);
    expect(required(song.channels[0]).kind).toBe("track");
  });
  test("channel movement preserves identity and auto target bindings", () => {
    const song = createSong();
    const target = required(song.channels[0]).id;
    song.channels.splice(1, 0, createChannel("automation", song.barCount, song.patternCount));
    required(song.channels[1]).target = { kind: "channel", channelId: target };
    moveChannels(song, cell(0, 0), 1);
    expect(required(song.channels[1]).id).toBe(target);
    expect(required(song.channels[0]).target.channelId).toBe(target);
  });
  test("overflow timing carries a bar-crossing note into next bar", () => {
    const song = createSong();
    assignPattern(song, { ...cell(), barEnd: 3 }, 0);
    addNote(song, 0, 0, createNote(7, 8, 48));
    moveAllNotes(song, 0.5, false);
    const channel = required(song.channels[0]);
    expect(
      required(channel.patterns[required(channel.cells[0])]).notes.map((note) => [
        note.start,
        note.end,
      ]),
    ).toEqual([[7.5, 8]]);
    expect(
      required(channel.patterns[required(channel.cells[1])]).notes.map((note) => [
        note.start,
        note.end,
      ]),
    ).toEqual([[0, 0.5]]);
    validateSong(song);
  });
  test("wrap rotates pattern time without changing arrangement", () => {
    const song = createSong();
    addNote(song, 0, 0, createNote(7, 8, 48));
    const before = [...required(song.channels[0]).cells];
    moveAllNotes(song, 0.5, true);
    expect(required(song.channels[0]).cells).toEqual(before);
    expect(
      required(required(song.channels[0]).patterns[1]).notes.map((note) => [note.start, note.end]),
    ).toEqual([
      [0, 0.5],
      [7.5, 8],
    ]);
    validateSong(song);
  });
  test("detect key preserves sounding pitch reference", () => {
    const song = createSong();
    addNote(song, 0, 0, createNote(0, 4, 55));
    const sounding =
      song.key +
      required(required(required(required(song.channels[0]).patterns[1]).notes[0]).pitches[0]);
    expect(detectKey(song)).toBe(7);
    expect(
      song.key +
        required(required(required(required(song.channels[0]).patterns[1]).notes[0]).pitches[0]),
    ).toBe(sounding);
  });
});
describe("automation", () => {
  test("hold and linear evaluation reset outside explicit lane bounds", () => {
    const value = lane();
    expect(evaluateLane(value, 2)).toBe(150);
    expect(evaluateLane(value, 5)).toBeUndefined();
    value.interpolation = "hold";
    expect(evaluateLane(value, 2)).toBe(100);
    value.enabled = false;
    expect(evaluateLane(value, 2)).toBeUndefined();
  });
  test("erasing whole bar removes automation rather than leaving boundary overrides", () => {
    const song = createSong();
    const auto = createChannel("automation");
    song.channels.push(auto);
    auto.cells[0] = 1;
    required(auto.patterns[1]).lanes = [lane()];
    eraseTime(song, cell(0, 3));
    expect(required(auto.patterns[1]).lanes).toHaveLength(0);
  });
  test("transport crops do not synthesize new next-bar events", () => {
    const song = createSong();
    const auto = createChannel("automation");
    song.channels.push(auto);
    auto.cells[0] = 1;
    required(auto.patterns[1]).lanes = [{ ...lane("nextBar"), points: [{ time: 2, value: 1 }] }];
    const clip = copyPatterns(song, { ...cell(0, 3), timeStart: 0, timeEnd: 1 });
    expect(required(required(clip.rows[0]).patterns[1]).lanes).toEqual([]);
  });
});
describe("persistence and export", () => {
  test("envelope infinities survive binary files, URLs, clipboard and history", async () => {
    const song = phrase();
    const envelope = createEnvelope();
    envelope.a = Infinity;
    envelope.b = -Infinity;
    envelope.speed = Infinity;
    required(required(song.channels[0]).instruments[0]).envelopes = [envelope];
    const loaded = decodeSong(encodeSong(song));
    expect(required(required(required(loaded.channels[0]).instruments[0]).envelopes[0]).a).toBe(
      Infinity,
    );
    expect(
      required(
        required(required(decodeSong(encodeSong(song)).channels[0]).instruments[0]).envelopes[0],
      ).b,
    ).toBe(-Infinity);
    await saveClipboard(required(required(song.channels[0]).instruments[0]), "instrument");
    expect(required(required(await loadClipboard("instrument")).envelopes[0]).speed).toBe(Infinity);
    const history = new History(song);
    expect(
      history.execute((value) => {
        required(required(required(value.channels[0]).instruments[0]).envelopes[0]).a = -Infinity;
      }),
    ).toBe(true);
    history.undo();
    expect(
      required(required(required(history.song.channels[0]).instruments[0]).envelopes[0]).a,
    ).toBe(Infinity);
  });
  test("resource identities and playback metadata survive serialization", () => {
    const song = phrase();
    song.resources = [
      {
        id: "resource",
        url: "https://example.com/sample.wav",
        rootKey: 60,
        loopStart: 10,
        loopEnd: 400,
      },
    ];
    required(required(song.channels[0]).instruments[0]).resourceId = "resource";
    expect(decodeSong(encodeSong(song)).resources).toEqual(song.resources);
  });
  test("Binary files and URLs round trip complete unicode project data", () => {
    const song = phrase();
    song.title = "曲 🎵 & <song>";
    song.scale = "Custom";
    song.customScale = [0, 1, 7];
    song.detune = 33;
    song.volume = 73;
    const auto = createChannel("automation");
    auto.cells[0] = 1;
    required(auto.patterns[1]).lanes = [lane()];
    auto.target = {
      kind: "instrument",
      channelId: required(song.channels[0]).id,
      instrumentId: required(required(song.channels[0]).instruments[0]).id,
    };
    song.channels.push(auto);
    expect(decodeSong(encodeSong(song))).toEqual(song);
    expect(decodeSong(new URL(songURL(song, "https://example.com/slopemp/?x=1")).hash)).toEqual(
      song,
    );
  });
  test("corrupt and future data report failure", () => {
    expect(() => decodeSong("not JSON")).toThrow();
    expect(() => decodeSong("{}")).toThrow();
    expect(() => decodeSong("%%%invalid")).toThrow();
    const song = createSong();
    song.version = 99;
    expect(() => readSongData(song)).toThrow();
  });
  test("legacy data is rejected rather than silently repaired", () => {
    expect(() => readSongData({ channels: [], beatsPerMinute: 120 })).toThrow();
  });
  test("session and clipboards remain detached snapshots in memory", async () => {
    const song = phrase();
    const clip = copyPatterns(song, cell());
    await saveStoredSession(song);
    await saveClipboard(clip);
    await saveClipboard(required(required(song.channels[0]).instruments[0]), "instrument");
    expect(await readStoredSession()).toEqual(song);
    expect(await loadClipboard()).toEqual(clip);
    expect(required(await loadClipboard("instrument")).id).toBe(
      required(required(song.channels[0]).instruments[0]).id,
    );
    song.tempo = 200;
    expect(required(await readStoredSession()).tempo).toBe(150);
  });
  test("finite exported sequence honors independent intro loops outro", () => {
    const song = phrase();
    song.loopStart = 2;
    song.loopEnd = 4;
    setSongLength(song, 6);
    expect(exportSequence(song, { intro: true, loopCount: 2, outro: true })).toEqual([
      0, 1, 2, 3, 2, 3, 4, 5,
    ]);
    const expanded = expandSequence(song, { intro: false, loopCount: 3, outro: false });
    expect(expanded.barCount).toBe(6);
    expect([expanded.loopStart, expanded.loopEnd]).toEqual([0, 6]);
    expect(required(expanded.channels[0]).cells).toEqual([1, 1, 1, 1, 1, 1]);
    validateSong(expanded);
  });
  test("filenames remove invalid characters and fit filesystem limits", () => {
    expect(sanitizeFilename('a/b\\c:<>?*|"')).toBe("abc");
    expect(sanitizeFilename("...")).toBe("Song");
    expect(sanitizeFilename("a".repeat(300))).toHaveLength(250);
  });
});
describe("history state and operation invariants", () => {
  test("history retains exact current song, prior edits and redo branch", () => {
    const history = new History(phrase());
    history.execute((song) => {
      song.tempo = 210;
    });
    history.execute((song) => {
      setKey(song, 3);
    });
    history.execute((song) => {
      song.volume = 80;
    });
    history.undo();
    history.undo();
    expect(history.song.key).toBe(0);
    expect(history.song.tempo).toBe(210);
    history.redo();
    history.redo();
    expect(history.song.key).toBe(3);
    expect(history.song.volume).toBe(80);
  });
  test("preview cancellation restores base content and preserves undo", () => {
    const history = new History(phrase());
    history.execute((song) => {
      song.tempo = 180;
    });
    history.preview((song) => {
      song.volume = 40;
    });
    expect(history.song.volume).toBe(40);
    history.cancelPreview();
    expect(history.song.volume).toBe(100);
    expect(history.song.tempo).toBe(180);
    history.undo();
    expect(history.song.tempo).toBe(150);
  });
  test("whole paste cleans only patterns that become wholly unused and undo restores them", () => {
    const source = createSong();
    required(source.channels[0]).cells[0] = 2;
    required(source.channels[0]).cells[1] = 2;
    addNote(source, 0, 0, createNote(1, 2, 70));
    const destination = phrase();
    required(destination.channels[0]).cells.fill(0);
    required(destination.channels[0]).cells[0] = 1;
    const history = new History(destination);
    const before = encodeSong(destination);
    history.execute((song) => {
      pastePatterns(song, { ...cell(), barEnd: 1 }, copyPatterns(source, { ...cell(), barEnd: 1 }));
    });
    expect(required(required(history.song.channels[0]).patterns[1]).notes).toEqual([]);
    history.undo();
    expect(encodeSong(history.song)).toBe(before);
    history.redo();
    expect(required(required(history.song.channels[0]).patterns[1]).notes).toEqual([]);
  });
  test("pasting copied silence clears note time while preserving pattern identity", () => {
    const source = createSong();
    required(source.channels[0]).cells[0] = 0;
    const destination = phrase();
    pastePatterns(destination, cell(), copyPatterns(source, cell()));
    expect(required(destination.channels[0]).cells[0]).toBe(1);
    expect(required(required(destination.channels[0]).patterns[1]).notes).toEqual([]);
  });
  test("bounded history remains reversible after pruning", () => {
    const history = new History();
    for (let index = 0; index < 105; index++) {
      history.execute((song) => {
        song.tempo = 151 + index;
      });
    }
    let steps = 0;
    while (history.undo()) {
      steps++;
    }
    expect(steps).toBe(100);
    expect(history.song.tempo).toBe(155);
  });
  test("seeded time-fragment clipboard edits preserve invariants and reverse exactly", () => {
    let seed = 17;
    const random = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed % max;
    };
    for (let iteration = 0; iteration < 40; iteration++) {
      const source = createSong();
      const destination = createSong();
      setPatternCount(destination, 1);
      for (let bar = 0; bar < 3; bar++) {
        required(source.channels[0]).cells[bar] = bar + 1;
        for (let note = 0; note < 4; note++) {
          const start = random(28) / 4;
          addNote(
            source,
            0,
            bar,
            createNote(start, Math.min(8, start + (1 + random(4)) / 4), random(80) + 12),
          );
        }
      }
      addNote(destination, 0, 0, createNote(6, 7, 90));
      const selection = { ...cell(), barEnd: 2, timeStart: 0, timeEnd: 4 };
      const clipboard = copyPatterns(source, selection);
      const history = new History(destination);
      const before = encodeSong(destination);
      history.execute((song) => {
        pastePatterns(song, selection, clipboard);
      });
      validateSong(history.song);
      history.undo();
      expect(encodeSong(history.song)).toBe(before);
      history.redo();
      validateSong(history.song);
    }
  });
});

test("note edits share unchanged frozen branches and keep caller-owned data detached", () => {
  const history = new History(phrase());
  const before = history.song;
  const note = createNote(4, 5, 60);
  history.execute((song) => {
    required(required(song.channels[0]).patterns[1]).notes.push(note);
  });
  expect(history.song.resources).toBe(before.resources);
  expect(history.song.channels[1]).toBe(before.channels[1]);
  expect(required(history.song.channels[0]).instruments).toBe(
    required(before.channels[0]).instruments,
  );
  expect(required(history.song.channels[0]).patterns[1]).not.toBe(
    required(before.channels[0]).patterns[1],
  );
  note.pitches[0] = 12;
  expect(
    required(required(required(history.song.channels[0]).patterns[1]).notes.at(-1)).pitches,
  ).toEqual([60]);
  const after = history.song;
  history.undo();
  expect(history.song).toBe(before);
  history.redo();
  expect(history.song).toBe(after);
  const exported = clone(history.song);
  exported.title = "Detached";
  expect(history.song.title).not.toBe("Detached");
});

test("invalid note identities and incomplete or unordered contours never enter history", () => {
  const history = new History(phrase());
  const before = history.song;
  for (const corrupt of [
    (note: ReturnType<typeof createNote>): void => {
      note.pins = [];
    },
    (note: ReturnType<typeof createNote>): void => {
      required(note.pins[0]).time = 0.1;
    },
    (note: ReturnType<typeof createNote>): void => {
      required(note.pins.at(-1)).time = 0.5;
    },
    (note: ReturnType<typeof createNote>): void => {
      note.pins.splice(1, 0, { ...required(note.pins[0]) });
    },
    (note: ReturnType<typeof createNote>): void => {
      note.id = "";
    },
  ]) {
    expect(() =>
      history.execute((song) => {
        corrupt(required(required(required(song.channels[0]).patterns[1]).notes[0]));
      }),
    ).toThrow();
    expect(history.song).toBe(before);
    expect(history.canUndo).toBe(false);
  }
  expect(() =>
    history.execute((song) => {
      const { notes } = required(required(song.channels[0]).patterns[1]);
      notes.push({ ...createNote(3, 4, 60), id: required(notes[0]).id });
    }),
  ).toThrow();
  expect(history.song).toBe(before);
});
