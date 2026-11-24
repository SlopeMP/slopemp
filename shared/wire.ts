// Reserve a key for infinite envelope bounds and speeds. Escape user keys in the same namespace.
const numberTag = "$number";

export const encodeWire = (value: unknown, sorted = false): string => {
  const encode = (item: unknown): unknown => {
    if (typeof item === "number" && !Number.isFinite(item)) {
      if (Number.isNaN(item)) {
        throw new TypeError("A song packet cannot contain NaN.");
      }
      return { [numberTag]: item > 0 ? "+" : "-" };
    }
    if (Array.isArray(item)) {
      return item.map(encode);
    }
    if (item !== null && typeof item === "object") {
      const keys = Object.keys(item);
      if (sorted) {
        keys.sort();
      }
      return Object.fromEntries(
        keys.flatMap((key) => {
          const child: unknown = Reflect.get(item, key);
          return child === undefined
            ? []
            : [[key.startsWith("$") ? `$${key}` : key, encode(child)]];
        }),
      );
    }
    return item;
  };
  return JSON.stringify(encode(value));
};

export const decodeWire = (value: string): unknown =>
  JSON.parse(value, (_key: string, item: unknown): unknown => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return item;
    }
    if (Object.hasOwn(item, numberTag)) {
      const sign: unknown = Reflect.get(item, numberTag);
      if (Object.keys(item).length !== 1 || (sign !== "+" && sign !== "-")) {
        throw new Error("Invalid number in song packet.");
      }
      return sign === "+" ? Infinity : -Infinity;
    }
    return Object.fromEntries(
      Object.entries(item).map(([key, child]) => [
        key.startsWith("$$") ? key.slice(1) : key,
        child,
      ]),
    );
  });
