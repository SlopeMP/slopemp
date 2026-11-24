import type { Effect, FilterPoint, ParameterDefinition } from "./instruments";

export const filterParameter = (index: number, field: "frequency" | "gain"): string => {
  if (index === 0) {
    return field;
  }
  const suffix = { frequency: "Frequency", gain: "Gain" }[field];
  return `band${index}${suffix}`;
};

export const effectFilterPoints = (effect: Effect): FilterPoint[] => {
  const p = effect.parameters;
  const numeric = (key: string, fallback: number): number =>
    typeof p[key] === "number" ? p[key] : fallback;
  return Array.from(
    { length: Math.max(0, Math.min(8, Math.round(numeric("bandCount", 1)))) },
    (_, index) => ({
      id: String(p[`band${index}Id`] ?? `${effect.id}-band${index}`),
      type: String(p[index === 0 ? "filterType" : `band${index}Type`] ?? "peaking"),
      frequency: numeric(filterParameter(index, "frequency"), 1200),
      gain: numeric(filterParameter(index, "gain"), 0),
    }),
  );
};

export const setEffectFilterPoints = (effect: Effect, points: FilterPoint[]): void => {
  const p = Object.fromEntries(
    Object.entries(effect.parameters).filter(
      ([key]) =>
        !/^band\d+(?:Id|Type|Frequency|Gain)$/u.test(key) &&
        !["frequency", "gain", "filterType"].includes(key),
    ),
  );
  effect.parameters = p;
  p["bandCount"] = points.length;
  points.forEach((point, index) => {
    p[`band${index}Id`] = point.id;
    p[index === 0 ? "filterType" : `band${index}Type`] = point.type;
    p[filterParameter(index, "frequency")] = point.frequency;
    p[filterParameter(index, "gain")] = point.gain;
  });
};

export const filterParameters = (effect: Effect): ParameterDefinition[] =>
  effectFilterPoints(effect).flatMap((_point, index) => [
    {
      key: filterParameter(index, "frequency"),
      label: `Point ${index + 1} frequency`,
      min: 20,
      max: 20_000,
      value: 1200,
      unit: "Hz",
      step: 1,
    },
  ]);

// Band indices are serialized parameter names; keep bindings attached to point identities.
export const remapFilterParameter = (
  previous: Effect,
  next: Effect,
  parameter: string,
): string | undefined => {
  if (previous.type !== "EQ" || next.type !== "EQ") {
    return parameter;
  }
  const before = effectFilterPoints(previous);
  const after = effectFilterPoints(next);
  for (const [index, point] of before.entries()) {
    for (const field of ["frequency", "gain"] as const) {
      if (filterParameter(index, field) === parameter) {
        const destination = after.findIndex((item) => item.id === point.id);
        return destination === -1 ? undefined : filterParameter(destination, field);
      }
    }
  }
  return parameter;
};
