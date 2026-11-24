export type Data = Record<string, unknown>;

export const isRecord = (value: unknown): value is Data =>
  value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

export const safeKey = (key: string): boolean =>
  key !== "__proto__" && key !== "constructor" && key !== "prototype";

const isPredicate = (value: unknown): value is (candidate: unknown) => boolean =>
  typeof value === "function";

export const matchesShape = (value: unknown, shape: unknown): boolean => {
  if (isPredicate(shape)) {
    return shape(value);
  }
  if (Array.isArray(shape)) {
    return (
      Array.isArray(value) &&
      (shape.length === 0 || value.every((item: unknown) => matchesShape(item, shape[0])))
    );
  }
  if (isRecord(shape)) {
    return (
      isRecord(value) &&
      Object.keys(value).every((key) => safeKey(key) && Object.hasOwn(shape, key)) &&
      Object.entries(shape).every(([key, child]) =>
        matchesShape(Object.hasOwn(value, key) ? value[key] : undefined, child),
      )
    );
  }
  return typeof value === typeof shape && (typeof value !== "number" || Number.isFinite(value));
};

export const optional =
  (shape: unknown) =>
  (value: unknown): boolean =>
    value === undefined || matchesShape(value, shape);

export const dictionary =
  (shape: unknown, validKey = safeKey) =>
  (value: unknown): boolean =>
    isRecord(value) &&
    Object.entries(value).every(([key, child]) => validKey(key) && matchesShape(child, shape));
