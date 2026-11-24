import type { Song, Transaction } from "@slopemp/song";
import {
  applyTransaction,
  clone,
  encodeWire,
  songEquals,
  transactionsConflict,
  uid,
  validateSong,
} from "@slopemp/song";
import { songDigest } from "@slopemp/song/digest";
import type {
  AcceptedTransaction,
  ClientPacket,
  EditorLock,
  EditorLockScope,
  EditorPresence,
  EditorSelection,
  ServerPacket,
} from "@slopemp/song/protocol";
import { decodeServerPacket } from "@slopemp/song/protocol";
export { editorLockConflicts } from "@slopemp/song/protocol";

export type MultiplayerConflict = {
  id: string;
  transaction: Transaction;
  reason: string;
  draft: Song;
};

type ConnectionStatus = "connected" | "connecting" | "offline" | "reconnecting";
export type MultiplayerState = {
  status: ConnectionStatus;
  address: string | null;
  song: Song | null;
  revision: number | null;
  editorId: string | null;
  editors: readonly EditorPresence[];
  locks: readonly EditorLock[];
  pending: readonly string[];
  conflicts: readonly MultiplayerConflict[];
  recoverySong: Song | null;
  error: string | null;
  recovering: boolean;
};

export type MultiplayerEvent =
  | {
      type: "snapshot";
      receipts: readonly AcceptedTransaction[];
      changes: readonly AcceptedTransaction[];
    }
  | { type: "conflicts" | "connection" | "optimistic" | "presence" }
  | (AcceptedTransaction & { type: "accepted" });

type Connection = {
  address: string;
  password: string;
  session: string | null;
};

type Pending = {
  id: string;
  transaction: Transaction;
  lock: EditorLockScope | undefined;
  sentAt: number | null;
  rejection: string | null;
};

type LockRequest = {
  scope: EditorLockScope;
  resolve: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

type MultiplayerOptions = {
  secure?: boolean;
  createSocket?: (address: string) => WebSocket;
  retryDelay?: number;
  timeout?: number;
};

const scopeKey = (scope: EditorLockScope): string =>
  JSON.stringify([scope.channelId, scope.editor]);

const selectionsEqual = (left: EditorSelection | null, right: EditorSelection | null): boolean =>
  left?.channelId === right?.channelId &&
  left?.bar === right?.bar &&
  left?.pattern === right?.pattern;

const readAddress = (address: string, secure: boolean): string => {
  const url = URL.parse(address.trim());
  if (!url || (url.protocol !== "ws:" && url.protocol !== "wss:")) {
    throw new Error("Enter a WebSocket address beginning with ws:// or wss://.");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("Enter the server address and password in their separate fields.");
  }
  if (secure && url.protocol !== "wss:") {
    throw new Error("Use a secure wss:// server address when SlopeMP is served over HTTPS.");
  }
  return url.href;
};

const initialState = (): MultiplayerState => ({
  status: "offline",
  address: null,
  song: null,
  revision: null,
  editorId: null,
  editors: [],
  locks: [],
  pending: [],
  conflicts: [],
  recoverySong: null,
  error: null,
  recovering: false,
});

const transactionError = (error: unknown): string =>
  error instanceof Error ? error.message : "The transaction conflicts with the server song.";

const readPacket = (data: unknown): ServerPacket | null => {
  if (typeof data !== "string") {
    return null;
  }
  try {
    const packet = decodeServerPacket(data);
    if (packet.type === "welcome" || packet.type === "snapshot") {
      validateSong(packet.song);
    }
    return packet;
  } catch {
    return null;
  }
};

const applyAccepted = (song: Song, accepted: AcceptedTransaction): Song | null => {
  try {
    const next = applyTransaction(song, accepted.transaction);
    return songDigest(next) === accepted.checksum ? next : null;
  } catch {
    return null;
  }
};

export class MultiplayerClient {
  private current = initialState();
  private connection: Connection | null = null;
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private confirmed: Song | null = null;
  private queue: Pending[] = [];
  private inFlight: string | null = null;
  private selection: EditorSelection | null = null;
  private sentSelection: EditorSelection | null | undefined;
  private readonly lockRequests = new Map<string, LockRequest>();
  private readonly ownedLocks = new Set<string>();
  private readonly releasingLocks = new Map<string, EditorLockScope>();
  private recoveringLock: string | null = null;
  private readonly onUpdate: (state: MultiplayerState, event: MultiplayerEvent) => void;
  private readonly options: MultiplayerOptions;

  public constructor(
    onUpdate: (state: MultiplayerState, event: MultiplayerEvent) => void,
    options: MultiplayerOptions = {},
  ) {
    this.onUpdate = onUpdate;
    this.options = options;
  }

  public get state(): MultiplayerState {
    return this.current;
  }

  public connect(address: string, password = ""): boolean {
    if (this.connection) {
      return false;
    }
    try {
      const secure =
        this.options.secure ?? (typeof location !== "undefined" && location.protocol === "https:");
      const destination = readAddress(address, secure);
      this.connection = { address: destination, password, session: null };
      this.publish(
        { status: "connecting", address: destination, error: null },
        { type: "connection" },
      );
      this.open();
      return true;
    } catch (error) {
      this.publish({ error: transactionError(error) }, { type: "connection" });
      return false;
    }
  }

  public disconnect(): Song | null {
    const { song, conflicts } = this.current;
    this.connection = null;
    this.confirmed = null;
    this.queue = [];
    this.inFlight = null;
    this.attempts = 0;
    clearTimeout(this.retry);
    this.closeSocket();
    this.publish(
      { ...initialState(), song, ...this.conflictState(conflicts) },
      { type: "connection" },
    );
    return song;
  }

  public submit(transaction: Transaction, lock?: EditorLockScope): string | null {
    if (this.current.status !== "connected" || this.current.recovering || !this.current.song) {
      return null;
    }
    if (lock && !this.ownedLocks.has(scopeKey(lock))) {
      return null;
    }
    try {
      const owned = clone(transaction);
      const song = applyTransaction(this.current.song, owned);
      const id = uid();
      this.queue.push({ id, transaction: owned, lock, sentAt: null, rejection: null });
      this.publish({ song, pending: this.pendingIds() }, { type: "optimistic" });
      this.flush();
      return id;
    } catch (error) {
      this.publish({ error: transactionError(error) }, { type: "connection" });
      return null;
    }
  }

  public setSelection(selection: EditorSelection | null): void {
    this.selection = selection ? { ...selection } : null;
    this.sendSelection();
  }

  public async acquireLock(scope: EditorLockScope): Promise<boolean> {
    if (this.current.status === "offline") {
      return true;
    }
    if (this.current.status !== "connected" || this.current.recovering) {
      return false;
    }
    const key = scopeKey(scope);
    this.releasingLocks.delete(key);
    if (this.ownedLocks.has(key)) {
      return true;
    }
    const requestId = uid();
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finishLock(requestId, false);
        if (!this.ownedLocks.has(key)) {
          this.send({ type: "lock", requestId: uid(), scope, acquire: false });
        }
      }, this.options.timeout ?? 10_000);
      this.lockRequests.set(requestId, { scope, resolve, timer });
      if (!this.send({ type: "lock", requestId, scope, acquire: true })) {
        this.finishLock(requestId, false);
      }
    });
  }

  public releaseLock(scope: EditorLockScope): void {
    if (this.current.status === "connected") {
      this.releasingLocks.set(scopeKey(scope), scope);
      this.releaseFinishedLocks();
    }
  }

  public acknowledgeConflicts(id?: string): void {
    const conflicts =
      id === undefined ? [] : this.current.conflicts.filter((conflict) => conflict.id !== id);
    this.publish(this.conflictState(conflicts), { type: "conflicts" });
  }

  public requestSnapshot(): void {
    const { revision } = this.current;
    if (this.current.status !== "connected" || this.current.recovering || revision === null) {
      return;
    }
    this.publish({ recovering: true }, { type: "connection" });
    if (this.send({ type: "sync", revision, pending: this.pendingIds() }) && this.socket) {
      this.setDeadline(this.socket);
    }
  }

  private publish(update: Partial<MultiplayerState>, event: MultiplayerEvent): void {
    this.current = { ...this.current, ...update };
    this.onUpdate(this.current, event);
  }

  private pendingIds(): string[] {
    return this.queue.map(({ id }) => id);
  }

  private conflictState(conflicts: readonly MultiplayerConflict[]): Partial<MultiplayerState> {
    return { conflicts, recoverySong: conflicts[0]?.draft ?? null };
  }

  private closeSocket(): void {
    const { socket } = this;
    this.socket = null;
    this.sentSelection = undefined;
    clearTimeout(this.deadline);
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
    for (const requestId of this.lockRequests.keys()) {
      this.finishLock(requestId, false);
    }
    this.ownedLocks.clear();
    this.releasingLocks.clear();
    this.recoveringLock = null;
  }

  private setDeadline(socket: WebSocket): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      if (this.socket === socket) {
        this.lostConnection("The multiplayer server stopped responding.");
      }
    }, this.options.timeout ?? 10_000);
  }

  private open(): void {
    const { connection } = this;
    if (!connection) {
      return;
    }
    let socket: WebSocket | null = null;
    try {
      socket = (this.options.createSocket ?? ((address): WebSocket => new WebSocket(address)))(
        connection.address,
      );
    } catch {
      this.lostConnection("Could not open the WebSocket connection.");
      return;
    }
    this.socket = socket;
    this.setDeadline(socket);
    socket.addEventListener("open", () => {
      if (this.socket !== socket) {
        return;
      }
      const { revision } = this.current;
      this.send({
        type: "hello",
        password: connection.password,
        ...(connection.session !== null && revision !== null
          ? { session: connection.session, revision, pending: this.pendingIds() }
          : undefined),
      });
    });
    socket.addEventListener("message", ({ data }) => {
      if (this.socket !== socket) {
        return;
      }
      const packet = readPacket(data);
      if (!packet) {
        if (this.current.status === "connected") {
          this.requestSnapshot();
        } else {
          this.lostConnection("The server sent an invalid multiplayer response.");
        }
        return;
      }
      this.receive(packet);
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) {
        this.lostConnection("Could not reach the multiplayer server.");
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.lostConnection("The multiplayer connection closed.");
      }
    });
  }

  private lostConnection(error: string): void {
    this.closeSocket();
    this.inFlight = null;
    const session = this.connection?.session ?? null;
    if (session === null) {
      this.connection = null;
      this.publish({ status: "offline", address: null, error }, { type: "connection" });
      return;
    }
    this.publish(
      { status: "reconnecting", editors: [], locks: [], recovering: false, error },
      { type: "connection" },
    );
    const wait = Math.min(10_000, (this.options.retryDelay ?? 500) * 2 ** this.attempts);
    this.attempts += 1;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.open();
    }, wait);
  }

  private send(packet: ClientPacket): boolean {
    const { socket } = this;
    if (socket?.readyState !== WebSocket.OPEN) {
      if (this.current.status === "connected") {
        this.lostConnection("The multiplayer connection closed.");
      }
      return false;
    }
    try {
      socket.send(encodeWire(packet));
      return true;
    } catch {
      this.lostConnection("Could not send a message to the multiplayer server.");
      return false;
    }
  }

  private receive(packet: ServerPacket): void {
    switch (packet.type) {
      case "welcome": {
        this.welcome(packet);
        break;
      }
      case "snapshot": {
        if (this.current.recovering) {
          this.installSnapshot(packet);
        }
        break;
      }
      case "accepted": {
        this.accept(packet);
        break;
      }
      case "rejected": {
        const entry = this.queue.find(({ id }) => id === packet.id);
        if (entry) {
          entry.rejection = packet.reason;
        }
        if (entry || this.inFlight === packet.id) {
          this.requestSnapshot();
        }
        break;
      }
      case "presence": {
        if (this.current.status === "connected") {
          this.updatePresence(packet);
        }
        break;
      }
      case "lock-result": {
        this.finishLock(packet.requestId, packet.granted);
        this.releaseFinishedLocks();
        break;
      }
      case "error": {
        if (this.current.status === "connected") {
          this.publish({ error: packet.reason }, { type: "connection" });
        } else {
          this.lostConnection(packet.reason);
        }
        break;
      }
    }
  }

  private updatePresence(packet: Extract<ServerPacket, { type: "presence" }>): void {
    const held = new Set(
      packet.locks
        .filter(({ editorId }) => editorId === this.current.editorId)
        .map(({ scope }) => scopeKey(scope)),
    );
    for (const key of this.ownedLocks) {
      if (!held.has(key)) {
        this.ownedLocks.delete(key);
      }
    }
    this.publish({ editors: packet.editors, locks: packet.locks }, { type: "presence" });
  }

  private welcome(packet: Extract<ServerPacket, { type: "welcome" }>): void {
    const { connection } = this;
    if (!connection || this.current.status === "connected") {
      return;
    }
    const previousSession = connection.session;
    connection.session = packet.session;
    this.attempts = 0;
    if (previousSession !== null && !packet.resumed) {
      // A restarted server can replay edits from a matching baseline. Otherwise it cannot
      // account for changes made to the old session while this editor was disconnected.
      const baselineMatches = this.confirmed !== null && songEquals(this.confirmed, packet.song);
      for (const entry of this.queue) {
        entry.sentAt = null;
        if (!baselineMatches) {
          entry.rejection = "The original multiplayer session is unavailable.";
        }
      }
    }
    this.installSnapshot(packet, {
      status: "connected",
      editorId: packet.editorId,
      editors: packet.editors,
      locks: packet.locks,
    });
    this.sendSelection();
  }

  private sendSelection(): void {
    if (
      this.current.status === "connected" &&
      (this.sentSelection === undefined || !selectionsEqual(this.selection, this.sentSelection)) &&
      this.send({ type: "select", selection: this.selection })
    ) {
      this.sentSelection = this.selection;
    }
  }

  private installSnapshot(
    packet: Extract<ServerPacket, { type: "snapshot" | "welcome" }>,
    update: Partial<MultiplayerState> = {},
  ): void {
    clearTimeout(this.deadline);
    this.confirmed = packet.song;
    this.inFlight = null;
    const received = new Set(packet.receipts.map(({ id }) => id));
    this.queue = this.queue.filter(({ id }) => !received.has(id));
    const projection = this.project(
      packet.song,
      packet.changes,
      update.editorId ?? this.current.editorId,
    );
    this.publish(
      {
        ...projection,
        ...update,
        revision: packet.revision,
        pending: this.pendingIds(),
        recovering: false,
        error: null,
      },
      { type: "snapshot", receipts: packet.receipts, changes: packet.changes },
    );
    this.flush();
  }

  private accept(packet: Extract<ServerPacket, { type: "accepted" }>): void {
    const { revision } = this.current;
    if (this.current.status !== "connected" || this.current.recovering || revision === null) {
      return;
    }
    if (packet.revision <= revision) {
      return;
    }
    const { confirmed } = this;
    if (!confirmed || packet.revision !== revision + 1) {
      this.requestSnapshot();
      return;
    }
    const next = applyAccepted(confirmed, packet);
    if (!next) {
      this.requestSnapshot();
      return;
    }
    this.confirmed = next;
    if (packet.editorId === this.current.editorId) {
      this.queue = this.queue.filter(({ id }) => id !== packet.id);
    }
    if (this.inFlight === packet.id && packet.editorId === this.current.editorId) {
      this.inFlight = null;
      clearTimeout(this.deadline);
    }
    const projection = this.project(next, [packet], this.current.editorId);
    this.publish(
      { ...projection, revision: packet.revision, pending: this.pendingIds(), error: null },
      packet,
    );
    this.flush();
  }

  private project(
    confirmed: Song,
    changes: readonly AcceptedTransaction[],
    editorId: string | null,
  ): Partial<MultiplayerState> {
    const conflicts = [...this.current.conflicts];
    const draft = this.current.song ?? confirmed;
    let song = confirmed;
    const remaining: Pending[] = [];
    for (const entry of this.queue) {
      try {
        if (entry.rejection !== null) {
          throw new Error(entry.rejection);
        }
        if (
          changes.some(
            (change) =>
              change.editorId !== editorId &&
              transactionsConflict(change.transaction, entry.transaction),
          )
        ) {
          throw new Error("Another editor changed data this edit depends on.");
        }
        song = applyTransaction(song, entry.transaction);
        remaining.push(entry);
      } catch (error) {
        conflicts.push({
          id: entry.id,
          transaction: entry.transaction,
          reason: transactionError(error),
          draft,
        });
      }
    }
    this.queue = remaining;
    return { song, ...this.conflictState(conflicts) };
  }

  private flush(): void {
    this.releaseFinishedLocks();
    const [entry] = this.queue;
    const { revision } = this.current;
    if (
      !entry ||
      this.inFlight !== null ||
      this.recoveringLock !== null ||
      this.current.recovering ||
      this.current.status !== "connected" ||
      revision === null
    ) {
      return;
    }
    if (entry.lock && !this.ownedLocks.has(scopeKey(entry.lock))) {
      void this.restoreQueuedLock(entry, entry.lock);
      return;
    }
    // One outstanding submission lets later edits depend on the optimistic result. A resend
    // keeps its original base so the server can detect edits made before the socket recovered.
    const baseRevision = entry.sentAt ?? revision;
    entry.sentAt = baseRevision;
    this.inFlight = entry.id;
    if (
      this.send({
        type: "submit",
        id: entry.id,
        baseRevision,
        transaction: entry.transaction,
        ...(entry.lock ? { lock: entry.lock } : undefined),
      }) &&
      this.socket
    ) {
      this.setDeadline(this.socket);
    }
  }

  private async restoreQueuedLock(entry: Pending, scope: EditorLockScope): Promise<void> {
    this.recoveringLock = entry.id;
    const { socket } = this;
    const granted = await this.acquireLock(scope);
    if (this.socket !== socket || this.recoveringLock !== entry.id) {
      return;
    }
    this.recoveringLock = null;
    if (granted) {
      this.releasingLocks.set(scopeKey(scope), scope);
      this.flush();
    } else if (this.queue.includes(entry)) {
      entry.rejection = "Another editor holds the lock required by this edit.";
      this.requestSnapshot();
    } else {
      this.flush();
    }
  }

  private finishLock(requestId: string, granted: boolean): void {
    const request = this.lockRequests.get(requestId);
    if (request) {
      clearTimeout(request.timer);
      this.lockRequests.delete(requestId);
      if (granted) {
        this.ownedLocks.add(scopeKey(request.scope));
      }
      request.resolve(granted);
    }
  }

  private releaseFinishedLocks(): void {
    if (this.current.status !== "connected") {
      return;
    }
    for (const [key, scope] of this.releasingLocks) {
      if (this.queue.some((entry) => entry.lock !== undefined && scopeKey(entry.lock) === key)) {
        continue;
      }
      const acquiring = [...this.lockRequests].filter(
        ([, request]) => scopeKey(request.scope) === key,
      );
      for (const [requestId] of acquiring) {
        this.finishLock(requestId, false);
      }
      this.releasingLocks.delete(key);
      if (this.ownedLocks.delete(key) || acquiring.length > 0) {
        this.send({ type: "lock", requestId: uid(), scope, acquire: false });
      }
    }
  }
}
