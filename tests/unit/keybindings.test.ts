import { describe, expect, test } from "bun:test";

import {
  assignKeyBindings,
  bindingFromEvent,
  conflictsForBinding,
  createDefaultKeyBindings,
  formatBinding,
  keyActionForEvent,
  keyActions,
  modifierKeyName,
  normalizeKeyBindings,
} from "../../src/keybindings";
import type { KeyEvent } from "../../src/keybindings";
import { required } from "../../src/model";
import { normalizePreferences } from "../../src/preferences";

const event = (code: string, options: Partial<KeyEvent> = {}): KeyEvent => ({
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...options,
});

describe("configurable key bindings", () => {
  test("simple defaults retain shortcuts and remove the requested modifier alternatives", () => {
    const defaults = createDefaultKeyBindings();
    for (const [code, action] of [
      ["KeyZ", "undo"],
      ["KeyY", "redo"],
      ["KeyX", "cut"],
    ] as const) {
      expect(keyActionForEvent(event(code), defaults)).toBe(action);
      expect(keyActionForEvent(event(code, { ctrlKey: true }), defaults)).toBeNull();
      expect(keyActionForEvent(event(code, { metaKey: true }), defaults)).toBeNull();
    }
    expect(keyActionForEvent(event("KeyZ", { shiftKey: true }), defaults)).toBe("redo");
    expect(
      keyActionForEvent(event("KeyZ", { metaKey: true, shiftKey: true }), defaults),
    ).toBeNull();
    for (const [code, action] of [
      ["KeyC", "copyInstrument"],
      ["KeyV", "pasteInstrument"],
    ] as const) {
      expect(keyActionForEvent(event(code, { shiftKey: true }), defaults)).toBe(action);
      expect(
        keyActionForEvent(event(code, { shiftKey: true, ctrlKey: true }), defaults),
      ).toBeNull();
      expect(
        keyActionForEvent(event(code, { shiftKey: true, metaKey: true }), defaults),
      ).toBeNull();
    }
    expect(keyActionForEvent(event("KeyC", { ctrlKey: true }), defaults)).toBe("copy");
    expect(keyActionForEvent(event("KeyV", { metaKey: true }), defaults)).toBe("paste");
    expect(keyActionForEvent(event("ArrowRight", { shiftKey: true }), defaults)).toBe(
      "extendRight",
    );
    expect(keyActionForEvent(event("ArrowUp", { ctrlKey: true }), defaults)).toBe("channelUp");
    expect(keyActionForEvent(event("Space", { ctrlKey: true }), defaults)).toBeNull();
    expect(keyActionForEvent(event("KeyP", { metaKey: true }), defaults)).toBe("record");
    expect(keyActionForEvent(event("Space", { shiftKey: true }), defaults)).toBe("playPointer");
    expect(keyActionForEvent(event("Equal", { shiftKey: true }), defaults)).toBe("octaveUp");
  });

  test("removed actions cannot be dispatched or restored from stored bindings", () => {
    const defaults = createDefaultKeyBindings();
    for (const code of ["KeyF", "KeyH"]) {
      expect(keyActionForEvent(event(code), defaults)).toBeNull();
    }
    for (const digit of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
      expect(keyActionForEvent(event(`Digit${digit}`, { shiftKey: true }), defaults)).toBeNull();
      expect(keyActionForEvent(event(`Digit${digit}`), defaults)).toBe(`pattern${digit}`);
    }
    const key = required(bindingFromEvent(event("KeyK")));
    const stored = normalizeKeyBindings({
      beginning: [key],
      selectedBar: [key],
      instrument0: [key],
    });
    expect(stored).toEqual(defaults);
    expect(keyActions.filter(({ group }) => group === "Instrument selection")).toEqual([]);
    expect(
      keyActions
        .filter(({ id }) => ["cut", "copy", "paste"].includes(id))
        .map(({ label }) => label),
    ).toEqual(["Cut", "Copy", "Paste"]);
  });

  test("combo defaults leave note keys free while preserving exact modifier shortcuts", () => {
    const defaults = createDefaultKeyBindings("combo");
    expect(keyActionForEvent(event("KeyR"), defaults)).toBeNull();
    expect(keyActionForEvent(event("KeyR", { ctrlKey: true }), defaults)).toBe("randomPreset");
    expect(keyActionForEvent(event("Digit3", { metaKey: true }), defaults)).toBe("pattern3");
    expect(keyActionForEvent(event("ArrowLeft"), defaults)).toBe("moveLeft");
    expect(keyActionForEvent(event("Space"), defaults)).toBe("play");
    expect(keyActionForEvent(event("KeyS", { ctrlKey: true }), defaults)).toBe("export");
    expect(keyActionForEvent(event("KeyS", { ctrlKey: true, altKey: true }), defaults)).toBe(
      "solo",
    );
    expect(keyActionForEvent(event("KeyS", { ctrlKey: true, shiftKey: true }), defaults)).toBe(
      "exclude",
    );
    expect(keyActionForEvent(event("KeyZ", { ctrlKey: true }), defaults)).toBe("undo");
    expect(keyActionForEvent(event("KeyC", { ctrlKey: true, shiftKey: true }), defaults)).toBe(
      "copyInstrument",
    );
    for (const { id } of keyActions) {
      const keys = defaults[id] ?? [];
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(conflictsForBinding(defaults, id, key)).toEqual([]);
        expect(
          keyActionForEvent(
            event(key.code, { ctrlKey: key.mod, shiftKey: key.shift, altKey: key.alt }),
            defaults,
          ),
        ).toBe(id);
      }
      expect(new Set(keys.map((key) => formatBinding(key))).size).toBe(keys.length);
    }
  });

  test("shortcuts only match explicitly assigned combinations", () => {
    const defaults = createDefaultKeyBindings();
    expect(keyActionForEvent(event("KeyR"), defaults)).toBe("randomPreset");
    expect(keyActionForEvent(event("KeyR", { ctrlKey: true }), defaults)).toBeNull();
    expect(keyActionForEvent(event("Digit3", { metaKey: true }), defaults)).toBeNull();
    const key = required(bindingFromEvent(event("KeyK", { altKey: true })));
    const custom = assignKeyBindings(defaults, "undo", [key]);
    expect(keyActionForEvent(event("KeyK", { altKey: true }), custom)).toBe("undo");
    expect(keyActionForEvent(event("KeyK"), custom)).toBeNull();
  });

  test("remapping removes conflicting alternatives and replaces the old shortcut", () => {
    const defaults = createDefaultKeyBindings();
    const key = required(bindingFromEvent(event("KeyV")));
    expect(conflictsForBinding(defaults, "undo", key).map(({ id }) => id)).toEqual(["paste"]);
    const changed = assignKeyBindings(defaults, "undo", [key]);
    expect(keyActionForEvent(event("KeyV"), changed)).toBe("undo");
    expect(keyActionForEvent(event("KeyZ"), changed)).toBeNull();
    expect(keyActionForEvent(event("KeyV", { ctrlKey: true }), changed)).toBe("paste");
    expect(keyActionForEvent(event("KeyZ"), defaults)).toBe("undo");
    expect(keyActionForEvent(event("KeyV"), defaults)).toBe("paste");
  });

  test("capture ignores modifier-only keys and formats physical key combinations", () => {
    expect(bindingFromEvent(event("ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(bindingFromEvent(event("Tab"))).toBeNull();
    expect(
      formatBinding(required(bindingFromEvent(event("KeyK", { ctrlKey: true, altKey: true })))),
    ).toBe(`${modifierKeyName()}+Alt+K`);
    expect(formatBinding(required(bindingFromEvent(event("BracketLeft"))))).toBe("[");
    for (const direction of ["Up", "Down", "Left", "Right"]) {
      expect(formatBinding(required(bindingFromEvent(event(`Arrow${direction}`))))).toBe(direction);
    }
    expect(formatBinding(required(bindingFromEvent(event("ArrowUp", { shiftKey: true }))))).toBe(
      "Shift+Up",
    );
  });

  test("modifier labels use platform signals with user agent fallback", () => {
    expect(
      modifierKeyName({ userAgentData: { platform: "macOS" }, platform: "Linux x86_64" }),
    ).toBe("Cmd");
    expect(modifierKeyName({ userAgentData: { platform: "Windows" }, platform: "MacIntel" })).toBe(
      "Ctrl",
    );
    expect(modifierKeyName({ platform: "MacIntel" })).toBe("Cmd");
    expect(modifierKeyName({ platform: "iPad" })).toBe("Cmd");
    expect(modifierKeyName({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe(
      "Cmd",
    );
    expect(modifierKeyName({ platform: "Linux x86_64" })).toBe("Ctrl");
    expect(modifierKeyName({})).toBe("Ctrl");
  });

  test("invalid persisted bindings are rejected and duplicate chords resolve deterministically", () => {
    const defaults = createDefaultKeyBindings();
    for (const raw of [null, [], "bad", { undo: "KeyK" }, { undo: [{ code: "KeyK" }] }]) {
      expect(normalizeKeyBindings(raw)).toEqual(defaults);
    }
    const key = required(bindingFromEvent(event("KeyT")));
    const stored = normalizeKeyBindings({ undo: [key], redo: [key], play: [], unknown: [key] });
    expect(stored.undo).toEqual([key]);
    expect(stored.redo).toEqual([]);
    expect(stored.play).toEqual([]);
    expect(stored).not.toHaveProperty("unknown");
    required(stored.copy).length = 0;
    expect(createDefaultKeyBindings().copy).toHaveLength(2);
    expect(normalizeKeyBindings(createDefaultKeyBindings("combo"))).toEqual(
      createDefaultKeyBindings("combo"),
    );
  });

  test("normalizing custom bindings and presets keeps binding lists detached", () => {
    const custom = assignKeyBindings(createDefaultKeyBindings(), "undo", [
      required(bindingFromEvent(event("KeyK"))),
    ]);
    const restoredCustom = normalizePreferences({ controlsPreset: "custom", keyBindings: custom });
    expect(restoredCustom.keyBindings.undo).toEqual(custom.undo);
    expect(restoredCustom.controlsPreset).toBe("custom");
    const restoredCombo = normalizePreferences({
      controlsPreset: "combo",
      keyBindings: createDefaultKeyBindings("combo"),
    });
    expect(restoredCombo.controlsPreset).toBe("combo");
    expect(restoredCombo.keyBindings).toEqual(createDefaultKeyBindings("combo"));
    const defaults = createDefaultKeyBindings();
    const restoredSimple = normalizePreferences({
      controlsPreset: "simple",
      keyBindings: defaults,
    });
    expect(restoredSimple.controlsPreset).toBe("simple");
    expect(restoredSimple.keyBindings).toEqual(defaults);
    required(restoredSimple.keyBindings.copy).length = 0;
    expect(defaults.copy).toHaveLength(2);
  });
});
