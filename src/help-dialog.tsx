import type { JSX } from "solid-js";

import { CategoryBrowser } from "./category-browser";
import { Icon } from "./icons";

export const HelpDialogContent = (): JSX.Element => (
  <CategoryBrowser
    label="Help categories"
    categories={[
      {
        title: "Getting Started",
        icon: "book",
        keywords: "draw notes grid chord timing bend expression select time arrangement loop touch",
        content: () => (
          <>
            <p>
              Draw notes by clicking or dragging in the grid. Click a note to remove its pitch.
              Click above or below a note to build a chord. Drag sideways to edit timing, vertically
              on a note to bend, or beside it to change expression.
            </p>
            <p>
              Shift-click or Shift-drag to select time. On touch, hold still before dragging to
              select. Drag across arrangement cells to select a rectangle. Click the upper or lower
              half of a current cell to change its pattern number.
            </p>
            <p>
              Drag either half of the loop to adjust its boundary, or drag outside the loop to move
              it. Preferences includes recording setup and editable key bindings.
            </p>
          </>
        ),
      },
      {
        title: "Features",
        icon: "list-details",
        keywords:
          "patterns instruments synthesis FM samples SoundFont effects automation recording MIDI import export audio scales undo redo",
        content: () => (
          <ul class="help-list">
            <li>Arrange reusable patterns across pitch, drum, and automation channels.</li>
            <li>Edit chords, pitch bends, note expression, rhythm, and custom scales.</li>
            <li>
              Create sounds with chip waves, FM, noise, spectrum, harmonics, and picked strings.
            </li>
            <li>Use instrument presets, audio samples, and SoundFont instruments.</li>
            <li>Shape sounds with effects, envelopes, filters, and automation.</li>
            <li>Play and record notes with a computer keyboard or MIDI controller.</li>
            <li>Record with a metronome, count-in, rhythm snapping, and scale filtering.</li>
            <li>Import songs and MIDI. Export songs, WAV, MP3, and MIDI.</li>
            <li>Share songs in the URL and undo or redo song edits.</li>
            <li>Customize the editor layout, playback preferences, and key bindings.</li>
          </ul>
        ),
      },
      {
        title: "Credits",
        icon: "info-circle",
        keywords:
          "SlopeMP UltraBox John Nesky contributors assets samples SoundFont Fluid R3 Mono Versilian Studios Florestan SolidJS Tabler fflate lamejs license",
        content: () => (
          <>
            <p>SlopeMP is free software under the GNU General Public License v3.0 only.</p>
            <ul class="help-list">
              <li>
                Synthesis code adapted from UltraBox, by John Nesky and contributing authors, under
                the MIT license.
              </li>
              <li>
                Editor UI elements adapted from BeepBox, by John Nesky and contributing authors,
                under the MIT license.
              </li>
              <li>Fluid R3 Mono SoundFont, distributed under the MIT license.</li>
              <li>Piano and flute samples by Versilian Studios, dedicated under CC0 1.0.</li>
              <li>Florestan SoundFont by Nando Florestan, released into the public domain.</li>
              <li>SolidJS by Ryan Carniato, under the MIT license.</li>
              <li>Tabler Icons by Paweł Kuna, under the MIT license.</li>
              <li>fflate by Arjun Barrett, under the MIT license.</li>
              <li>lamejs by Alex Zhukov and contributors, under the LGPL v3.0.</li>
            </ul>
            <a href="./license/README.md" target="_blank" rel="noreferrer">
              Bundled asset credits and licenses
              <Icon name="external-link" />
            </a>
          </>
        ),
      },
    ]}
  />
);
