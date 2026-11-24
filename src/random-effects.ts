import { setEffectFilterPoints } from "./filters";
import { createEffect, EFFECT_PARAMETERS, instrumentId } from "./instruments";
import type { Effect, ParameterDefinition, ParameterValue } from "./instruments";

// Keep combinations useful for auditioning while allowing each effect's character to vary.
const ranges: Record<string, [number, number]> = {
  gain: [-6, 3],
  makeup: [0, 3],
  midGain: [-6, 3],
  sideGain: [-6, 3],
  drive: [0, 15],
  feedback: [0, 60],
  resonance: [0.4, 4],
  rate: [0.1, 8],
  depth: [10, 70],
  time: [0.01, 0.6],
  decay: [0.1, 3],
  attack: [0.001, 0.08],
  release: [0.03, 0.8],
  hold: [0.02, 0.4],
  delay: [0, 0.5],
  threshold: [-42, -6],
  ratio: [1, 6],
  ceiling: [-6, -0.1],
  cents: [-30, 30],
  shift: [-100, 100],
  voices: [1, 4],
  noise: [0, 10],
  folds: [1, 5],
  bias: [-0.5, 0.5],
  width: [0.5, 140],
};

const randomParameter = (
  definition: ParameterDefinition,
  type: string,
  random: () => number,
): ParameterValue => {
  if (definition.options !== undefined) {
    return definition.options[Math.floor(random() * definition.options.length)] ?? definition.value;
  }
  let [min, max] = ranges[definition.key] ?? [definition.min, definition.max];
  if (definition.key === "frequency") {
    [min, max] = type === "High Pass" ? [30, 800] : [300, 14_000];
  } else if (definition.key === "threshold" && type === "Noise Gate") {
    [min, max] = [-65, -40];
  } else if (definition.key === "ratio" && type === "Expander") {
    [min, max] = [1, 3];
  } else if (definition.key === "width" && type === "Formant Filter") {
    [min, max] = [0.5, 8];
  }
  min = Math.max(definition.min, min);
  max = Math.min(definition.max, max);
  // Frequencies and durations benefit from equal coverage of octaves and short times.
  const logarithmic = min > 0 && max / min > 20;
  const amount = random();
  const value = logarithmic ? min * (max / min) ** amount : min + amount * (max - min);
  const firstStep = Math.ceil((min - definition.min) / definition.step);
  const lastStep = Math.floor((max - definition.min) / definition.step);
  const step = Math.max(
    firstStep,
    Math.min(lastStep, Math.round((value - definition.min) / definition.step)),
  );
  return Number((definition.min + step * definition.step).toFixed(6));
};

export const randomEffects = (random: () => number): Effect[] => {
  const candidates = Object.keys(EFFECT_PARAMETERS);
  return Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
    const [type = "Gain"] = candidates.splice(Math.floor(random() * candidates.length), 1);
    const effect = createEffect(type);
    for (const definition of EFFECT_PARAMETERS[type] ?? []) {
      effect.parameters[definition.key] = randomParameter(definition, type, random);
    }
    if (type === "EQ") {
      const filters = ["peaking", "lowpass", "highpass"];
      const filterRanges: Record<string, [number, number]> = {
        lowpass: [1500, 14_000],
        highpass: [30, 800],
      };
      setEffectFilterPoints(
        effect,
        Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
          const filter = filters[Math.floor(random() * filters.length)] ?? "peaking";
          const [min, max] = filterRanges[filter] ?? [60, 12_000];
          return {
            id: instrumentId("filter"),
            type: filter,
            frequency: Math.round(min * (max / min) ** random()),
            gain: filter === "peaking" ? Math.round((random() * 18 - 9) * 10) / 10 : 0,
          };
        }),
      );
    }
    return effect;
  });
};
