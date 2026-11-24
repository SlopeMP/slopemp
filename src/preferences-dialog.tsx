import type { JSX } from "solid-js";

import { CategoryBrowser } from "./category-browser";
import { NumericControl, NumericInput, SelectWrap, Setting, ToggleControl } from "./editors";
import { Icon } from "./icons";
import { KeyBindingsEditor } from "./keybinding-editor";
import { createDefaultKeyBindings } from "./keybindings";
import { scalePitches } from "./model";
import type { Song } from "./model";
import {
  keyboardPitch,
  keyboardRows,
  MAX_AUDIO_THREADS,
  normalizeAudioThreads,
} from "./preferences";
import type { Preferences } from "./preferences";

const noteNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

export const PreferencesDialogContent = (props: {
  readonly prefs: Preferences;
  readonly song: Song;
  readonly octave: number;
  readonly onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  readonly onChooseLayout: () => void;
}): JSX.Element => (
  <CategoryBrowser
    label="Preference categories"
    categories={[
      {
        title: "Piano Roll",
        icon: "piano",
        keywords:
          "automatically view current bar follow playback allow adding notes not in scale align piano buttons transparency side pattern previews",
        content: () => (
          <>
            <ToggleControl
              label="Automatically View Current Bar"
              tooltip="Follow playback in the editor"
              value={props.prefs.autoFollow}
              onChange={(v) => {
                props.onChange("autoFollow", v);
              }}
            />
            <ToggleControl
              label="Allow Adding Notes Not in Scale"
              tooltip="Allow every pitch when drawing notes"
              value={props.prefs.allowOutsideScale}
              onChange={(v) => {
                props.onChange("allowOutsideScale", v);
              }}
            />
            <ToggleControl
              label="Left Align Piano"
              tooltip="Keep piano buttons at the left edge when side pattern previews are visible"
              value={props.prefs.leftAlignPiano}
              onChange={(value) => {
                props.onChange("leftAlignPiano", value);
              }}
            />
          </>
        ),
      },
      {
        title: "Audio",
        icon: "volume",
        keywords: "volume audio threads playback loudness processing",
        content: () => (
          <>
            <NumericControl
              label="Volume"
              tooltip="Set playback loudness on this device"
              min={0}
              max={100}
              value={props.prefs.listeningVolume}
              onChange={(value) => {
                props.onChange("listeningVolume", value);
              }}
              onPreview={(value) => {
                if (value !== null) {
                  props.onChange("listeningVolume", value);
                }
              }}
            />
            <Setting
              label="Audio Threads"
              tooltip="Maximum audio processing threads. Tracks and automation share threads up to this limit."
            >
              <NumericInput
                aria-label="Audio Threads"
                class="control"
                min={1}
                max={MAX_AUDIO_THREADS}
                step={1}
                value={props.prefs.audioThreads}
                onCommit={(value) => {
                  props.onChange("audioThreads", normalizeAudioThreads(value));
                }}
              />
            </Setting>
          </>
        ),
      },
      {
        title: "Editor",
        icon: "layout",
        keywords: "use current scale as default display song data in URL choose layout",
        content: () => (
          <>
            <ToggleControl
              label="Use Current Scale as Default"
              tooltip="Start new songs with this scale"
              value={
                props.prefs.defaultScale === props.song.scale &&
                (props.song.scale !== "Custom" ||
                  JSON.stringify(props.prefs.defaultCustomScale) ===
                    JSON.stringify(props.song.customScale))
              }
              onChange={() => {
                props.onChange("defaultScale", props.song.scale);
                props.onChange("defaultCustomScale", props.song.customScale);
              }}
            />
            <ToggleControl
              label="Display Song Data in URL"
              tooltip="Keep the current song in the address bar"
              value={props.prefs.songInUrl}
              onChange={(v) => {
                props.onChange("songInUrl", v);
              }}
            />
            <div class="layout-chooser">
              <Setting label="Editor layout" tooltip="Choose where the editor panels appear">
                <button type="button" class="control" onClick={props.onChooseLayout}>
                  <Icon name="layout" leading />
                  Choose Layout
                </button>
              </Setting>
            </div>
          </>
        ),
      },
      {
        title: "Note Recording",
        icon: "microphone",
        keywords: "snap recorded notes rhythm ignore scale keyboard layout metronome count-in MIDI",
        content: () => (
          <>
            <ToggleControl
              label="Snap recorded notes to the song’s rhythm"
              tooltip="Align recorded notes to the rhythm grid"
              value={props.prefs.snapRecording}
              onChange={(v) => {
                props.onChange("snapRecording", v);
              }}
            />
            <ToggleControl
              label="Ignore notes not in the song’s scale"
              tooltip="Record only notes in the scale"
              value={props.prefs.filterRecording}
              onChange={(v) => {
                props.onChange("filterRecording", v);
              }}
            />
            <Setting label="Keyboard layout" tooltip="Choose which notes the keyboard plays">
              <SelectWrap>
                <select
                  class="control"
                  aria-label="Keyboard layout"
                  value={props.prefs.keyboardLayout}
                  onChange={(e) => {
                    props.onChange("keyboardLayout", e.target.value);
                  }}
                >
                  {[
                    "Wicki-Hayden",
                    "selected song scale",
                    "piano starting at C Major",
                    "piano starting at A Minor",
                    "piano transposing C Major to song key",
                    "piano transposing A Minor to song key",
                  ].map((v) => (
                    <option>{v}</option>
                  ))}
                </select>
              </SelectWrap>
            </Setting>
            <div class="keyboard-preview" aria-label="Keyboard preview">
              {keyboardRows.toReversed().map((row) => (
                <div>
                  {row.map((code) => {
                    const p = keyboardPitch(
                      code,
                      props.prefs.keyboardLayout,
                      props.octave,
                      props.song.key,
                      scalePitches(props.song),
                    );
                    return (
                      <span
                        class={((): "" | "in-scale" | "tonic" => {
                          if (p !== null && p % 12 === 0) {
                            return "tonic";
                          } else {
                            if (p !== null && scalePitches(props.song).includes(p % 12)) {
                              return "in-scale";
                            } else {
                              return "";
                            }
                          }
                        })()}
                      >
                        <small>{code.replace("Key", "").replace("Digit", "")}</small>
                        {p === null ? "" : noteNames[(p + props.song.key) % 12]}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
            <ToggleControl
              label="Hear metronome while recording"
              tooltip="Hear a steady beat while recording"
              value={props.prefs.metronome}
              onChange={(v) => {
                props.onChange("metronome", v);
              }}
            />
            <ToggleControl
              label="Count-in one bar of metronome before recording"
              tooltip="Hear one bar of beats before recording starts"
              value={props.prefs.countIn}
              onChange={(v) => {
                props.onChange("countIn", v);
              }}
            />
            <ToggleControl
              label="Enable MIDI performance"
              tooltip="Play and record with a connected MIDI keyboard"
              value={props.prefs.midi}
              onChange={(v) => {
                props.onChange("midi", v);
              }}
            />
          </>
        ),
      },
      {
        title: "Key Bindings",
        icon: "keyboard",
        keywords:
          "keyboard shortcuts hotkeys reset key binds unbound keys play notes controls preset",
        content: () => (
          <KeyBindingsEditor
            bindings={props.prefs.keyBindings}
            controlsPreset={props.prefs.controlsPreset}
            onPresetChange={(preset) => {
              props.onChange("controlsPreset", preset);
              if (preset !== "custom") {
                props.onChange("keyBindings", createDefaultKeyBindings(preset));
              }
            }}
            unboundKeysPlayNotes={props.prefs.unboundKeysPlayNotes}
            onUnboundKeysPlayNotesChange={(value) => {
              props.onChange("unboundKeysPlayNotes", value);
            }}
            onChange={(value) => {
              props.onChange("keyBindings", value);
              props.onChange("controlsPreset", "custom");
            }}
          />
        ),
      },
    ]}
  />
);
