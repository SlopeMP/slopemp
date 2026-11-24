import { decodeWire } from "./index";
import type { Song, Transaction } from "./index";

export type EditorSelection = { channelId: string; bar: number; pattern?: number };
export type EditorLockScope = { channelId: string; editor?: string };
export type EditorLock = { scope: EditorLockScope; editorId: string };
export type EditorPresence = { id: string; color: string; selection: EditorSelection | null };

export const editorLockConflicts = (left: EditorLockScope, right: EditorLockScope): boolean =>
  left.channelId === right.channelId &&
  (left.editor === undefined || right.editor === undefined || left.editor === right.editor);

export type ClientPacket =
  | {
      type: "submit";
      id: string;
      baseRevision: number;
      transaction: Transaction;
      lock?: EditorLockScope;
    }
  | { type: "hello"; password: string; session?: string; revision?: number; pending?: string[] }
  | { type: "lock"; requestId: string; scope: EditorLockScope; acquire: boolean }
  | { type: "select"; selection: EditorSelection | null }
  | { type: "sync"; revision: number; pending: string[] };

export type AcceptedTransaction = {
  id: string;
  editorId: string;
  revision: number;
  transaction: Transaction;
  checksum: string;
};

type SongSnapshot = {
  revision: number;
  song: Song;
  receipts: AcceptedTransaction[];
  changes: AcceptedTransaction[];
};

type RoomPresence = { editors: EditorPresence[]; locks: EditorLock[] };
type WelcomePacket = RoomPresence &
  SongSnapshot & {
    type: "welcome";
    session: string;
    editorId: string;
    resumed: boolean;
  };

export type ServerPacket =
  | WelcomePacket
  | { type: "error"; reason: string }
  | { type: "lock-result"; requestId: string; granted: boolean }
  | { type: "rejected"; id: string; reason: string }
  | (AcceptedTransaction & { type: "accepted" })
  | (RoomPresence & { type: "presence" })
  | (SongSnapshot & { type: "snapshot" });

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

const index = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const optional = <T>(value: unknown, predicate: (entry: unknown) => entry is T): boolean =>
  value === undefined || predicate(value);

const array = <T>(value: unknown, predicate: (entry: unknown) => entry is T): value is T[] =>
  Array.isArray(value) && value.every(predicate);

const selection = (value: unknown): value is EditorSelection | null =>
  value === null ||
  (object(value) &&
    identity(value["channelId"]) &&
    index(value["bar"]) &&
    optional(value["pattern"], index));

const scope = (value: unknown): value is EditorLockScope =>
  object(value) && identity(value["channelId"]) && optional(value["editor"], identity);

// The transaction engine validates edit paths and values against the song when applying a packet.
const transaction = (value: unknown): value is Transaction =>
  object(value) &&
  identity(value["songId"]) &&
  Array.isArray(value["changes"]) &&
  Array.isArray(value["reads"]);

const isClientPacket = (value: unknown): value is ClientPacket => {
  if (!object(value)) {
    return false;
  }
  switch (value["type"]) {
    case "hello": {
      return (
        typeof value["password"] === "string" &&
        optional(value["session"], identity) &&
        optional(value["revision"], index) &&
        (value["pending"] === undefined || array(value["pending"], identity))
      );
    }
    case "submit": {
      return (
        identity(value["id"]) &&
        index(value["baseRevision"]) &&
        transaction(value["transaction"]) &&
        optional(value["lock"], scope)
      );
    }
    case "sync": {
      return index(value["revision"]) && array(value["pending"], identity);
    }
    case "select": {
      return selection(value["selection"]);
    }
    case "lock": {
      return (
        identity(value["requestId"]) &&
        scope(value["scope"]) &&
        typeof value["acquire"] === "boolean"
      );
    }
    default: {
      return false;
    }
  }
};

const accepted = (value: unknown): value is AcceptedTransaction =>
  object(value) &&
  identity(value["id"]) &&
  identity(value["editorId"]) &&
  index(value["revision"]) &&
  transaction(value["transaction"]) &&
  identity(value["checksum"]);

const editor = (value: unknown): value is EditorPresence =>
  object(value) &&
  identity(value["id"]) &&
  typeof value["color"] === "string" &&
  selection(value["selection"]);

const lock = (value: unknown): value is EditorLock =>
  object(value) && scope(value["scope"]) && identity(value["editorId"]);

const snapshot = (value: Record<string, unknown>): boolean =>
  index(value["revision"]) &&
  object(value["song"]) &&
  array(value["receipts"], accepted) &&
  array(value["changes"], accepted);

const presence = (value: Record<string, unknown>): boolean =>
  array(value["editors"], editor) && array(value["locks"], lock);

const isServerPacket = (value: unknown): value is ServerPacket => {
  if (!object(value)) {
    return false;
  }
  switch (value["type"]) {
    case "welcome": {
      return (
        identity(value["session"]) &&
        identity(value["editorId"]) &&
        typeof value["resumed"] === "boolean" &&
        snapshot(value) &&
        presence(value)
      );
    }
    case "snapshot": {
      return snapshot(value);
    }
    case "accepted": {
      return accepted(value);
    }
    case "rejected": {
      return identity(value["id"]) && typeof value["reason"] === "string";
    }
    case "presence": {
      return presence(value);
    }
    case "lock-result": {
      return identity(value["requestId"]) && typeof value["granted"] === "boolean";
    }
    case "error": {
      return typeof value["reason"] === "string";
    }
    default: {
      return false;
    }
  }
};

export const decodeClientPacket = (message: string): ClientPacket => {
  const value = decodeWire(message);
  if (!isClientPacket(value)) {
    throw new Error("Invalid client packet.");
  }
  return value;
};

export const decodeServerPacket = (message: string): ServerPacket => {
  const value = decodeWire(message);
  if (!isServerPacket(value)) {
    throw new Error("Invalid server packet.");
  }
  return value;
};
