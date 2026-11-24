export type KeyBinding = {
  code: string;
  shift: boolean;
  mod: boolean;
  alt: boolean;
};

const binding = (code: string, shift = false, mod = false): KeyBinding => ({
  code,
  shift,
  mod,
  alt: false,
});
const standard = (code: string, shift = false): KeyBinding[] => [
  binding(code, shift),
  binding(code, shift, true),
];
const baseActions = [
  {
    id: "play",
    label: "Play / pause; stop recording",
    group: "Playback",
    defaults: [binding("Space")],
  },
  {
    id: "record",
    label: "Start / stop recording",
    group: "Playback",
    defaults: [binding("KeyP", false, true)],
  },
  {
    id: "playPointer",
    label: "Play from pointer",
    group: "Playback",
    defaults: [binding("Space", true)],
  },
  {
    id: "previousBar",
    label: "Previous playback bar",
    group: "Playback",
    defaults: [binding("BracketLeft")],
  },
  {
    id: "nextBar",
    label: "Next playback bar",
    group: "Playback",
    defaults: [binding("BracketRight")],
  },
  { id: "undo", label: "Undo", group: "Editing", defaults: [binding("KeyZ")] },
  {
    id: "redo",
    label: "Redo",
    group: "Editing",
    defaults: [binding("KeyZ", true), binding("KeyY")],
  },
  { id: "cut", label: "Cut", group: "Editing", defaults: [binding("KeyX")] },
  { id: "copy", label: "Copy", group: "Editing", defaults: standard("KeyC") },
  { id: "paste", label: "Paste", group: "Editing", defaults: standard("KeyV") },
  { id: "insertBar", label: "Insert bars", group: "Editing", defaults: [binding("Enter")] },
  {
    id: "insertChannel",
    label: "Insert channel below",
    group: "Editing",
    defaults: [binding("Enter", false, true)],
  },
  {
    id: "deleteBars",
    label: "Delete bars or selected note time",
    group: "Editing",
    defaults: [binding("Backspace"), binding("Delete")],
  },
  {
    id: "deleteChannels",
    label: "Delete channels",
    group: "Editing",
    defaults: [binding("Backspace", false, true), binding("Delete", false, true)],
  },
  { id: "selectAll", label: "Select all", group: "Editing", defaults: standard("KeyA") },
  {
    id: "selectChannel",
    label: "Select channel",
    group: "Editing",
    defaults: standard("KeyA", true),
  },
  {
    id: "duplicate",
    label: "Duplicate reused patterns",
    group: "Editing",
    defaults: [binding("KeyD")],
  },
  {
    id: "transposeUp",
    label: "Transpose up one scale step",
    group: "Editing",
    defaults: [binding("Equal")],
  },
  {
    id: "transposeDown",
    label: "Transpose down one scale step",
    group: "Editing",
    defaults: [binding("Minus")],
  },
  {
    id: "octaveUp",
    label: "Transpose up one octave",
    group: "Editing",
    defaults: [binding("Equal", true)],
  },
  {
    id: "octaveDown",
    label: "Transpose down one octave",
    group: "Editing",
    defaults: [binding("Minus", true)],
  },
  {
    id: "clearSelection",
    label: "Clear selections",
    group: "Editing",
    defaults: [binding("Escape")],
  },
  {
    id: "moveUp",
    label: "Select previous channel",
    group: "Navigation",
    defaults: [binding("ArrowUp")],
  },
  {
    id: "moveDown",
    label: "Select next channel",
    group: "Navigation",
    defaults: [binding("ArrowDown")],
  },
  {
    id: "moveLeft",
    label: "Select previous bar",
    group: "Navigation",
    defaults: [binding("ArrowLeft")],
  },
  {
    id: "moveRight",
    label: "Select next bar",
    group: "Navigation",
    defaults: [binding("ArrowRight")],
  },
  {
    id: "extendUp",
    label: "Extend selection up",
    group: "Navigation",
    defaults: [binding("ArrowUp", true)],
  },
  {
    id: "extendDown",
    label: "Extend selection down",
    group: "Navigation",
    defaults: [binding("ArrowDown", true)],
  },
  {
    id: "extendLeft",
    label: "Extend selection left",
    group: "Navigation",
    defaults: [binding("ArrowLeft", true)],
  },
  {
    id: "extendRight",
    label: "Extend selection right",
    group: "Navigation",
    defaults: [binding("ArrowRight", true)],
  },
  {
    id: "channelUp",
    label: "Move selected channels up",
    group: "Navigation",
    defaults: [binding("ArrowUp", false, true)],
  },
  {
    id: "channelDown",
    label: "Move selected channels down",
    group: "Navigation",
    defaults: [binding("ArrowDown", false, true)],
  },
  {
    id: "copyInstrument",
    label: "Copy instrument",
    group: "Instruments",
    defaults: [binding("KeyC", true)],
  },
  {
    id: "pasteInstrument",
    label: "Paste instrument",
    group: "Instruments",
    defaults: [binding("KeyV", true)],
  },
  { id: "randomPreset", label: "Random preset", group: "Instruments", defaults: [binding("KeyR")] },
  {
    id: "randomInstrument",
    label: "Random generated instrument",
    group: "Instruments",
    defaults: [binding("KeyR", true)],
  },
  {
    id: "muteSelected",
    label: "Mute selected channels",
    group: "Channels",
    defaults: [binding("KeyM")],
  },
  {
    id: "muteAll",
    label: "Mute all channels",
    group: "Channels",
    defaults: [binding("KeyM", true)],
  },
  { id: "solo", label: "Solo selected channels", group: "Channels", defaults: [binding("KeyS")] },
  {
    id: "exclude",
    label: "Exclude selected channels",
    group: "Channels",
    defaults: [binding("KeyS", true)],
  },
  {
    id: "channelSettings",
    label: "Channel settings",
    group: "Channels",
    defaults: [binding("KeyQ")],
  },
  { id: "assets", label: "Add assets", group: "Dialogs", defaults: [binding("KeyQ", true)] },
  {
    id: "import",
    label: "Import song",
    group: "Dialogs",
    defaults: [binding("KeyO", false, true)],
  },
  {
    id: "export",
    label: "Export song",
    group: "Dialogs",
    defaults: [binding("KeyS", false, true)],
  },
] as const;

const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
type Digit = (typeof digits)[number];
export type KeyAction = (typeof baseActions)[number]["id"] | `pattern${Digit}`;
export type KeyBindings = Partial<Record<KeyAction, KeyBinding[]>>;
type KeyActionDefinition = {
  id: KeyAction;
  label: string;
  group: string;
  defaults: readonly KeyBinding[];
};
export const keyActions: readonly KeyActionDefinition[] = [
  ...baseActions,
  ...digits.map((n): KeyActionDefinition => ({
    id: `pattern${n}`,
    label: `Assign pattern digit ${n}`,
    group: "Patterns",
    defaults: [binding(`Digit${n}`)],
  })),
];

const sameBinding = (a: KeyBinding, b: KeyBinding): boolean =>
  a.code === b.code && a.shift === b.shift && a.mod === b.mod && a.alt === b.alt;

export type ControlsPreset = "combo" | "custom" | "simple";
const noteCode =
  /^(?:Key[A-Z]|Digit[0-9]|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Minus|Equal)$/u;
export const createDefaultKeyBindings = (
  preset: Exclude<ControlsPreset, "custom"> = "simple",
): KeyBindings =>
  Object.fromEntries(
    keyActions.map(({ id, defaults }) => {
      const keys: KeyBinding[] = [];
      for (const original of defaults) {
        const key = { ...original };
        if (preset === "combo" && !key.mod && !key.alt && noteCode.test(key.code)) {
          key.mod = true;
          // Keep explicit combinations, such as Export, on their existing keys.
          key.alt = keyActions.some(
            (action) =>
              action.id !== id &&
              action.defaults.some((other) => other.mod && sameBinding(key, other)),
          );
        }
        if (!keys.some((other) => sameBinding(key, other))) {
          keys.push(key);
        }
      }
      return [id, keys];
    }),
  );

const validCode =
  /^(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Backspace|Delete|Escape|Home|End|PageUp|PageDown|Insert|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/u;
const validBindingObject = (value: object): boolean => {
  const code: unknown = Reflect.get(value, "code");
  return (
    typeof code === "string" &&
    validCode.test(code) &&
    typeof Reflect.get(value, "shift") === "boolean" &&
    typeof Reflect.get(value, "mod") === "boolean" &&
    typeof Reflect.get(value, "alt") === "boolean"
  );
};
const isBinding = (value: unknown): value is KeyBinding =>
  value !== null && typeof value === "object" && validBindingObject(value);
export const normalizeKeyBindings = (raw: unknown): KeyBindings => {
  const result = createDefaultKeyBindings();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return result;
  }
  for (const { id } of keyActions) {
    const value: unknown = Reflect.get(raw, id);
    if (Array.isArray(value) && value.length <= 4 && value.every(isBinding)) {
      result[id] = value.map(({ code, shift, mod, alt }) => ({ code, shift, mod, alt }));
    }
  }
  const used: KeyBinding[] = [];
  for (const { id } of keyActions) {
    result[id] = (result[id] ?? []).filter((key) => {
      if (used.some((other) => sameBinding(key, other))) {
        return false;
      }
      used.push(key);
      return true;
    });
  }
  return result;
};

export type KeyEvent = Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey">;
export const bindingFromEvent = (event: KeyEvent): KeyBinding | null => {
  const candidate = {
    code: event.code,
    shift: event.shiftKey,
    mod: event.ctrlKey || event.metaKey,
    alt: event.altKey,
  };
  return isBinding(candidate) ? candidate : null;
};
export const keyActionForEvent = (event: KeyEvent, bindings: KeyBindings): KeyAction | null => {
  const pressed = bindingFromEvent(event);
  return pressed
    ? (keyActions.find(({ id }) => (bindings[id] ?? []).some((key) => sameBinding(key, pressed)))
        ?.id ?? null)
    : null;
};

const keyNames: Record<string, string> = {
  Space: "Space",
  Equal: "=",
  Minus: "-",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};
type PlatformSignals = {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
};
export const modifierKeyName = (
  signals: PlatformSignals = typeof navigator === "undefined" ? {} : navigator,
): "Cmd" | "Ctrl" => {
  const platform =
    [signals.userAgentData?.platform, signals.platform, signals.userAgent].find(
      (value) => value !== undefined && value !== "",
    ) ?? "";
  return /Mac|iPhone|iPad|iPod/iu.test(platform) ? "Cmd" : "Ctrl";
};
export const formatBinding = (key: KeyBinding): string =>
  [
    ...(key.mod ? [modifierKeyName()] : []),
    ...(key.alt ? ["Alt"] : []),
    ...(key.shift ? ["Shift"] : []),
    keyNames[key.code] ?? key.code.replace(/^(?:Key|Digit|Arrow)/u, ""),
  ].join("+");

export const conflictsForBinding = (
  bindings: KeyBindings,
  action: KeyAction,
  key: KeyBinding,
): KeyActionDefinition[] =>
  keyActions.filter(
    ({ id }) => id !== action && (bindings[id] ?? []).some((other) => sameBinding(key, other)),
  );
export const assignKeyBindings = (
  bindings: KeyBindings,
  action: KeyAction,
  keys: readonly KeyBinding[],
): KeyBindings =>
  Object.fromEntries(
    keyActions.map(({ id }) => [
      id,
      id === action
        ? keys.map((key) => ({ ...key }))
        : (bindings[id] ?? []).filter((other) => !keys.some((key) => sameBinding(key, other))),
    ]),
  );
