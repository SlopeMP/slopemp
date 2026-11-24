import { clone, required, validateSong } from "./model";
import type { Song } from "./model";
import { isRecord, safeKey } from "./shape";
import type { Data } from "./shape";

export type Entity = { id: string };
export type EditKey = Entity | number | string;
export type EditPath = EditKey[];
export type ValueEdit = {
  kind: "value";
  path: EditPath;
  before?: unknown;
  after?: unknown;
  nextId?: string;
  chronological?: true;
};
export type OrderEdit = { kind: "order"; path: EditPath; before: string[]; after: string[] };
export type Edit = OrderEdit | ValueEdit;
export type Transaction = { songId: string; changes: Edit[]; reads: EditPath[] };

const isEntity = (value: unknown): value is Data & Entity =>
  isRecord(value) && typeof value["id"] === "string" && value["id"].length > 0;

const entries = (record: Data): Array<[string, unknown]> =>
  Object.entries(record).filter(([, value]) => value !== undefined);

const get = (record: Data, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

export const songEquals = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, i) => songEquals(value, right[i]));
  }
  if (isRecord(left) && isRecord(right)) {
    const fields = entries(left);
    return (
      fields.length === entries(right).length &&
      fields.every(([key, value]) => songEquals(value, get(right, key)))
    );
  }
  return false;
};

const isEntityArray = (value: unknown[]): value is Array<Data & Entity> =>
  value.every(isEntity) && new Set(value.map((item) => item.id)).size === value.length;

const noteStart = (note: Data): number =>
  typeof note["start"] === "number" ? note["start"] : Number.NaN;

const chronologicalNotes = (path: EditPath, notes: Data[]): boolean => {
  if (path.at(-1) !== "notes") {
    return false;
  }
  let previous = -Infinity;
  for (const note of notes) {
    const start = noteStart(note);
    if (!Number.isFinite(start) || start <= previous) {
      return false;
    }
    previous = start;
  }
  return true;
};

const valueEdit = (
  path: EditPath,
  before: unknown,
  after: unknown,
  position?: Pick<ValueEdit, "chronological" | "nextId">,
): ValueEdit => ({
  kind: "value",
  path,
  ...(before === undefined ? undefined : { before: clone(before) }),
  ...(after === undefined ? undefined : { after: clone(after) }),
  ...position,
});

const positionAt = (
  chronological: boolean,
  entities: Entity[],
  index: number,
): Pick<ValueEdit, "chronological" | "nextId"> => {
  const next = entities[index + 1];
  if (chronological) {
    return { chronological: true };
  }
  return next ? { nextId: next.id } : {};
};

const diff = (changes: Edit[], path: EditPath, before: unknown, after: unknown): void => {
  if (songEquals(before, after)) {
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (isEntityArray(before) && isEntityArray(after)) {
      const oldEntities = new Map(before.map((item) => [item.id, item]));
      const newEntities = new Map(after.map((item) => [item.id, item]));
      const oldChronological = chronologicalNotes(path, before);
      const newChronological = chronologicalNotes(path, after);
      const keepsChronological = oldChronological && newChronological;
      before.forEach((item, i) => {
        const next = newEntities.get(item.id);
        if (next) {
          const initialChanges = changes.length;
          diff(changes, [...path, { id: item.id }], item, next);
          if (keepsChronological) {
            for (const change of changes.slice(initialChanges)) {
              if (change.kind === "value" && change.path.at(-1) === "start") {
                change.chronological = true;
              }
            }
          }
        } else {
          changes.push(
            valueEdit(
              [...path, { id: item.id }],
              item,
              undefined,
              positionAt(oldChronological, before, i),
            ),
          );
        }
      });
      const oldOrder = before.filter((item) => newEntities.has(item.id)).map((item) => item.id);
      const newOrder = after.filter((item) => oldEntities.has(item.id)).map((item) => item.id);
      if (!keepsChronological && !songEquals(oldOrder, newOrder)) {
        changes.push({ kind: "order", path, before: oldOrder, after: newOrder });
      }
      for (let i = after.length - 1; i >= 0; i--) {
        const item = required(after[i]);
        if (!oldEntities.has(item.id)) {
          changes.push(
            valueEdit(
              [...path, { id: item.id }],
              undefined,
              item,
              positionAt(newChronological, after, i),
            ),
          );
        }
      }
      return;
    }
    if ((path.at(-1) === "cells" || path.at(-1) === "drums") && before.length === after.length) {
      before.forEach((value, i) => {
        diff(changes, [...path, i], value, after[i]);
      });
      return;
    }
  }
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diff(changes, [...path, key], get(before, key), get(after, key));
    }
    return;
  }
  changes.push(valueEdit(path, before, after));
};

export const createTransaction = (
  before: Song,
  after: Song,
  reads: EditPath[] = [],
): Transaction => {
  const changes: Edit[] = [];
  diff(changes, [], before, after);
  return { songId: before.id, changes, reads: clone(reads) };
};

const hasOnly = (data: Data, keys: string[]): boolean =>
  Object.keys(data).every((key) => keys.includes(key));

const isKey = (key: unknown): key is EditKey => {
  if (typeof key === "string") {
    return safeKey(key);
  }
  if (typeof key === "number") {
    return Number.isSafeInteger(key) && key >= 0;
  }
  return isEntity(key) && hasOnly(key, ["id"]);
};

const isPath = (path: unknown): path is EditPath =>
  Array.isArray(path) && typeof path[0] === "string" && path.every(isKey);

const isOrder = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((id) => typeof id === "string" && id.length > 0) &&
  new Set(value).size === value.length;

const chronologicalEdit = (path: EditPath, before: unknown, after: unknown): boolean =>
  (path.at(-2) === "notes" &&
    isEntity(path.at(-1)) &&
    (before === undefined || after === undefined)) ||
  (path.at(-3) === "notes" &&
    isEntity(path.at(-2)) &&
    path.at(-1) === "start" &&
    Number.isFinite(before) &&
    Number.isFinite(after));

const isEdit = (edit: unknown): edit is Edit => {
  if (!isRecord(edit) || !isPath(edit["path"])) {
    return false;
  }
  const { kind, path, before, after, nextId, chronological } = edit;
  if (kind === "order") {
    return (
      hasOnly(edit, ["kind", "path", "before", "after"]) &&
      isOrder(before) &&
      isOrder(after) &&
      before.length === after.length &&
      before.every((id) => after.includes(id)) &&
      !songEquals(before, after)
    );
  }
  return (
    kind === "value" &&
    hasOnly(edit, ["kind", "path", "before", "after", "nextId", "chronological"]) &&
    (chronological === undefined ||
      (chronological === true && nextId === undefined && chronologicalEdit(path, before, after))) &&
    (nextId === undefined ||
      (typeof nextId === "string" &&
        nextId.length > 0 &&
        isEntity(path.at(-1)) &&
        (before === undefined || after === undefined))) &&
    !songEquals(before, after)
  );
};

const isTransaction = (transaction: unknown): transaction is Transaction =>
  isRecord(transaction) &&
  hasOnly(transaction, ["songId", "changes", "reads"]) &&
  typeof transaction["songId"] === "string" &&
  Array.isArray(transaction["changes"]) &&
  transaction["changes"].every(isEdit) &&
  Array.isArray(transaction["reads"]) &&
  transaction["reads"].every(isPath);

const arrayIndex = (array: unknown[], key: Entity | number): number =>
  typeof key === "number" ? key : array.findIndex((item) => isEntity(item) && item.id === key.id);

const read = (parent: unknown, key: EditKey): unknown => {
  if (isRecord(parent) && typeof key === "string") {
    return get(parent, key);
  }
  if (Array.isArray(parent) && typeof key !== "string") {
    return parent[arrayIndex(parent, key)];
  }
  throw new Error("Invalid path in song transaction.");
};

const resolve = (song: Song, path: EditPath): unknown =>
  path.reduce<unknown>((parent, key) => read(parent, key), song);

const setEntity = (parent: unknown[], key: Entity, edit: ValueEdit): void => {
  const index = arrayIndex(parent, key);
  if (edit.after === undefined) {
    parent.splice(index, 1);
    return;
  }
  if (!isEntity(edit.after) || edit.after.id !== key.id) {
    throw new Error("A song edit cannot change an entity's identity.");
  }
  if (index >= 0) {
    parent[index] = clone(edit.after);
    return;
  }
  const start = noteStart(edit.after);
  if (edit.chronological && Number.isFinite(start)) {
    const next = parent.findIndex((item) => isEntity(item) && noteStart(item) > start);
    parent.splice(next === -1 ? parent.length : next, 0, clone(edit.after));
    return;
  }
  const next = edit.nextId === undefined ? parent.length : arrayIndex(parent, { id: edit.nextId });
  if (next < 0) {
    throw new Error("An entity used to position this edit no longer exists.");
  }
  parent.splice(next, 0, clone(edit.after));
};

const setValue = (song: Song, edit: ValueEdit): void => {
  const key = required(edit.path.at(-1));
  const parent = resolve(song, edit.path.slice(0, -1));
  if (!songEquals(read(parent, key), edit.before)) {
    throw new Error("The song data changed before this edit could be applied.");
  }
  if (isRecord(parent) && typeof key === "string") {
    if (key === "id" && isEntity(edit.path.at(-2))) {
      throw new Error("A song edit cannot change an entity's identity.");
    }
    if (edit.after === undefined) {
      Reflect.deleteProperty(parent, key);
    } else {
      parent[key] = clone(edit.after);
    }
    return;
  }
  if (Array.isArray(parent) && typeof key !== "string") {
    if (typeof key === "number") {
      if (key >= parent.length || edit.after === undefined || isEntity(parent[key])) {
        throw new Error("Array membership must be edited by entity identity.");
      }
      parent[key] = clone(edit.after);
    } else {
      setEntity(parent, key, edit);
    }
    return;
  }
  throw new Error("Invalid path in song transaction.");
};

const orderEntities = (song: Song, edit: OrderEdit): void => {
  const entities = resolve(song, edit.path);
  if (
    !Array.isArray(entities) ||
    !isEntityArray(entities) ||
    !songEquals(
      entities.map(({ id }) => id),
      edit.before,
    )
  ) {
    throw new Error("The entity order changed before this edit could be applied.");
  }
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  entities.splice(0, entities.length, ...edit.after.map((id) => required(byId.get(id))));
};

const chronologicalLists = (song: Song, changes: Edit[]): void => {
  const lists = new Set<Data[]>();
  for (const edit of changes) {
    if (edit.kind === "value" && edit.chronological && edit.path.at(-1) === "start") {
      const notes = resolve(song, edit.path.slice(0, -2));
      if (Array.isArray(notes) && isEntityArray(notes)) {
        lists.add(notes);
      }
    }
  }
  for (const notes of lists) {
    notes.sort((left, right) => noteStart(left) - noteStart(right));
  }
};

export const applyTransaction = (song: Song, transaction: Transaction): Song => {
  if (!isTransaction(transaction)) {
    throw new Error("Invalid song transaction.");
  }
  if (song.id !== transaction.songId) {
    throw new Error("This transaction belongs to a different song.");
  }
  if (transaction.changes.length === 0) {
    return song;
  }
  const candidate = clone(song);
  for (const edit of transaction.changes) {
    if (edit.kind === "order") {
      orderEntities(candidate, edit);
    } else {
      setValue(candidate, edit);
    }
  }
  chronologicalLists(candidate, transaction.changes);
  validateSong(candidate);
  return candidate;
};

export const invertTransaction = (transaction: Transaction): Transaction => {
  const nextId = transaction.changes.findLast(
    (edit) => edit.kind === "value" && edit.path.length === 1 && edit.path[0] === "id",
  )?.after;
  return {
    songId: typeof nextId === "string" ? nextId : transaction.songId,
    changes: transaction.changes.toReversed().map((edit) =>
      edit.kind === "order"
        ? { ...edit, before: edit.after, after: edit.before }
        : valueEdit(edit.path, edit.after, edit.before, {
            ...(edit.nextId === undefined ? undefined : { nextId: edit.nextId }),
            ...(edit.chronological === undefined
              ? undefined
              : { chronological: edit.chronological }),
          }),
    ),
    reads: clone(transaction.reads),
  };
};

const sameKey = (left: EditKey, right: EditKey | undefined): boolean =>
  typeof left === "object" ? typeof right === "object" && left.id === right.id : left === right;

const startsWith = (path: EditPath, prefix: EditPath): boolean =>
  prefix.length <= path.length && prefix.every((key, index) => sameKey(key, path[index]));

const nestingOverlap = (left: EditPath, right: EditPath): boolean =>
  startsWith(left, right) || startsWith(right, left);

const isMembership = (edit: Edit): boolean =>
  edit.kind === "value" && (edit.before === undefined || edit.after === undefined);

const sameLengthPath = (left: EditPath, right: EditPath): boolean =>
  left.length === right.length && startsWith(left, right);

const orderConflict = (order: OrderEdit, other: Edit): boolean =>
  startsWith(order.path, other.path) ||
  (startsWith(other.path, order.path) &&
    ((other.path.length === order.path.length + 1 && isMembership(other)) ||
      (other.kind === "value" && other.chronological === true)));

const geometryConflict = (edit: Edit, other: Edit): boolean => {
  const [key] = edit.path;
  if (edit.path.length !== 1) {
    return false;
  }
  if (key === "id") {
    return true;
  }
  const [otherKey, , field] = other.path;
  const channelStructure =
    other.kind === "value" &&
    otherKey === "channels" &&
    (other.path.length === 1 || (other.path.length === 2 && isMembership(other)));
  if (key === "barCount") {
    return (
      channelStructure || field === "cells" || otherKey === "loopStart" || otherKey === "loopEnd"
    );
  }
  if (key === "patternCount") {
    return channelStructure || field === "cells" || field === "patterns";
  }
  return key === "beatsPerBar" && (channelStructure || field === "patterns");
};

const referencesPattern = (edit: Edit, other: Edit): boolean => {
  if (
    edit.kind !== "value" ||
    edit.path[0] !== "channels" ||
    edit.path[2] !== "cells" ||
    other.path[2] !== "patterns" ||
    other.path.length > 4 ||
    !startsWith(other.path, edit.path.slice(0, 2))
  ) {
    return false;
  }
  if (other.path.length === 3) {
    return true;
  }
  const number = Number(other.path[3]);
  return (
    isMembership(other) &&
    [edit.before, edit.after].some((cells) =>
      Array.isArray(cells) ? cells.includes(number) : cells === number,
    )
  );
};

const removesAnchor = (edit: ValueEdit, other: Edit): boolean =>
  edit.nextId !== undefined &&
  isMembership(other) &&
  sameLengthPath(other.path, [...edit.path.slice(0, -1), { id: edit.nextId }]);

const writesConflict = (left: Edit, right: Edit): boolean =>
  geometryConflict(left, right) ||
  geometryConflict(right, left) ||
  referencesPattern(left, right) ||
  referencesPattern(right, left) ||
  (left.kind === "order" && orderConflict(left, right)) ||
  (right.kind === "order" && orderConflict(right, left)) ||
  (left.kind === "value" &&
    right.kind === "value" &&
    (nestingOverlap(left.path, right.path) ||
      removesAnchor(left, right) ||
      removesAnchor(right, left)));

const readsConflict = (edit: Edit, readPath: EditPath): boolean =>
  edit.kind === "value" ? nestingOverlap(edit.path, readPath) : startsWith(edit.path, readPath);

// A cell assignment made together with edits to its destination can allocate a slot.
// Concurrent assignments must not make two independently composed bars share that slot.
const assignedSlots = (changes: Edit[]): Set<string> => {
  const slots = new Set<string>();
  for (const edit of changes) {
    const [collection, channel, field] = edit.path;
    if (
      edit.kind !== "value" ||
      collection !== "channels" ||
      !isEntity(channel) ||
      field !== "cells"
    ) {
      continue;
    }
    const before = Array.isArray(edit.before) ? edit.before : [edit.before];
    const after = Array.isArray(edit.after) ? edit.after : [edit.after];
    after.forEach((slot: unknown, index) => {
      if (typeof slot === "number" && slot > 0 && slot !== before[index]) {
        slots.add(JSON.stringify([channel.id, String(slot)]));
      }
    });
  }
  return slots;
};

const competingPatternAssignments = (left: Edit[], right: Edit[]): boolean => {
  const leftSlots = assignedSlots(left);
  const rightSlots = assignedSlots(right);
  if (leftSlots.size === 0 || rightSlots.size === 0) {
    return false;
  }
  return [...left, ...right].some(({ path: [collection, channel, field, number] }) => {
    if (
      collection !== "channels" ||
      !isEntity(channel) ||
      field !== "patterns" ||
      typeof number !== "string"
    ) {
      return false;
    }
    const key = JSON.stringify([channel.id, number]);
    return leftSlots.has(key) && rightSlots.has(key);
  });
};

export const transactionsConflict = (left: Transaction, right: Transaction): boolean =>
  left.songId !== right.songId ||
  left.changes.some(
    (edit) =>
      right.changes.some((other) => writesConflict(edit, other)) ||
      right.reads.some((path) => readsConflict(edit, path)),
  ) ||
  right.changes.some((edit) => left.reads.some((path) => readsConflict(edit, path))) ||
  competingPatternAssignments(left.changes, right.changes);
