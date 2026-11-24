import { afterEach, expect, test } from "bun:test";

import { createMultiplayerServer } from "@slopemp/server";
import { clone, createSong, createTransaction, required } from "@slopemp/song";
import { decodeClientPacket, decodeServerPacket } from "@slopemp/song/protocol";
import type { ClientPacket } from "@slopemp/song/protocol";
import { multiplayerFixture } from "@slopemp/song/test-fixtures";

import type { SongRecipe } from "../../src/model";
import { MultiplayerClient } from "../../src/multiplayer";
import type { MultiplayerEvent, MultiplayerState } from "../../src/multiplayer";
import { History } from "../../src/song-history";

const clients: MultiplayerClient[] = [];
const servers: Array<ReturnType<typeof createMultiplayerServer>> = [];
const clientEvents = new WeakMap<
  MultiplayerClient,
  Array<{ state: MultiplayerState; event: MultiplayerEvent }>
>();

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await server.stop(true);
    }),
  );
});

const until = async (ready: () => boolean, label: string): Promise<void> => {
  const end = performance.now() + 3000;
  while (!ready()) {
    if (performance.now() > end) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await Bun.sleep(5);
  }
};

const start = (song = createSong(), password = ""): string => {
  const server = createMultiplayerServer({ port: 0, song, password });
  servers.push(server);
  const address = new URL(server.url);
  address.protocol = "ws:";
  return address.href;
};

type Intercept = (packet: ClientPacket, send: () => void, socket: WebSocket) => void;
const editor = (
  intercept?: Intercept,
  secure = false,
  onSocket?: (socket: WebSocket) => void,
): MultiplayerClient => {
  const events: Array<{ state: MultiplayerState; event: MultiplayerEvent }> = [];
  const client = new MultiplayerClient(
    (state, event) => {
      events.push({ state, event });
    },
    {
      secure,
      retryDelay: 150,
      createSocket(address): WebSocket {
        const socket = new WebSocket(address);
        onSocket?.(socket);
        if (intercept) {
          const send = socket.send.bind(socket);
          socket.send = (data): void => {
            if (typeof data === "string") {
              intercept(
                decodeClientPacket(data),
                () => {
                  send(data);
                },
                socket,
              );
            } else {
              send(data);
            }
          };
        }
        return socket;
      },
    },
  );
  clientEvents.set(client, events);
  clients.push(client);
  return client;
};

const join = async (client: MultiplayerClient, address: string, password = ""): Promise<void> => {
  expect(client.connect(address, password)).toBe(true);
  await until(() => client.state.status === "connected", "authentication");
};

const edit = (client: MultiplayerClient, recipe: SongRecipe): string => {
  const before = required(client.state.song);
  const after = clone(before);
  recipe(after);
  return required(client.submit(createTransaction(before, after)));
};

const revisions = async (revision: number, ...editors: MultiplayerClient[]): Promise<void> => {
  await until(
    () =>
      editors.every(
        (client) => client.state.revision === revision && client.state.pending.length === 0,
      ),
    `revision ${revision}`,
  );
};

const rejectedIds = (client: MultiplayerClient): string[] =>
  required(clientEvents.get(client)).flatMap(({ event }) =>
    event.type === "accepted" || event.type === "snapshot" ? event.rejected : [],
  );

const collaborate = (history: History, address: string, errors: string[]): MultiplayerClient => {
  const client = new MultiplayerClient((state, event) => {
    if (event.type === "snapshot" && state.song && history.committedSong.id !== state.song.id) {
      history.beginCollaboration(state.song, {
        editable: () => client.state.status === "connected" && !client.state.recovering,
        submit: (transaction, lock) => client.submit(transaction, lock),
        onError: (message) => {
          errors.push(message);
        },
      });
    }
    if (event.type === "accepted" || event.type === "snapshot") {
      for (const id of event.rejected) {
        history.settle(id, false);
      }
      if (event.type === "accepted" && state.song) {
        if (event.editorId === state.editorId) {
          history.settle(event.id, true);
        }
        history.reconcile(state.song, event.editorId === state.editorId ? [] : [event.transaction]);
      } else if (event.type === "snapshot" && state.song) {
        for (const receipt of event.receipts) {
          history.settle(receipt.id, true);
        }
        history.reconcile(
          state.song,
          event.changes
            .filter(({ editorId }) => editorId !== state.editorId)
            .map(({ transaction }) => transaction),
        );
      }
    }
  });
  clients.push(client);
  expect(client.connect(address)).toBe(true);
  return client;
};

test("keeps multiplayer optional, authenticates in the socket, and replicates editor colors and selections", async () => {
  const song = createSong();
  const channel = required(song.channels[0]);
  channel.cells[2] = 3;
  const address = start(song, "a room secret");
  const packets: ClientPacket[] = [];
  const first = editor((packet, send) => {
    packets.push(packet);
    send();
  });
  const second = editor();
  const secureClient = editor(undefined, true);
  expect(first.state.status).toBe("offline");
  expect(packets).toEqual([]);
  expect(secureClient.connect(address, "a room secret")).toBe(false);
  expect(secureClient.state.error).toContain("wss://");
  expect(first.connect(`${address}?password=secret`)).toBe(false);
  expect(first.connect(address, "wrong")).toBe(true);
  await until(() => first.state.status === "offline", "authentication failure");
  expect(first.state.error).toContain("Incorrect server password");
  expect(first.state.song).toBeNull();
  await join(first, address, "a room secret");
  await join(second, address, "a room secret");
  expect(first.state.address).toBe(address);
  expect(first.state.song).toEqual(song);
  expect(packets).toContainEqual({ type: "hello", password: "a room secret" });
  const selection = { channelId: channel.id, bar: 2, pattern: 3 };
  first.setSelection(selection);
  first.setSelection({ ...selection });
  await until(
    () => second.state.editors.some((entry) => entry.selection?.pattern === 3),
    "replicated selection",
  );
  expect(first.state.editors).toEqual(second.state.editors);
  expect(first.state.editors).toHaveLength(2);
  expect(new Set(first.state.editors.map(({ color }) => color)).size).toBe(2);
  expect(first.state.editors.find(({ id }) => id === first.state.editorId)?.selection).toEqual(
    selection,
  );
  expect(
    packets.filter((packet) => packet.type === "select" && packet.selection !== null),
  ).toHaveLength(1);
  expect(first.disconnect()).toEqual(song);
  await until(() => second.state.editors.length === 1, "explicit disconnect presence");
  expect(first.state.status).toBe("offline");
  expect(first.state.song).toEqual(song);
});

test("preserves different edits from one revision and broadcasts both to each client", async () => {
  const address = start();
  const submissions: ClientPacket[] = [];
  const trace: Intercept = (packet, send) => {
    if (packet.type === "submit") {
      submissions.push(packet);
    }
    send();
  };
  const first = editor(trace);
  const second = editor(trace);
  await join(first, address);
  await join(second, address);
  edit(first, (song) => {
    song.title = "Both edits";
  });
  edit(second, (song) => {
    song.tempo = 188;
  });
  expect(submissions.map((packet) => packet.type === "submit" && packet.baseRevision)).toEqual([
    0, 0,
  ]);
  await revisions(2, first, second);
  expect(first.state.song).toEqual(second.state.song);
  expect(first.state.song).toMatchObject({ title: "Both edits", tempo: 188 });
  const observer = editor();
  await join(observer, address);
  expect(observer.state.song).toEqual(first.state.song);
  for (const client of [first, second]) {
    const accepted = required(clientEvents.get(client)).filter(
      ({ event }) => event.type === "accepted",
    );
    expect(accepted).toHaveLength(2);
    expect(rejectedIds(client)).toEqual([]);
  }
});

test("discards rejected edits and retains independent pending edits", async () => {
  const address = start();
  const first = editor();
  const delayed: Array<() => void> = [];
  const second = editor((packet, send) => {
    if (packet.type === "submit" && delayed.length === 0) {
      delayed.push(send);
    } else {
      send();
    }
  });
  await join(first, address);
  await join(second, address);
  const losing = edit(second, (song) => {
    song.title = "Rejected title";
  });
  edit(second, (song) => {
    song.volume = 83;
  });
  edit(first, (song) => {
    song.title = "Authoritative title";
  });
  await until(() => second.state.revision === 1, "the winner's committed edit");
  const [transmit] = delayed;
  const send = required(transmit);
  send();
  await revisions(2, first, second);
  expect(first.state.song).toEqual(second.state.song);
  expect(second.state.song).toMatchObject({ title: "Authoritative title", volume: 83 });
  expect(rejectedIds(second)).toEqual([losing]);
  expect(required(clientEvents.get(second)).some(({ state }) => state.recovering)).toBe(true);
  expect(second.disconnect()).toMatchObject({ title: "Authoritative title", volume: 83 });
});

test("repairs a divergent local song while applying future broadcasts without refreshing", async () => {
  const address = start();
  const first = editor();
  const second = editor();
  await join(first, address);
  await join(second, address);
  required(first.state.song).title = "Incorrect local title";
  edit(second, (song) => {
    song.tempo = 168;
  });
  await revisions(1, first, second);
  expect(first.state.song).toEqual(second.state.song);
  expect(first.state.song?.title).toBe("Song");
  expect(
    required(clientEvents.get(first)).filter(({ event }) => event.type === "snapshot"),
  ).toHaveLength(2);
  edit(second, (song) => {
    song.detune = 23;
  });
  await revisions(2, first, second);
  expect(first.state.song).toEqual(second.state.song);
});

test("retains unacknowledged edits during socket loss and resubmits pending edits on rejoin", async () => {
  const address = start();
  let interrupted = false;
  const first = editor((packet, send, socket) => {
    if (packet.type === "submit" && !interrupted) {
      interrupted = true;
      socket.close();
    } else {
      send();
    }
  });
  const second = editor();
  await join(first, address);
  await join(second, address);
  const identity = first.state.editorId;
  const pending = edit(first, (song) => {
    song.title = "Retained edit";
  });
  await until(() => first.state.status === "reconnecting", "socket loss");
  expect(first.state.pending).toEqual([pending]);
  expect(first.state.song?.title).toBe("Retained edit");
  expect(
    first.submit(createTransaction(required(first.state.song), required(first.state.song))),
  ).toBeNull();
  edit(second, (song) => {
    song.tempo = 170;
  });
  await revisions(2, first, second);
  expect(first.state.status).toBe("connected");
  expect(first.state.editorId).toBe(identity);
  expect(first.state.song).toEqual(second.state.song);
  expect(first.state.song).toMatchObject({ title: "Retained edit", tempo: 170 });
  expect(rejectedIds(first)).toEqual([]);
});

test("disconnect keeps the server-confirmed song and discards pending edits", async () => {
  const song = createSong();
  const address = start(song);
  const client = editor((packet, send) => {
    if (packet.type !== "submit") {
      send();
    }
  });
  await join(client, address);
  edit(client, (pending) => {
    pending.title = "Unconfirmed title";
  });
  expect(client.state.song?.title).toBe("Unconfirmed title");
  expect(client.disconnect()).toEqual(song);
  expect(client.state.song).toEqual(song);
  expect(client.state.pending).toEqual([]);
});

test("receives a single receipt on reconnect when the server committed before the socket dropped", async () => {
  const address = start();
  let id: string | null = null;
  let interrupted = false;
  const first = editor(undefined, false, (socket) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const packet = decodeServerPacket(event.data);
      if (!interrupted && packet.type === "accepted" && packet.id === id) {
        interrupted = true;
        event.stopImmediatePropagation();
        socket.close();
      }
    });
  });
  const second = editor();
  await join(first, address);
  await join(second, address);
  id = edit(first, (song) => {
    song.title = "Committed before reconnect";
  });
  await until(() => first.state.status === "reconnecting", "the missing receipt");
  expect(first.state.pending).toEqual([id]);
  await revisions(1, second);
  await revisions(1, first, second);
  expect(first.state.song).toEqual(second.state.song);
  const receipts = required(clientEvents.get(first)).flatMap(({ event }) =>
    event.type === "snapshot" ? event.receipts : [],
  );
  expect(receipts.map((receipt) => receipt.id)).toEqual([id]);
  expect(rejectedIds(first)).toEqual([]);
});

test("enforces track locks, leaves unrelated edits available, and keeps a lock through its commit", async () => {
  const address = start();
  const delayed: Array<() => void> = [];
  const first = editor((packet, send) => {
    if (packet.type === "submit" && delayed.length === 0) {
      delayed.push(send);
    } else {
      send();
    }
  });
  const second = editor();
  await join(first, address);
  await join(second, address);
  const channel = required(first.state.song?.channels[0]);
  const lock = { channelId: channel.id };
  expect(await first.acquireLock(lock)).toBe(true);
  expect(await second.acquireLock(lock)).toBe(false);
  expect(second.state.locks).toEqual([{ scope: lock, editorId: required(first.state.editorId) }]);
  const rejected = edit(second, (song) => {
    required(song.channels[0]).name = "Blocked name";
  });
  await until(() => rejectedIds(second).includes(rejected), "lock rejection");
  expect(second.state.revision).toBe(0);
  edit(second, (song) => {
    required(song.channels[1]).name = "Available track";
  });
  await revisions(1, first, second);
  edit(first, (song) => {
    song.title = "Earlier edit in the submission queue";
  });
  const before = required(first.state.song);
  const after = clone(before);
  required(after.channels[0]).cells[0] = 1;
  expect(first.submit(createTransaction(before, after), lock)).not.toBeNull();
  first.releaseLock(lock);
  expect(await second.acquireLock(lock)).toBe(false);
  const [transmit] = delayed;
  const send = required(transmit);
  send();
  await revisions(3, first, second);
  await until(() => second.state.locks.length === 0, "lock release");
  expect(await second.acquireLock(lock)).toBe(true);
  expect(first.state.song).toEqual(second.state.song);
});

test("scopes a custom-editor lock to its instrument until the editor closes", async () => {
  const address = start();
  const first = editor();
  const second = editor();
  await join(first, address);
  await join(second, address);
  const channel = required(first.state.song?.channels[0]);
  const instrument = required(channel.instruments[0]);
  const scope = { channelId: channel.id, editor: `instrument:${instrument.id}` };
  expect(await first.acquireLock(scope)).toBe(true);
  expect(await second.acquireLock({ channelId: channel.id })).toBe(false);
  expect(await second.acquireLock(scope)).toBe(false);
  edit(second, (song) => {
    required(song.channels[0]).name = "Same track, unrelated action";
  });
  await revisions(1, first, second);
  const changeInstrument: SongRecipe = (song) => {
    required(required(song.channels[0]).instruments[0]).volume = 0.37;
  };
  const blocked = edit(second, changeInstrument);
  await until(() => rejectedIds(second).includes(blocked), "instrument lock rejection");
  first.releaseLock(scope);
  await until(() => second.state.locks.length === 0, "custom editor lock release");
  edit(second, changeInstrument);
  await revisions(2, first, second);
  expect(required(first.state.song?.channels[0]?.instruments[0]).volume).toBe(0.37);
  expect(first.state.song).toEqual(second.state.song);
});

test("runs the same complex transactions offline, through connected histories, and on the server", async () => {
  const initial = createSong();
  const fixture = multiplayerFixture(initial);
  const address = start(initial);
  const offline = new History(initial);
  const connected = new History();
  const errors: string[] = [];
  const first = collaborate(connected, address, errors);
  const second = editor();
  await until(() => first.state.status === "connected", "history connection");
  await join(second, address);
  for (let index = 0; index < fixture.length; index += 1) {
    const transaction = required(fixture[index]);
    expect(offline.commit(transaction)).toBe(true);
    expect(connected.commit(transaction)).toBe(true);
    await revisions(index + 1, first, second);
    expect(first.state.song).toEqual(offline.song);
    expect(second.state.song).toEqual(offline.song);
    expect(connected.song).toEqual(offline.song);
  }
  const observer = editor();
  await join(observer, address);
  expect(observer.state.song).toEqual(offline.song);
  expect(errors).toEqual([]);
});

test("rejected edits leave no undo entry after the server song is restored", async () => {
  const address = start();
  const owner = editor();
  await join(owner, address);
  const scope = { channelId: required(owner.state.song?.channels[0]).id };
  expect(await owner.acquireLock(scope)).toBe(true);
  const history = new History();
  const errors: string[] = [];
  const client = collaborate(history, address, errors);
  await until(() => client.state.status === "connected", "history connection");
  expect(
    history.execute((song) => {
      required(song.channels[0]).name = "Rejected track name";
    }),
  ).toBe(true);
  await until(
    () => client.state.pending.length === 0 && !client.state.recovering,
    "rejected edit reconciliation",
  );
  expect(history.song).toEqual(required(owner.state.song));
  expect(history.undo()).toBe(false);
  expect(errors).toEqual([]);
});

test("collaborative undo and redo preserve another editor's work and surface conflicts", async () => {
  const address = start();
  const history = new History();
  const errors: string[] = [];
  const first = collaborate(history, address, errors);
  const second = editor();
  await until(() => first.state.status === "connected", "history connection");
  await join(second, address);
  expect(
    history.execute((song) => {
      song.title = "My title";
    }),
  ).toBe(true);
  await revisions(1, first, second);
  edit(second, (song) => {
    song.tempo = 120;
  });
  await revisions(2, first, second);
  expect(history.undo()).toBe(true);
  await revisions(3, first, second);
  expect(second.state.song).toMatchObject({ title: "Song", tempo: 120 });
  expect(history.redo()).toBe(true);
  await revisions(4, first, second);
  expect(second.state.song).toMatchObject({ title: "My title", tempo: 120 });
  edit(second, (song) => {
    song.title = "Their title";
  });
  await revisions(5, first, second);
  expect(history.undo()).toBe(false);
  expect(errors[0]).toContain("Undo conflicts");
  expect(history.song).toEqual(required(second.state.song));
});
