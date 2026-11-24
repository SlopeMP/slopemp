import { expect, test } from "bun:test";

import {
  applyTransaction,
  clone,
  createNote,
  createSong,
  createTransaction,
  invertTransaction,
  required,
} from "@slopemp/song";
import type { Song, Transaction } from "@slopemp/song";
import { songDigest } from "@slopemp/song/digest";
import { multiplayerFixture } from "@slopemp/song/test-fixtures";

import { createMultiplayerServer } from "./server";
import { connect, join, submit } from "./test-peer";
import type { Packet, Peer } from "./test-peer";

const edit = (song: Song, recipe: (draft: Song) => void): Transaction => {
  const draft = clone(song);
  recipe(draft);
  return createTransaction(song, draft);
};

const readSong = async (
  peer: Peer,
  revision: number,
  pending: string[] = [],
): Promise<Packet<"snapshot">> => {
  peer.send({ type: "sync", revision, pending });
  return await peer.next("snapshot");
};

test("authenticates before exposing song data and broadcasts editor colors and selections", async () => {
  using server = createMultiplayerServer({ port: 0, password: "private room" });
  const stranger = await connect(server.url);
  stranger.send({ type: "sync", revision: 0, pending: [] });
  expect((await stranger.next("error")).reason).toBe("Authenticate before joining.");
  expect((await stranger.closed).code).toBe(1008);
  expect(stranger.packets).toEqual([]);

  const incorrect = await connect(server.url);
  incorrect.send({ type: "hello", password: "wrong" });
  expect((await incorrect.next("error")).reason).toBe("Incorrect server password.");
  expect((await incorrect.closed).code).toBe(1008);
  expect(incorrect.packets).toEqual([]);

  const first = await join(server.url, "private room");
  const second = await join(server.url, "private room");
  const room = second.welcome;
  expect(room.song).toEqual(first.welcome.song);
  expect(room.revision).toBe(0);
  expect(new Set(room.editors.map((entry) => entry.color)).size).toBe(2);
  expect(room.editors.map((entry) => entry.id)).toEqual([first.welcome.editorId, room.editorId]);
  const channelId = required(room.song.channels[0]).id;
  first.peer.send({ type: "select", selection: { channelId, bar: 1, pattern: 99 } });
  const hasSelection = (packet: Packet<"presence">): boolean =>
    packet.editors.some((entry) => entry.selection?.bar === 1);
  const selected = await first.peer.next("presence", hasSelection);
  expect(await second.peer.next("presence", hasSelection)).toEqual(selected);
  expect(selected.editors[0]?.selection).toEqual({ channelId, bar: 1, pattern: 0 });

  submit(
    second.peer,
    "assign-pattern",
    0,
    edit(room.song, (song) => {
      required(song.channels[0]).cells[1] = 3;
    }),
  );
  expect((await first.peer.next("accepted")).revision).toBe(1);
  const updated = await second.peer.next("presence", (packet) =>
    packet.editors.some((entry) => entry.selection?.pattern === 3),
  );
  expect(updated.editors[0]?.selection).toEqual({ channelId, bar: 1, pattern: 3 });
  first.peer.send({ type: "select", selection: { channelId, bar: room.song.barCount } });
  expect(
    (
      await second.peer.next("presence", (packet) =>
        packet.editors.every((entry) => entry.selection === null),
      )
    ).editors[0]?.selection,
  ).toBeNull();
});

test("orders concurrent independent edits and reverses only the author's edit", async () => {
  using server = createMultiplayerServer({ port: 0 });
  const first = await join(server.url);
  const second = await join(server.url);
  const base = first.welcome.song;
  const left = edit(base, (song) => {
    required(song.channels[0]).name = "Lead";
  });
  const right = edit(base, (song) => {
    required(song.channels[0]).enabled = false;
  });
  submit(first.peer, "rename", 0, left);
  submit(second.peer, "mute", 0, right);
  const ordered = [await first.peer.next("accepted"), await first.peer.next("accepted")];
  expect(ordered.map((packet) => packet.revision)).toEqual([1, 2]);
  for (const packet of ordered) {
    expect(await second.peer.next("accepted")).toEqual(packet);
  }
  const combined = applyTransaction(applyTransaction(base, left), right);
  expect(ordered[1]?.checksum).toBe(songDigest(combined));
  expect((await readSong(second.peer, 2)).song).toEqual(combined);

  submit(first.peer, "undo-rename", 2, invertTransaction(left));
  const reversed = await first.peer.next("accepted");
  expect(reversed.revision).toBe(3);
  expect(await second.peer.next("accepted")).toEqual(reversed);
  expect((await readSong(first.peer, 3)).song).toEqual(applyTransaction(base, right));
  submit(first.peer, "redo-rename", 3, left);
  expect((await second.peer.next("accepted")).revision).toBe(4);
  expect((await readSong(first.peer, 4)).song).toEqual(combined);

  const subsequentRename = edit(combined, (song) => {
    required(song.channels[0]).name = "Lead synth";
  });
  submit(second.peer, "rename-again", 4, subsequentRename);
  expect((await second.peer.next("accepted")).revision).toBe(5);
  submit(first.peer, "conflicting-undo", 5, invertTransaction(left));
  expect((await first.peer.next("rejected")).id).toBe("conflicting-undo");
  expect((await readSong(first.peer, 4)).song).toEqual(
    applyTransaction(combined, subsequentRename),
  );
});

test("rejects conflicting structural edits and invalid multi-edit transactions atomically", async () => {
  const song = createSong();
  using server = createMultiplayerServer({ port: 0, song });
  const first = await join(server.url);
  const second = await join(server.url);
  const meter = edit(song, (draft) => {
    draft.beatsPerBar = 12;
  });
  const note = edit(song, (draft) => {
    required(required(draft.channels[0]).patterns[1]).notes.push(createNote(0, 1, 40));
  });
  submit(first.peer, "meter", 0, meter);
  expect((await second.peer.next("accepted")).revision).toBe(1);
  submit(second.peer, "stale-note", 0, note);
  expect((await second.peer.next("rejected")).id).toBe("stale-note");

  const afterMeter = applyTransaction(song, meter);
  const invalid = edit(afterMeter, (draft) => {
    draft.title = "Leaked title";
    draft.tempo = 0;
  });
  submit(second.peer, "invalid-batch", 1, invalid);
  expect((await second.peer.next("rejected")).id).toBe("invalid-batch");
  const repair = await readSong(second.peer, 0, ["invalid-batch", "stale-note"]);
  expect(repair.revision).toBe(1);
  expect(repair.changes.map((packet) => packet.id)).toEqual(["meter"]);
  expect(repair.receipts).toEqual([]);
  expect(repair.song).toEqual(afterMeter);
});

test("rejects stale read dependencies even when a field has returned to its earlier value", async () => {
  using server = createMultiplayerServer({ port: 0 });
  const first = await join(server.url);
  const second = await join(server.url);
  const base = first.welcome.song;
  const draft = clone(base);
  draft.title = "Read the original key";
  const stale = createTransaction(base, draft, [["key"]]);
  const transpose = edit(base, (song) => {
    song.key = 4;
  });
  submit(first.peer, "new-key", 0, transpose);
  expect((await first.peer.next("accepted")).revision).toBe(1);
  submit(first.peer, "restore-key", 1, invertTransaction(transpose));
  expect((await first.peer.next("accepted")).revision).toBe(2);

  submit(second.peer, "uses-key", 0, stale);
  expect(await second.peer.next("rejected")).toMatchObject({
    id: "uses-key",
    reason: "This edit conflicts with a more recent song revision.",
  });
  const snapshot = await readSong(second.peer, 0);
  expect(snapshot.revision).toBe(2);
  expect(snapshot.song).toEqual(base);
});

test("resumes with authoritative data and edit receipts after a dropped connection", async () => {
  using server = createMultiplayerServer({ port: 0 });
  const first = await join(server.url);
  const second = await join(server.url);
  const base = first.welcome.song;
  const left = edit(base, (song) => {
    song.title = "Recovered session";
  });
  submit(first.peer, "unacknowledged", 0, left);
  const receipt = await second.peer.next("accepted");
  first.peer.close();
  await first.peer.closed;
  const right = edit(base, (song) => {
    song.tempo = 157;
  });
  submit(second.peer, "while-away", 0, right);
  expect((await second.peer.next("accepted")).revision).toBe(2);
  const reconnected = await connect(server.url);
  reconnected.send({
    type: "hello",
    password: "",
    session: first.welcome.session,
    revision: 0,
    pending: ["unacknowledged", "never-delivered"],
  });
  const welcome = await reconnected.next("welcome");
  expect(welcome.resumed).toBe(true);
  expect(welcome.editorId).toBe(first.welcome.editorId);
  expect(welcome.editors.find((entry) => entry.id === welcome.editorId)?.color).toBe(
    first.welcome.editors[0]?.color,
  );
  expect(welcome.receipts).toEqual(welcome.changes.slice(0, 1));
  expect(welcome.receipts[0]?.checksum).toBe(receipt.checksum);
  expect(welcome.changes.map((packet) => packet.id)).toEqual(["unacknowledged", "while-away"]);
  expect(welcome.song).toEqual(applyTransaction(applyTransaction(base, left), right));
  submit(reconnected, "unacknowledged", 0, left);
  expect(await reconnected.next("accepted")).toEqual(receipt);
  expect((await readSong(reconnected, 2)).revision).toBe(2);
});

test("enforces track and custom-editor locks while unrelated edits stay live", async () => {
  using server = createMultiplayerServer({ port: 0 });
  const first = await join(server.url);
  const second = await join(server.url);
  const base = first.welcome.song;
  const track = required(base.channels[0]);
  const trackScope = { channelId: track.id };
  const instrumentScope = {
    channelId: track.id,
    editor: `instrument:${required(track.instruments[0]).id}`,
  };
  first.peer.send({ type: "lock", requestId: "record", scope: trackScope, acquire: true });
  expect(await first.peer.next("lock-result")).toMatchObject({
    requestId: "record",
    granted: true,
  });
  expect((await second.peer.next("presence", (packet) => packet.locks.length === 1)).locks).toEqual(
    [{ scope: trackScope, editorId: first.welcome.editorId }],
  );
  second.peer.send({ type: "lock", requestId: "custom", scope: instrumentScope, acquire: true });
  expect((await second.peer.next("lock-result")).granted).toBe(false);

  const instrumentEdit = edit(base, (draft) => {
    const instrument = required(required(draft.channels[0]).instruments[0]);
    instrument.volume = 0.14;
  });
  submit(second.peer, "locked-slider", 0, instrumentEdit);
  expect((await second.peer.next("rejected")).id).toBe("locked-slider");
  submit(
    second.peer,
    "locked-tempo",
    0,
    edit(base, (draft) => {
      draft.tempo = 162;
    }),
  );
  expect((await second.peer.next("rejected")).id).toBe("locked-tempo");
  const elsewhere = edit(base, (draft) => {
    required(draft.channels[1]).enabled = false;
  });
  submit(second.peer, "unrelated", 0, elsewhere);
  expect((await second.peer.next("accepted")).revision).toBe(1);

  first.peer.send({ type: "lock", requestId: "stop", scope: trackScope, acquire: false });
  expect((await first.peer.next("lock-result")).granted).toBe(true);
  first.peer.send({
    type: "lock",
    requestId: "edit-custom",
    scope: instrumentScope,
    acquire: true,
  });
  expect((await first.peer.next("lock-result")).granted).toBe(true);
  submit(second.peer, "locked-custom", 1, instrumentEdit);
  expect((await second.peer.next("rejected")).id).toBe("locked-custom");
  second.peer.send({
    type: "submit",
    id: "missing-editor-lock",
    baseRevision: 1,
    transaction: instrumentEdit,
    lock: instrumentScope,
  });
  expect((await second.peer.next("rejected")).reason).toBe("The editor lock is no longer held.");
  first.peer.send({
    type: "submit",
    id: "owned-editor-lock",
    baseRevision: 1,
    transaction: instrumentEdit,
    lock: instrumentScope,
  });
  expect((await second.peer.next("accepted")).revision).toBe(2);

  const arrangement = edit(base, (draft) => {
    required(draft.channels[0]).cells[0] = 1;
  });
  submit(second.peer, "same-track-arrangement", 2, arrangement);
  expect((await second.peer.next("accepted")).revision).toBe(3);
  first.peer.close();
  await second.peer.next(
    "presence",
    (packet) => packet.editors.length === 1 && packet.locks.length === 0,
  );
  submit(second.peer, "unlocked-custom", 3, invertTransaction(instrumentEdit));
  expect((await second.peer.next("accepted")).revision).toBe(4);
});

test("runs the shared complex transaction fixture over a real WebSocket", async () => {
  const initial = createSong();
  using server = createMultiplayerServer({ port: 0, song: initial });
  const first = await join(server.url);
  const second = await join(server.url);
  let offline = initial;
  let left = first.welcome.song;
  let right = second.welcome.song;
  let revision = 0;
  for (const transaction of multiplayerFixture(initial)) {
    offline = applyTransaction(offline, transaction);
    submit(
      revision % 2 === 0 ? first.peer : second.peer,
      `fixture-${revision}`,
      revision,
      transaction,
    );
    const accepted = await first.peer.next("accepted");
    const other = await second.peer.next("accepted");
    revision++;
    expect(accepted.revision).toBe(revision);
    expect(other).toEqual(accepted);
    expect(accepted.checksum).toBe(songDigest(offline));
    left = applyTransaction(left, accepted.transaction);
    right = applyTransaction(right, other.transaction);
    expect(left).toEqual(offline);
    expect(right).toEqual(offline);
    expect((await readSong(first.peer, revision)).song).toEqual(offline);
  }
});
