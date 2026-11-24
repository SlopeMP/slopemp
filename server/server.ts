import { timingSafeEqual } from "node:crypto";

import {
  applyTransaction,
  clone,
  createSong,
  encodeWire,
  songEquals,
  transactionsConflict,
  validateSong,
} from "@slopemp/song";
import type { Song, Transaction } from "@slopemp/song";
import { songDigest } from "@slopemp/song/digest";
import { decodeClientPacket, editorLockConflicts } from "@slopemp/song/protocol";
import type {
  AcceptedTransaction,
  ClientPacket,
  EditorLock,
  EditorLockScope,
  EditorPresence,
  EditorSelection,
  ServerPacket,
} from "@slopemp/song/protocol";
import type { ServerWebSocket } from "bun";

type Connection = {
  session: Session | null;
  authTimeout: ReturnType<typeof setTimeout> | null;
};

type Socket = ServerWebSocket<Connection>;

type Session = {
  token: string;
  editor: EditorPresence;
  socket: Socket | null;
  receipts: Map<string, AcceptedTransaction>;
};

type ServerOptions = {
  hostname?: string;
  port?: number;
  password?: string;
  song?: Song;
  tls?: Bun.TLSOptions;
};

const colors = ["#58c4f6", "#ffac68", "#e5a2ff", "#80e39b", "#ff849b", "#ebe177", "#76e3d8"];
const colorAt = (index: number): string =>
  colors[index] ?? `hsl(${(index * 137.508) % 360} 78% 72%)`;

const hashPassword = (password: string): Buffer =>
  new Bun.CryptoHasher("sha256").update(password).digest();

const send = (socket: Socket, packet: ServerPacket): void => {
  socket.send(encodeWire(packet));
};

const receive = (message: Buffer | string): ClientPacket | undefined => {
  if (typeof message !== "string") {
    return undefined;
  }
  try {
    return decodeClientPacket(message);
  } catch {
    return undefined;
  }
};

const tryApply = (song: Song, transaction: Transaction): Song | undefined => {
  try {
    return applyTransaction(song, transaction);
  } catch {
    return undefined;
  }
};

const normalizeSelection = (
  song: Song,
  selection: EditorSelection | null,
): EditorSelection | null => {
  if (selection === null || selection.bar >= song.barCount) {
    return null;
  }
  const channel = song.channels.find((entry) => entry.id === selection.channelId);
  const pattern = channel?.cells[selection.bar];
  if (pattern === undefined) {
    return null;
  }
  return { channelId: selection.channelId, bar: selection.bar, pattern };
};

const scopeData = (song: Song, scope: EditorLockScope): unknown => {
  const channel = song.channels.find((entry) => entry.id === scope.channelId);
  if (scope.editor === undefined) {
    return channel;
  }
  const prefix = "instrument:";
  if (scope.editor.startsWith(prefix)) {
    const instrumentId = scope.editor.slice(prefix.length);
    return channel?.instruments.find((instrument) => instrument.id === instrumentId);
  }
  return undefined;
};

const recordingContextChanged = (before: Song, after: Song): boolean =>
  before.id !== after.id ||
  before.beatsPerBar !== after.beatsPerBar ||
  before.tempo !== after.tempo ||
  before.rhythm !== after.rhythm ||
  before.barCount !== after.barCount ||
  before.patternCount !== after.patternCount ||
  before.loopStart !== after.loopStart ||
  before.loopEnd !== after.loopEnd;

export const createMultiplayerServer = ({
  hostname = "127.0.0.1",
  port = 4174,
  password = "",
  song: initialSong = createSong(),
  tls,
}: ServerOptions = {}): Bun.Server<Connection> & { getSong: () => Song } => {
  const passwordHash = password === "" ? null : hashPassword(password);
  let song = clone(initialSong);
  validateSong(song);
  const sessions = new Map<string, Session>();
  const active = new Set<Session>();
  const changes: AcceptedTransaction[] = [];
  let locks: EditorLock[] = [];

  const broadcast = (packet: ServerPacket): void => {
    const message = encodeWire(packet);
    for (const { socket } of active) {
      socket?.send(message);
    }
  };

  const presence = (): { editors: EditorPresence[]; locks: EditorLock[] } => ({
    editors: [...active].map((session) => session.editor),
    locks,
  });

  const broadcastPresence = (): void => {
    broadcast({ type: "presence", ...presence() });
  };

  const clearAuthenticationTimeout = (socket: Socket): void => {
    if (socket.data.authTimeout !== null) {
      clearTimeout(socket.data.authTimeout);
      socket.data.authTimeout = null;
    }
  };

  const releaseLocks = (editorId: string): void => {
    locks = locks.filter((lock) => lock.editorId !== editorId);
  };

  const snapshot = (
    session: Session,
    from: number,
    pending: string[],
  ): Omit<Extract<ServerPacket, { type: "snapshot" }>, "type"> => ({
    revision: changes.length,
    song,
    receipts: [...new Set(pending)].flatMap((id) => session.receipts.get(id) ?? []),
    changes: changes.slice(from),
  });

  const hello = (socket: Socket, packet: Extract<ClientPacket, { type: "hello" }>): void => {
    clearAuthenticationTimeout(socket);
    if (passwordHash !== null && !timingSafeEqual(hashPassword(packet.password), passwordHash)) {
      send(socket, { type: "error", reason: "Incorrect server password." });
      socket.close(1008, "Authentication failed");
      return;
    }
    const existing = packet.session === undefined ? undefined : sessions.get(packet.session);
    const session = existing ?? {
      token: crypto.randomUUID(),
      editor: { id: crypto.randomUUID(), color: colorAt(sessions.size), selection: null },
      socket: null,
      receipts: new Map<string, AcceptedTransaction>(),
    };
    if (existing === undefined) {
      sessions.set(session.token, session);
    }
    // A resumed connection owns the session even if the previous socket is still closing.
    const previous = session.socket;
    session.socket = socket;
    previous?.close(4001, "Session resumed");
    releaseLocks(session.editor.id);
    session.editor.selection = normalizeSelection(song, session.editor.selection);
    socket.data.session = session;
    active.add(session);
    send(socket, {
      type: "welcome",
      session: session.token,
      editorId: session.editor.id,
      resumed: existing !== undefined,
      ...snapshot(
        session,
        existing === undefined ? changes.length : (packet.revision ?? 0),
        packet.pending ?? [],
      ),
      ...presence(),
    });
    broadcastPresence();
  };

  const updatePresence = (): void => {
    let changed = false;
    for (const { editor } of active) {
      const selection = normalizeSelection(song, editor.selection);
      if (!songEquals(selection, editor.selection)) {
        editor.selection = selection;
        changed = true;
      }
    }
    const validLocks = locks.filter((lock) => scopeData(song, lock.scope) !== undefined);
    if (changed || validLocks.length !== locks.length) {
      locks = validLocks;
      broadcastPresence();
    }
  };

  const submit = (
    socket: Socket,
    session: Session,
    packet: Extract<ClientPacket, { type: "submit" }>,
  ): void => {
    const reject = (reason: string): void => {
      send(socket, { type: "rejected", id: packet.id, reason });
    };
    const receipt = session.receipts.get(packet.id);
    if (receipt !== undefined) {
      if (songEquals(receipt.transaction, packet.transaction)) {
        send(socket, { type: "accepted", ...receipt });
      } else {
        reject("This edit identifier has already been used.");
      }
      return;
    }
    if (packet.baseRevision > changes.length) {
      reject("The edit refers to an unknown song revision.");
      return;
    }
    if (packet.transaction.changes.length === 0) {
      reject("The edit contains no changes.");
      return;
    }
    const { lock: scope } = packet;
    if (
      scope !== undefined &&
      !locks.some((lock) => lock.editorId === session.editor.id && songEquals(lock.scope, scope))
    ) {
      reject("The editor lock is no longer held.");
      return;
    }
    const candidate = tryApply(song, packet.transaction);
    if (candidate === undefined) {
      reject("This edit is invalid for the current song.");
      return;
    }
    if (
      changes
        .slice(packet.baseRevision)
        .some((accepted) => transactionsConflict(packet.transaction, accepted.transaction))
    ) {
      reject("This edit conflicts with a more recent song revision.");
      return;
    }
    if (
      locks.some(
        (lock) =>
          lock.editorId !== session.editor.id &&
          ((lock.scope.editor === undefined && recordingContextChanged(song, candidate)) ||
            !songEquals(scopeData(song, lock.scope), scopeData(candidate, lock.scope))),
      )
    ) {
      reject("Another editor is using a track or editor changed by this edit.");
      return;
    }
    const accepted: AcceptedTransaction = {
      id: packet.id,
      editorId: session.editor.id,
      revision: changes.length + 1,
      transaction: packet.transaction,
      checksum: songDigest(candidate),
    };
    song = candidate;
    changes.push(accepted);
    session.receipts.set(packet.id, accepted);
    broadcast({ type: "accepted", ...accepted });
    updatePresence();
  };

  const setLock = (
    socket: Socket,
    session: Session,
    packet: Extract<ClientPacket, { type: "lock" }>,
  ): void => {
    const { channelId, editor } = packet.scope;
    const scope: EditorLockScope = { channelId, ...(editor !== undefined && { editor }) };
    const ownsScope = (lock: EditorLock): boolean =>
      lock.editorId === session.editor.id && songEquals(scope, lock.scope);
    const own = locks.some(ownsScope);
    const granted =
      !packet.acquire ||
      (scopeData(song, scope) !== undefined &&
        !locks.some(
          (lock) => lock.editorId !== session.editor.id && editorLockConflicts(scope, lock.scope),
        ));
    const changed = granted && own !== packet.acquire;
    if (changed) {
      locks = packet.acquire
        ? [...locks, { scope, editorId: session.editor.id }]
        : locks.filter((lock) => !ownsScope(lock));
    }
    send(socket, { type: "lock-result", requestId: packet.requestId, granted });
    if (changed) {
      broadcastPresence();
    }
  };

  const server = Bun.serve<Connection>({
    hostname,
    port,
    ...(tls !== undefined && { tls }),
    fetch(request, listener) {
      if (listener.upgrade(request, { data: { session: null, authTimeout: null } })) {
        return undefined;
      }
      return new Response("SlopeMP WebSocket endpoint.", { status: 426 });
    },
    websocket: {
      closeOnBackpressureLimit: true,
      open(socket) {
        socket.data.authTimeout = setTimeout(() => {
          socket.close(1008, "Authentication timed out");
        }, 10_000);
      },
      message(socket, message) {
        const packet = receive(message);
        if (packet === undefined) {
          send(socket, { type: "error", reason: "Invalid multiplayer packet." });
          socket.close(1008, "Invalid packet");
          return;
        }
        const { session } = socket.data;
        if (session === null) {
          if (packet.type === "hello") {
            hello(socket, packet);
          } else {
            send(socket, { type: "error", reason: "Authenticate before joining." });
            socket.close(1008, "Authentication required");
          }
          return;
        }
        if (session.socket !== socket) {
          return;
        }
        switch (packet.type) {
          case "hello": {
            send(socket, { type: "error", reason: "This connection is already authenticated." });
            break;
          }
          case "submit": {
            submit(socket, session, packet);
            break;
          }
          case "sync": {
            send(socket, {
              type: "snapshot",
              ...snapshot(session, packet.revision, packet.pending),
            });
            break;
          }
          case "select": {
            const selection = normalizeSelection(song, packet.selection);
            if (!songEquals(selection, session.editor.selection)) {
              session.editor.selection = selection;
              broadcastPresence();
            }
            break;
          }
          case "lock": {
            setLock(socket, session, packet);
            break;
          }
        }
      },
      close(socket) {
        clearAuthenticationTimeout(socket);
        const { session } = socket.data;
        if (session !== null && session.socket === socket) {
          session.socket = null;
          active.delete(session);
          releaseLocks(session.editor.id);
          broadcastPresence();
        }
      },
    },
  });
  return Object.assign(server, { getSong: (): Song => clone(song) });
};
