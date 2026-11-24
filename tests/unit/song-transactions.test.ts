import { expect, test } from "bun:test";

import {
  applyTransaction,
  clone,
  createChannel,
  createNote,
  createSong,
  createTransaction,
  decodeWire,
  encodeWire,
  invertTransaction,
  required,
  songEquals,
  transactionsConflict,
} from "@slopemp/song";
import type { EditPath, Song, Transaction } from "@slopemp/song";

const change = (song: Song, recipe: (draft: Song) => void): Transaction => {
  const draft = clone(song);
  recipe(draft);
  return createTransaction(song, draft);
};

test("transactions serialize and exactly reverse a complex arrangement", () => {
  const song = createSong();
  const arrangements = change(song, (draft) => {
    draft.tempo = 165;
    const first = required(draft.channels[0]);
    first.cells[0] = 1;
    required(first.patterns[1]).notes.push(createNote(0, 3, [36, 40, 43]));
    draft.channels.reverse();
  });
  const arranged = applyTransaction(song, arrangements);
  const second = change(arranged, (draft) => {
    const channel = required(draft.channels[1]);
    channel.name = "Countermelody";
    channel.cells[1] = 2;
    required(channel.patterns[2]).notes.push(createNote(1, 4, 48));
  });
  const transactions = [arrangements, second, invertTransaction(second), second];
  let current = song;
  for (const transaction of transactions) {
    const decoded = decodeWire(encodeWire(transaction));
    expect(decoded).toEqual(transaction);
    current = applyTransaction(current, transaction);
  }
  expect(current.tempo).toBe(165);
  expect(current.channels.some(({ name }) => name === "Countermelody")).toBe(true);
  for (const transaction of transactions.toReversed()) {
    current = applyTransaction(current, invertTransaction(transaction));
  }
  expect(current).toEqual(song);
});

test("entity edits commute with channel reordering and undo preserves the remote edit", () => {
  const song = createSong();
  const original = required(song.channels[0]);
  const reorder = change(song, (draft) => {
    draft.channels.reverse();
  });
  const rename = change(song, (draft) => {
    required(draft.channels[0]).name = "New name";
  });
  expect(transactionsConflict(reorder, rename)).toBe(false);
  const first = applyTransaction(applyTransaction(song, reorder), rename);
  expect(first).toEqual(applyTransaction(applyTransaction(song, rename), reorder));
  expect(first.channels.at(-1)?.id).toBe(original.id);
  expect(applyTransaction(first, invertTransaction(reorder))).toEqual(
    applyTransaction(song, rename),
  );
});

test("channel removals conflict with dependent writes and array ordering is reversible", () => {
  const song = createSong();
  const remove = change(song, (draft) => {
    draft.channels.splice(0, 2);
    draft.channels.splice(1, 0, createChannel());
  });
  const rename = change(song, (draft) => {
    required(draft.channels[1]).name = "New name";
  });
  expect(transactionsConflict(remove, rename)).toBe(true);
  expect(applyTransaction(applyTransaction(song, remove), invertTransaction(remove))).toEqual(song);
  expect(() => applyTransaction(applyTransaction(song, rename), remove)).toThrow();
});

test("cell, pattern and meter dependencies prevent structural conflicts", () => {
  const song = createSong();
  const channelId = required(song.channels[0]).id;
  const draw = (reads: EditPath[] = []): Transaction => {
    const draft = clone(song);
    required(required(draft.channels[0]).patterns[1]).notes.push(createNote(0, 3, 48));
    return createTransaction(song, draft, reads);
  };
  const assign = change(song, (draft) => {
    required(draft.channels[0]).cells[0] = 1;
  });
  const remove = change(song, (draft) => {
    delete required(draft.channels[0]).patterns[1];
  });
  const meter = change(song, (draft) => {
    draft.beatsPerBar = 6;
  });
  expect(transactionsConflict(assign, remove)).toBe(true);
  expect(transactionsConflict(draw(), meter)).toBe(true);
  expect(transactionsConflict(draw(), assign)).toBe(false);
  expect(transactionsConflict(draw([["channels", { id: channelId }, "cells", 0]]), assign)).toBe(
    true,
  );
});

test("atomic application rolls back earlier fields after an invalid or stale write", () => {
  const song = createSong();
  const invalidTempo = change(song, (draft) => {
    draft.title = "Should never appear";
    draft.tempo = -10;
  });
  expect(() => applyTransaction(song, invalidTempo)).toThrow("Invalid tempo");
  expect(song.title).toBe("Song");
  const compound = change(song, (draft) => {
    draft.title = "Should never appear";
    draft.tempo = 210;
  });
  const current = applyTransaction(
    song,
    change(song, (draft) => {
      draft.tempo = 180;
    }),
  );
  expect(() => applyTransaction(current, compound)).toThrow("changed");
  expect(current.title).toBe("Song");
  expect(() =>
    applyTransaction(song, {
      songId: song.id,
      reads: [],
      changes: [{ kind: "value", path: ["password"], after: "secret" }],
    }),
  ).toThrow("Invalid song data");
});

test("wire values retain supported infinity and ignore undefined optional properties", () => {
  const song = createSong();
  const draft = clone(song);
  const instrument = required(required(draft.channels[0]).instruments[0]);
  const { envelope } = required(instrument.drums[0]);
  envelope.a = -Infinity;
  envelope.b = Infinity;
  envelope.speed = Infinity;
  required(draft.channels[0]).effects.push({
    id: "wire-test",
    type: "Gain",
    enabled: true,
    parameters: { $number: "+", gain: 80 },
  });
  const transaction = createTransaction(song, draft);
  expect(decodeWire(encodeWire(transaction))).toEqual(transaction);
  expect(decodeWire(encodeWire(draft))).toEqual(draft);
  expect(songEquals({ sampleStart: undefined }, {})).toBe(true);
});

test("opening a different song is reversible through field and entity edits", () => {
  const song = createSong();
  const other = createSong();
  other.title = "Imported";
  const transaction = createTransaction(song, other);
  expect(transaction.changes.every(({ path }) => path.length > 0)).toBe(true);
  const result = applyTransaction(song, transaction);
  expect(result).toEqual(other);
  expect(applyTransaction(result, invertTransaction(transaction))).toEqual(song);
});

test("independent notes in the same pattern merge in chronological order", () => {
  const song = createSong();
  const insert = (start: number): Transaction =>
    change(song, (draft) => {
      required(required(draft.channels[0]).patterns[1]).notes.push(
        createNote(start, start + 1, 48),
      );
    });
  const early = insert(1);
  const late = insert(5);
  expect(transactionsConflict(early, late)).toBe(false);
  const first = applyTransaction(applyTransaction(song, late), early);
  const second = applyTransaction(applyTransaction(song, early), late);
  expect(first).toEqual(second);
  expect(required(required(first.channels[0]).patterns[1]).notes.map(({ start }) => start)).toEqual(
    [1, 5],
  );
  expect(applyTransaction(first, invertTransaction(late))).toEqual(applyTransaction(song, early));
});

test("moving a note chronologically retains a concurrently inserted note", () => {
  const song = createSong();
  const { notes } = required(required(song.channels[0]).patterns[1]);
  notes.push(createNote(1, 2, 48));
  const move = change(song, (draft) => {
    const note = required(required(required(draft.channels[0]).patterns[1]).notes[0]);
    note.start = 5;
    note.end = 6;
  });
  const insert = change(song, (draft) => {
    required(required(draft.channels[0]).patterns[1]).notes.push(createNote(3, 4, 48));
  });
  expect(transactionsConflict(move, insert)).toBe(false);
  const result = applyTransaction(applyTransaction(song, insert), move);
  expect(result).toEqual(applyTransaction(applyTransaction(song, move), insert));
  expect(
    required(required(result.channels[0]).patterns[1]).notes.map(({ start }) => start),
  ).toEqual([3, 5]);
  expect(applyTransaction(result, invertTransaction(move))).toEqual(applyTransaction(song, insert));
});

test("independent bars cannot accidentally allocate the same pattern slot", () => {
  const song = createSong();
  const allocate = (bar: number, slot: number, start: number): Transaction =>
    change(song, (draft) => {
      const channel = required(draft.channels[0]);
      channel.cells[bar] = slot;
      required(channel.patterns[slot]).notes.push(createNote(start, start + 1, 48));
    });
  const first = allocate(0, 1, 1);
  const competing = allocate(1, 1, 5);
  const separate = allocate(1, 2, 5);
  expect(transactionsConflict(first, competing)).toBe(true);
  expect(transactionsConflict(first, separate)).toBe(false);
  expect(applyTransaction(applyTransaction(song, first), separate)).toEqual(
    applyTransaction(applyTransaction(song, separate), first),
  );
});
