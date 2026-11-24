import {
  applyTransaction,
  clone,
  createSong,
  createTransaction,
  invertTransaction,
  transactionsConflict,
  validateSong,
} from "@slopemp/song";
import type { EditPath, Song, Transaction } from "@slopemp/song";
import type { EditorLockScope } from "@slopemp/song/protocol";

import type { SongRecipe } from "./model";

// Installed snapshots are immutable, so unchanged branches can be reused across edits.
// This also keeps audio resource/envelope identities stable while notes are edited.
const snapshots = new WeakSet<object>();
export const isSnapshot = (value: object): boolean => snapshots.has(value);
const shareSnapshot = <T>(value: T, previous: T): T => {
  if (Object.is(value, previous)) {
    return previous;
  }
  if (
    value === null ||
    previous === null ||
    typeof value !== "object" ||
    typeof previous !== "object" ||
    Array.isArray(value) !== Array.isArray(previous)
  ) {
    return value;
  }
  const fields: Array<[string, unknown]> = Object.entries(value);
  const old = new Map<string, unknown>(Object.entries(previous));
  let equal =
    fields.length === old.size &&
    (!Array.isArray(value) || (Array.isArray(previous) && value.length === previous.length));
  for (const [key, child] of fields) {
    const shared = shareSnapshot(child, old.get(key));
    if (!old.has(key) || !Object.is(shared, old.get(key))) {
      equal = false;
    }
    if (!Object.is(shared, child)) {
      Object.defineProperty(value, key, {
        value: shared,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return equal ? previous : value;
};
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    snapshots.add(value);
    for (const child of Object.values(value)) {
      freeze(child);
    }
  }
  return value;
};
type Entry = {
  transaction: Transaction;
  order: number;
  before: (() => void) | null;
  after: (() => void) | null;
  conflicted: boolean;
  snapshots?: { before: Song; after: Song };
};

export type HistoryCollaboration = {
  editable: () => boolean;
  submit: (transaction: Transaction, lock?: EditorLockScope) => string | null;
  onError: (message: string) => void;
};

export class History {
  private current: Song;
  private readonly past: Entry[] = [];
  private future: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private provisional: { transaction: Transaction; song: Song } | null = null;
  private interruptedPreview = false;
  private captureContext: (() => () => void) | null = null;
  private awaitingContext: Entry | null = null;
  private collaboration: HistoryCollaboration | null = null;
  private readonly pending = new Map<string, () => void>();
  private reversal: string | null = null;
  private order = 0;

  public constructor(song = createSong()) {
    validateSong(song);
    this.current = freeze(clone(song));
  }

  public get song(): Song {
    return this.provisional?.song ?? this.current;
  }
  public get committedSong(): Song {
    return this.current;
  }
  public get canUndo(): boolean {
    return this.reversal === null && this.past.length > 0;
  }
  public get canRedo(): boolean {
    return this.reversal === null && this.future.length > 0;
  }
  public get isPreview(): boolean {
    return this.provisional !== null;
  }
  protected get collaborative(): boolean {
    return this.collaboration !== null;
  }
  private get editable(): boolean {
    return this.collaboration?.editable() ?? true;
  }

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  public setContextHandlers<T>(capture: () => T, restore: (context: T) => void): void {
    this.captureContext = () => {
      const value = clone(capture());
      return (): void => {
        restore(clone(value));
      };
    };
  }
  public updateContext(): void {
    if (!this.provisional && this.awaitingContext) {
      this.awaitingContext.after = this.captureContext?.() ?? null;
      this.awaitingContext = null;
    }
  }

  public beginCollaboration(song: Song, collaboration: HistoryCollaboration): void {
    this.collaboration = collaboration;
    this.restore(song);
  }

  public endCollaboration(song: Song): void {
    this.collaboration = null;
    this.restore(song);
  }

  public reconcile(song: Song, remote: readonly Transaction[] = []): void {
    if (remote.length > 0) {
      for (const entry of [...this.past, ...this.future]) {
        if (remote.some((transaction) => transactionsConflict(entry.transaction, transaction))) {
          entry.conflicted = true;
        }
      }
    }
    this.current = this.install(song);
    const preview = this.provisional;
    if (preview) {
      try {
        if (remote.some((transaction) => transactionsConflict(preview.transaction, transaction))) {
          throw new Error("The preview dependencies changed.");
        }
        preview.song = this.install(
          applyTransaction(this.current, preview.transaction),
          preview.song,
        );
      } catch {
        this.suspendPreview();
        this.collaboration?.onError(
          "A server edit interrupted the current preview. Start the gesture again.",
        );
      }
    }
    this.notify();
  }

  public settle(id: string, accepted: boolean): void {
    const rollback = this.pending.get(id);
    this.pending.delete(id);
    if (this.reversal === id) {
      this.reversal = null;
    }
    if (!accepted) {
      rollback?.();
    }
  }

  public execute(recipe: SongRecipe, reads: EditPath[] = []): boolean {
    if (!this.editable) {
      return false;
    }
    if (this.interruptedPreview) {
      this.clearPreviewInterruption();
      return false;
    }
    this.cancelPreview();
    const candidate = clone(this.current);
    recipe(candidate);
    return this.commit(createTransaction(this.current, candidate, reads));
  }

  public replace(song: Song): boolean {
    this.cancelPreview();
    return this.commit(createTransaction(this.current, song));
  }

  public commit(transaction: Transaction, lock?: EditorLockScope): boolean {
    if (!this.editable || transaction.changes.length === 0) {
      return false;
    }
    const context = this.captureContext?.() ?? null;
    const entry: Entry = {
      transaction,
      order: this.order++,
      before: context,
      after: context,
      conflicted: false,
    };
    const before = this.current;
    const oldFuture = this.future;
    const nextFuture: Entry[] = [];
    if (
      this.apply(
        transaction,
        () => {
          this.removeEntry(this.past, entry);
          this.removeEntry(this.future, entry);
          if (this.future === nextFuture) {
            this.future = oldFuture;
          }
        },
        lock,
      ) === false
    ) {
      return false;
    }
    if (!this.collaboration) {
      entry.snapshots = { before, after: this.current };
    }
    this.awaitingContext = entry;
    this.past.push(entry);
    if (this.past.length > 100) {
      this.past.shift();
    }
    this.future = nextFuture;
    this.onCommit();
    this.notify();
    return true;
  }

  public undo(): boolean {
    return this.reverse(false);
  }

  public redo(): boolean {
    return this.reverse(true);
  }

  public preview(recipe: SongRecipe, reads: EditPath[] = []): boolean {
    if (!this.editable || this.interruptedPreview) {
      return false;
    }
    const candidate = clone(this.current);
    recipe(candidate);
    validateSong(candidate);
    const transaction = createTransaction(this.current, candidate, reads);
    this.provisional = { transaction, song: this.install(candidate) };
    this.notify();
    return transaction.changes.length > 0;
  }

  public commitPreview(): boolean {
    const preview = this.provisional;
    if (!preview) {
      this.interruptedPreview = false;
      return false;
    }
    this.provisional = null;
    try {
      if (this.commit(preview.transaction)) {
        return true;
      }
    } catch (error) {
      this.notify();
      throw error;
    }
    this.notify();
    return false;
  }

  public suspendPreview(): void {
    if (this.provisional) {
      this.cancelPreview();
      this.interruptedPreview = true;
    }
  }

  public clearPreviewInterruption(): void {
    this.interruptedPreview = false;
  }

  public cancelPreview(): void {
    this.clearPreviewInterruption();
    if (this.provisional) {
      this.provisional = null;
      this.notify();
    }
  }

  protected restore(song: Song): void {
    validateSong(song);
    this.current = this.install(song);
    this.past.length = 0;
    this.future = [];
    this.pending.clear();
    this.reversal = null;
    this.provisional = null;
    this.interruptedPreview = false;
    this.awaitingContext = null;
    this.notify();
  }

  protected onCommit(): void {
    // The browser editor stores committed edits in its navigation history.
  }

  private reverse(redo: boolean): boolean {
    this.cancelPreview();
    if (!this.editable || this.reversal !== null) {
      return false;
    }
    const from = redo ? this.future : this.past;
    const to = redo ? this.past : this.future;
    const entry = from.at(-1);
    if (!entry) {
      return false;
    }
    const action = redo ? "Redo" : "Undo";
    try {
      if (entry.conflicted) {
        throw new Error("Another editor changed data required by this edit.");
      }
      const transaction = redo ? entry.transaction : invertTransaction(entry.transaction);
      const rollback = (): void => {
        this.removeEntry(to, entry);
        from.push(entry);
        if (!redo) {
          from.sort((left, right) => left.order - right.order);
        }
      };
      const result = this.apply(
        transaction,
        rollback,
        undefined,
        redo ? entry.snapshots?.after : entry.snapshots?.before,
      );
      if (result === false) {
        return false;
      }
      this.reversal = typeof result === "string" ? result : null;
    } catch (error) {
      if (!this.collaboration) {
        throw error;
      }
      this.collaboration.onError(`${action} conflicts with the current song. ${String(error)}`);
      from.pop();
      this.notify();
      return false;
    }
    from.pop();
    to.push(entry);
    this.awaitingContext = null;
    (redo ? entry.after : entry.before)?.();
    this.notify();
    return true;
  }

  private removeEntry(entries: Entry[], entry: Entry): void {
    const index = entries.indexOf(entry);
    if (index !== -1) {
      entries.splice(index, 1);
    }
  }

  private apply(
    transaction: Transaction,
    rollback: () => void,
    lock?: EditorLockScope,
    previous?: Song,
  ): string | false | true {
    const song = applyTransaction(this.current, transaction);
    const submission = this.collaboration?.submit(transaction, lock);
    if (submission === null) {
      return false;
    }
    if (submission !== undefined) {
      this.pending.set(submission, rollback);
    }
    this.current = this.install(song, previous);
    return submission ?? true;
  }

  private install(song: Song, previous = this.current): Song {
    return freeze(shareSnapshot(clone(song), previous));
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
