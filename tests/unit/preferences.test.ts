import { describe, expect, test } from "bun:test";

import { createDefaultKeyBindings } from "../../src/keybindings";
import type { ControlsPreset } from "../../src/keybindings";
import {
  defaultAudioThreads,
  defaultPreferences,
  keyboardPitch,
  keyboardRows,
  MAX_AUDIO_THREADS,
  normalizeAudioThreads,
  normalizePreferences,
  parsePreferences,
  readPreferences,
  savePreferences,
  serializePreferences,
} from "../../src/preferences";

describe("local preferences", () => {
  test("missing and corrupt data preserves usable defaults", () => {
    for (const input of [undefined, "{", null, []]) {
      expect(normalizePreferences(input)).toEqual(defaultPreferences);
    }
  });
  test("unavailable storage uses defaults and reports failed writes", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get: () => {
        throw new DOMException("Storage access denied.", "SecurityError");
      },
    });
    try {
      expect(await readPreferences()).toEqual(defaultPreferences);
      expect(await savePreferences(defaultPreferences)).toBe(false);
    } finally {
      if (previous) {
        Object.defineProperty(globalThis, "indexedDB", previous);
      } else {
        Reflect.deleteProperty(globalThis, "indexedDB");
      }
    }
  });
  test("invalid persisted values fall back to supported preferences", () => {
    const result = normalizePreferences({
      listeningVolume: 500,
      layout: "invalid",
      defaultScale: "invalid",
      defaultCustomScale: [7, 7],
      exportFormat: "exe",
      sidewaysStrategy: "invalid",
    });
    expect(result.listeningVolume).toBe(100);
    expect(result.layout).toBe("long");
    expect(result.defaultScale).toBe("Free");
    expect(result.defaultCustomScale).toEqual([0, 7]);
    expect(result.exportFormat).toBe("slopemp");
    expect(result.sidewaysStrategy).toBe("overflow");
  });
  test("controls presets and note playback normalize independently", () => {
    const presets: ControlsPreset[] = ["simple", "combo", "custom"];
    for (const controlsPreset of presets) {
      for (const unboundKeysPlayNotes of [false, true]) {
        const keyBindings = createDefaultKeyBindings(
          controlsPreset === "combo" ? "combo" : "simple",
        );
        const restored = normalizePreferences({
          controlsPreset,
          unboundKeysPlayNotes,
          keyBindings,
        });
        expect(restored.controlsPreset).toBe(controlsPreset);
        expect(restored.unboundKeysPlayNotes).toBe(unboundKeysPlayNotes);
        expect(restored.keyBindings).toEqual(keyBindings);
      }
    }
  });
  test("unsupported controls presets and note-toggle types use defaults", () => {
    for (const controlsPreset of ["invalid", 42, false, null]) {
      const restored = normalizePreferences({ controlsPreset, unboundKeysPlayNotes: "true" });
      expect(restored.controlsPreset).toBe("simple");
      expect(restored.unboundKeysPlayNotes).toBe(false);
    }
  });
  test("audio thread limits default to available cores and stay within a fixed cap", () => {
    const coreCases: Array<[number, number]> = [
      [1, 1],
      [2, 1],
      [4, 3],
      [8, 4],
      [64, 4],
    ];
    for (const [cores, expected] of coreCases) {
      expect(defaultAudioThreads(cores)).toBe(expected);
    }
    expect(defaultAudioThreads(Number.NaN)).toBe(1);
    expect(normalizeAudioThreads(Number.NaN)).toBe(defaultAudioThreads());
    const storedCases: Array<[number, number]> = [
      [-5, 1],
      [0, 1],
      [1, 1],
      [3.6, 4],
      [99, MAX_AUDIO_THREADS],
    ];
    for (const [value, expected] of storedCases) {
      expect(normalizePreferences({ audioThreads: value }).audioThreads).toBe(expected);
    }
    expect(normalizePreferences({ audioThreads: "8" }).audioThreads).toBe(
      defaultPreferences.audioThreads,
    );
  });
  test("wrong types are ignored and default masks are detached", () => {
    const input = { autoFollow: "false", defaultCustomScale: ["1"] };
    const value = normalizePreferences(input);
    expect(value.autoFollow).toBe(true);
    value.defaultCustomScale.length = 0;
    expect(normalizePreferences(input).defaultCustomScale).toHaveLength(12);
  });
  test("normalization preserves valid local choices", () => {
    const result = normalizePreferences({
      listeningVolume: 0,
      audioThreads: 3,
      layout: "tall",
      countIn: false,
    });
    expect(result.listeningVolume).toBe(0);
    expect(result.audioThreads).toBe(3);
    expect(result.layout).toBe("tall");
    expect(result.countIn).toBe(false);
  });
  test("protobuf preferences preserve explicit settings and cleared shortcuts", () => {
    const prefs = {
      ...defaultPreferences,
      keyBindings: { ...defaultPreferences.keyBindings, play: [] },
      listeningVolume: 0,
      autoFollow: false,
      defaultCustomScale: [0, 5, 7],
    };
    expect(parsePreferences(serializePreferences(prefs))).toEqual(prefs);
    expect(parsePreferences(serializePreferences({}))).toEqual(defaultPreferences);
    expect(
      parsePreferences(serializePreferences({ defaultCustomScale: [] })).defaultCustomScale,
    ).toEqual([0]);
  });
});

describe("computer keyboard mappings", () => {
  test("Wicki geometry is independent of scale and song key", () => {
    expect(keyboardPitch("KeyZ", "Wicki-Hayden", 4, 0, [0])).toBe(46);
    expect(keyboardPitch("KeyA", "Wicki-Hayden", 4, 0, [0])).toBe(51);
    expect(keyboardPitch("KeyS", "Wicki-Hayden", 4, 8, [0, 3, 7])).toBe(53);
    expect(keyboardPitch("KeyQ", "Wicki-Hayden", 4, 0, [0])).toBe(56);
  });
  test("piano gaps, scale traversal and pitch limits remain explicit", () => {
    expect(keyboardPitch("KeyA", "piano starting at C Major", 4, 0, [0])).toBeNull();
    expect(keyboardPitch("KeyZ", "piano starting at C Major", 4, 5, [0])).toBe(43);
    expect(keyboardPitch("KeyZ", "piano transposing C Major to song key", 4, 5, [0])).toBe(48);
    expect(keyboardPitch("KeyS", "selected song scale", 4, 0, [0, 3, 7])).toBe(51);
    expect(keyboardPitch("KeyZ", "selected song scale", 4, 0, [])).toBeNull();
    expect(keyboardPitch("Escape", "Wicki-Hayden", 4, 0, [0])).toBeNull();
    for (const octave of [0, 8]) {
      for (const row of keyboardRows) {
        for (const code of row) {
          const pitch = keyboardPitch(code, "Wicki-Hayden", octave, 0, [0]);
          if (pitch !== null) {
            expect(Number.isFinite(pitch) && pitch >= 0 && pitch <= 108).toBe(true);
          }
        }
      }
    }
  });
});
