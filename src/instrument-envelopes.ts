import { filterParameters } from "./filters";
import { createEnvelope, EFFECT_PARAMETERS } from "./instruments";
import type { Envelope, Instrument } from "./instruments";

export const envelopeTypes = [
  "None",
  "Note Size",
  "Punch",
  "Flare",
  "Twang",
  "Swell",
  "Decay",
  "Sine",
  "Square",
  "Triangle",
  "Staged / SF2",
];

export const envelopeTargets = (
  instrument: Instrument,
): Array<{ label: string; value: string }> => {
  const targets = [{ label: "Note volume", value: "volume" }];
  if (["pulse width", "supersaw"].includes(instrument.type)) {
    targets.push({ label: "Pulse Width", value: "pulseWidth" });
  }
  if (instrument.type === "picked string") {
    targets.push({ label: "Sustain", value: "sustain" });
  }
  if (instrument.type === "supersaw") {
    ["dynamism", "spread", "shape"].forEach((key) => {
      targets.push({ label: `Supersaw ${key}`, value: key });
    });
  }
  if (instrument.type === "FM (n-op)") {
    instrument.operators.forEach((operator, index) => {
      [
        "ratio",
        "offset",
        "amplitude",
        "coarse",
        "fine",
        "pan",
        "stereoDetune",
        ...(operator.wave === "pulse width" ? ["pulseWidth"] : []),
      ].forEach((key) => {
        targets.push({
          label: `Operator ${index + 1} ${key}`,
          value: `operator:${operator.id}:${key}`,
        });
      });
    });
    targets.push({ label: "FM Feedback Volume", value: "feedbackVolume" });
  }
  instrument.effects.forEach((effect, index) => {
    if (effect.type === "Monoize") {
      return;
    }
    for (const parameter of effect.type === "EQ"
      ? filterParameters(effect)
      : (EFFECT_PARAMETERS[effect.type] ?? [])) {
      if (!parameter.options) {
        targets.push({
          label: `${index + 1}. ${effect.type}: ${parameter.label}`,
          value: `effect:${effect.id}:${parameter.key}`,
        });
      }
    }
  });
  return targets;
};

// Endpoints are multipliers of the chosen target. Keep modulation audible while
// allowing drum shapes to decay to silence, and stage envelopes to rise first.
export const randomEnvelope = (target: string, random: () => number, drum = false): Envelope => {
  const types = drum
    ? ["Punch", "Flare", "Twang", "Decay", "Staged / SF2"]
    : envelopeTypes.filter((type) => type !== "None");
  const type = types[Math.floor(random() * types.length)] ?? "Decay";
  const high = 0.65 + random() * 0.35;
  const low = drum ? 0 : 0.1 + random() * 0.35;
  const rises = ["Flare", "Swell", "Staged / SF2", "Note Size"].includes(type);
  return {
    ...createEnvelope(),
    target,
    type,
    speed: drum ? 1 + random() * 11 : 0.25 + random() * 7.75,
    a: rises ? low : high,
    b: rises ? high : low,
    phase: random() * 360,
    duty: 0.1 + random() * 0.8,
    attack: 0.001 + random() * (drum ? 0.025 : 0.4),
    decay: 0.05 + random() * (drum ? 0.45 : 1.45),
    sustain: drum ? 0 : 0.15 + random() * 0.7,
    release: 0.03 + random() * (drum ? 0.3 : 0.97),
    curve: 0.25 + random() * 3.75,
    law: "generic",
    delay: random() * (drum ? 0.005 : 0.1),
    hold: random() * (drum ? 0.025 : 0.2),
    initialLevel: 0,
    terminalLevel: 0,
  };
};
