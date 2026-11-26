import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { PreferencesSchema } from "./generated/preferences_pb";
import { readStoredValue, writeStoredValue } from "./indexed-storage";
import { createDefaultKeyBindings, normalizeKeyBindings } from "./keybindings";
import type { ControlsPreset, KeyBindings } from "./keybindings";
import { scales } from "./model";

export const MAX_AUDIO_THREADS = 16;
export const defaultAudioThreads = (
  cores = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency,
): number =>
  Number.isFinite(cores) ? Math.max(1, Math.min(MAX_AUDIO_THREADS, Math.floor(cores) - 1)) : 1;
export const normalizeAudioThreads = (value: number): number =>
  Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_AUDIO_THREADS, Math.round(value)))
    : defaultAudioThreads();

// Preferences apply immediately and save locally. Shared songs use the recipient's settings.
// Listening volume affects local playback only and creates no song edit or undo step.
export type Preferences = {
  keyBindings: KeyBindings;
  controlsPreset: ControlsPreset;
  listeningVolume: number;
  audioThreads: number;
  autoFollow: boolean;
  allowOutsideScale: boolean;
  leftAlignPiano: boolean;
  songInUrl: boolean;
  layout: "long" | "tall";
  snapRecording: boolean;
  filterRecording: boolean;
  keyboardLayout: string;
  unboundKeysPlayNotes: boolean;
  metronome: boolean;
  countIn: boolean;
  midi: boolean;
  defaultScale: string;
  defaultCustomScale: number[];
  exportFormat: string;
  sidewaysStrategy: string;
};
export const defaultPreferences: Preferences = {
  keyBindings: createDefaultKeyBindings(),
  controlsPreset: "simple",
  listeningVolume: 75,
  audioThreads: defaultAudioThreads(),
  autoFollow: true,
  allowOutsideScale: false,
  leftAlignPiano: true,
  songInUrl: true,
  layout: "long",
  snapRecording: false,
  filterRecording: false,
  keyboardLayout: "Wicki-Hayden",
  unboundKeysPlayNotes: false,
  metronome: true,
  countIn: true,
  midi: false,
  defaultScale: "Free",
  defaultCustomScale: Array.from({ length: 12 }, (_, i) => i),
  exportFormat: "slopemp",
  sidewaysStrategy: "overflow",
};
export const normalizePreferences = (raw: unknown): Preferences => {
  const result = {
    ...defaultPreferences,
    keyBindings: createDefaultKeyBindings(),
    defaultCustomScale: [...defaultPreferences.defaultCustomScale],
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return result;
  }
  result.keyBindings = normalizeKeyBindings(Reflect.get(raw, "keyBindings"));
  for (const key of Object.keys(result)) {
    if (!Object.hasOwn(raw, key)) {
      continue;
    }
    const value: unknown = Reflect.get(raw, key);
    const current: unknown = Reflect.get(result, key);
    if (
      (typeof value === "boolean" && typeof current === "boolean") ||
      (typeof value === "number" && typeof current === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && typeof current === "string")
    ) {
      Reflect.set(result, key, value);
    }
    if (
      key === "defaultCustomScale" &&
      Array.isArray(value) &&
      value.every(
        (item: unknown): item is number =>
          typeof item === "number" && Number.isInteger(item) && item >= 0 && item < 12,
      )
    ) {
      result.defaultCustomScale = [...new Set([0, ...value])].sort((left, right) => left - right);
    }
  }
  result.listeningVolume = Math.max(0, Math.min(100, result.listeningVolume));
  result.audioThreads = normalizeAudioThreads(result.audioThreads);
  if (!["simple", "combo", "custom"].includes(result.controlsPreset)) {
    result.controlsPreset = "simple";
  }
  const layout: unknown = Reflect.get(result, "layout");
  if (layout !== "long" && layout !== "tall") {
    result.layout = "long";
  }
  if (!Object.hasOwn(scales, result.defaultScale) && result.defaultScale !== "Custom") {
    result.defaultScale = "Free";
  }
  if (!["slopemp", "wav", "mp3", "mid"].includes(result.exportFormat)) {
    result.exportFormat = "slopemp";
  }
  if (!["overflow", "wrap"].includes(result.sidewaysStrategy)) {
    result.sidewaysStrategy = "overflow";
  }
  return result;
};
export const serializePreferences = (prefs: Partial<Preferences>): Uint8Array => {
  const { keyBindings, defaultCustomScale, ...values } = prefs;
  return toBinary(
    PreferencesSchema,
    create(PreferencesSchema, {
      ...values,
      keyBindings: Object.fromEntries(
        Object.entries(keyBindings ?? {}).map(([action, bindings]) => [action, { bindings }]),
      ),
      defaultCustomScale:
        defaultCustomScale === undefined ? undefined : { pitches: defaultCustomScale },
    }),
  );
};
export const parsePreferences = (bytes: Uint8Array): Preferences => {
  const { keyBindings, defaultCustomScale, ...values } = fromBinary(PreferencesSchema, bytes, {
    readUnknownFields: false,
  });
  return normalizePreferences({
    ...values,
    keyBindings: Object.fromEntries(
      Object.entries(keyBindings).map(([action, { bindings }]) => [action, bindings]),
    ),
    defaultCustomScale: defaultCustomScale?.pitches,
  });
};
export const readPreferences = async (): Promise<Preferences> => {
  try {
    const bytes = await readStoredValue("preferences");
    return bytes instanceof Uint8Array ? parsePreferences(bytes) : normalizePreferences(undefined);
  } catch {
    return normalizePreferences(undefined);
  }
};
export const savePreferences = async (prefs: Preferences): Promise<boolean> => {
  try {
    await writeStoredValue("preferences", serializePreferences(prefs));
    return true;
  } catch {
    return false;
  }
};
export const keyboardRows = [
  ["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Slash"],
  ["KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote"],
  [
    "KeyQ",
    "KeyW",
    "KeyE",
    "KeyR",
    "KeyT",
    "KeyY",
    "KeyU",
    "KeyI",
    "KeyO",
    "KeyP",
    "BracketLeft",
    "BracketRight",
  ],
  [
    "Digit1",
    "Digit2",
    "Digit3",
    "Digit4",
    "Digit5",
    "Digit6",
    "Digit7",
    "Digit8",
    "Digit9",
    "Digit0",
    "Minus",
    "Equal",
  ],
];
export const keyboardPitch = (
  code: string,
  layout: string,
  octave: number,
  key: number,
  scale: number[],
): number | null => {
  let row = -1;
  let column = -1;
  keyboardRows.forEach((keys, index) => {
    const col = keys.indexOf(code);
    if (col !== -1) {
      row = index;
      column = col;
    }
  });
  if (row < 0) {
    return null;
  }
  const reference = octave * 12;
  const mappedPitch = (): number | null => {
    if (layout === "Wicki-Hayden") {
      return reference - 2 + column * 2 + row * 5;
    } else if (layout === "selected song scale") {
      return scale.length === 0
        ? null
        : reference +
            (row - 1) * 12 +
            Math.floor(column / scale.length) * 12 +
            (scale[column % scale.length] ?? 0);
    } else {
      const minor = layout.includes("Minor");
      const white = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
      const black = minor ? [-1, 1, null, 4, 6, null, 9] : [null, 1, 3, null, 6, 8, 10];
      const degree = column % 7;
      const semitone = row % 2 === 0 ? white[degree] : black[degree];
      if (semitone === null || semitone === undefined) {
        return null;
      }
      let pitch = reference + (row >= 2 ? 12 : 0) + Math.floor(column / 7) * 12 + semitone;
      if (!layout.includes("transposing")) {
        pitch += (minor ? 9 : 0) - key;
      }
      return pitch;
    }
  };
  const pitch = mappedPitch();
  return pitch !== null && pitch >= 0 && pitch <= 108 ? pitch : null;
};
