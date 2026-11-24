import { createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { SelectWrap, Setting, ToggleControl } from "./editors";
import { Icon } from "./icons";
import {
  assignKeyBindings,
  bindingFromEvent,
  conflictsForBinding,
  formatBinding,
  keyActions,
} from "./keybindings";
import type { ControlsPreset, KeyAction, KeyBinding, KeyBindings } from "./keybindings";

export const KeyBindingsEditor = (props: {
  readonly bindings: KeyBindings;
  readonly controlsPreset: ControlsPreset;
  readonly onPresetChange: (preset: ControlsPreset) => void;
  readonly unboundKeysPlayNotes: boolean;
  readonly onUnboundKeysPlayNotesChange: (value: boolean) => void;
  readonly onChange: (bindings: KeyBindings) => void;
}): JSX.Element => {
  const [capturing, setCapturing] = createSignal<KeyAction | null>(null);
  const [inUse, setInUse] = createSignal<KeyAction | null>(null);
  const groups = [...new Set(keyActions.map(({ group }) => group))];
  const assign = (action: KeyAction, keys: readonly KeyBinding[]): void => {
    props.onChange(assignKeyBindings(props.bindings, action, keys));
    setInUse(null);
  };
  const requestAssignment = (action: KeyAction, keys: readonly KeyBinding[]): void => {
    if (keys.some((key) => conflictsForBinding(props.bindings, action, key).length > 0)) {
      setCapturing(action);
      setInUse(action);
      document.querySelector<HTMLButtonElement>(`[data-key-action="${action}"]`)?.focus();
    } else {
      setCapturing(null);
      assign(action, keys);
    }
  };
  return (
    <div class="keybinding-editor">
      <ToggleControl
        label="Unbound keys play notes"
        tooltip="Play notes with keys that have no shortcut assigned"
        value={props.unboundKeysPlayNotes}
        onChange={props.onUnboundKeysPlayNotesChange}
      />
      <Setting label="Controls preset" tooltip="Choose a set of keyboard shortcuts">
        <SelectWrap>
          <select
            class="control"
            aria-label="Controls preset"
            value={props.controlsPreset}
            onChange={(event) => {
              const preset = event.target.value;
              if (preset === "simple" || preset === "combo" || preset === "custom") {
                props.onPresetChange(preset);
                setCapturing(null);
                setInUse(null);
              }
            }}
          >
            <option value="simple">Simple shortcuts</option>
            <option value="combo">Combo shortcuts</option>
            <option value="custom">Custom</option>
          </select>
        </SelectWrap>
      </Setting>
      <div class="setting-row">
        <span>Restore all default key bindings</span>
        <button
          type="button"
          class="control"
          onClick={() => {
            props.onPresetChange("simple");
            setCapturing(null);
            setInUse(null);
          }}
        >
          <Icon name="restore" leading />
          Reset Key Bindings
        </button>
      </div>
      {groups.map((group) => (
        <div class="keybinding-group">
          <h4>{group}</h4>
          {keyActions
            .filter((action) => action.group === group)
            .map(({ id, label, defaults }) => (
              <div class="setting-row">
                <span>{label}</span>
                <div class="keybinding-controls">
                  <button
                    type="button"
                    class={`control keybinding-capture${inUse() === id ? " keybinding-in-use" : ""}`}
                    data-key-action={id}
                    aria-label={`Set ${label} key binding`}
                    aria-pressed={capturing() === id}
                    title="Press a key combination to replace this binding"
                    onClick={() => {
                      setCapturing(id);
                      setInUse(null);
                    }}
                    onBlur={() => {
                      setCapturing(null);
                      setInUse(null);
                    }}
                    onKeyDown={(event) => {
                      if (capturing() !== id) {
                        return;
                      }
                      event.stopPropagation();
                      if (event.key === "Tab") {
                        setCapturing(null);
                        setInUse(null);
                        return;
                      }
                      event.preventDefault();
                      if (event.key === "Escape") {
                        setCapturing(null);
                        setInUse(null);
                        return;
                      }
                      if (event.repeat) {
                        return;
                      }
                      const key = bindingFromEvent(event);
                      if (!key) {
                        return;
                      }
                      requestAssignment(id, [key]);
                    }}
                  >
                    <Icon name="keyboard" leading />
                    {capturing() === id && inUse() === id && "Key in use"}
                    {capturing() === id && inUse() !== id && "Press a key..."}
                    {capturing() !== id &&
                      ((props.bindings[id] ?? []).map(formatBinding).join(" / ") || "Unbound")}
                  </button>
                  <button
                    type="button"
                    class="control keybinding-clear"
                    aria-label={`Clear ${label} key binding`}
                    disabled={(props.bindings[id] ?? []).length === 0}
                    onClick={() => {
                      props.onChange({ ...props.bindings, [id]: [] });
                      setCapturing(null);
                      setInUse(null);
                    }}
                  >
                    <Icon name="x" leading />
                    Clear
                  </button>
                  <button
                    type="button"
                    class="control keybinding-reset"
                    aria-label={`Reset ${label} key binding`}
                    title="Restore default bindings"
                    onClick={() => {
                      requestAssignment(id, defaults);
                    }}
                  >
                    <Icon name="restore" leading />
                    Reset
                  </button>
                </div>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
};
