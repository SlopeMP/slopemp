// See ../license/README.md for the source of editor geometry.
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

import { colorsForChannel, insertionRange, notePath } from "./editor-geometry";
import { Icon } from "./icons";
import type { Channel, Note, Pattern, Song } from "./model";
import { required, trackOctave } from "./model";
import { cropNote, evaluatePin, removeNoteTime } from "./operations";
import { bendNote, moveNotePin } from "./pitch-bend";
import { createPlayhead } from "./playhead";
import type { PlayheadSource } from "./playhead";
export type TimeSelection = {
  start: number;
  end: number;
};
type Props = {
  readonly song: Song;
  readonly channel: Channel;
  readonly bar: number;
  readonly committedPattern: Pattern | null;
  readonly scale: number[];
  readonly allowOutsideScale: boolean;
  readonly leftAlignPiano: boolean;
  readonly disabled: boolean;
  readonly playhead: PlayheadSource | null;
  readonly selection: TimeSelection | null;
  readonly onSelection: (value: TimeSelection | null) => void;
  readonly onGesture: (notes: Note[] | null, phase: "cancel" | "commit" | "preview") => void;
  readonly onOctave: (value: number) => void;
  readonly onZoom: (value: number) => void;
  readonly onPreviewNote: (pitch: number) => void;
  readonly onAudition: (pitch: number | null) => void;
  readonly onPointerBeat: (beat: number | null) => void;
};
type Gesture = {
  x: number;
  y: number;
  beat: number;
  pitch: number;
  noteIndex: number;
  notes: Note[];
  mode:
    | "bend"
    | "boundary-end"
    | "boundary-start"
    | "expression"
    | "move"
    | "pending"
    | "select"
    | "time";
  beganAt: number;
  touch: boolean;
  moved: boolean;
  shift: boolean;
  uniform: boolean;
  selected: TimeSelection | null;
  inserted: boolean;
};
const clone = <T,>(value: T): T => structuredClone(value);
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
const rowNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const identity = (): string => globalThis.crypto.randomUUID();
// Time increases rightward and pitch upward; reused patterns share every note edit.
// Horizontal drags edit time; vertical drags on notes bend pitch and beside notes edit expression.
// Shift or touch hold selects time. Gestures preview immediately and commit one undo step.
export const PatternEditor = (props: Props): JSX.Element => {
  const notes = createMemo(
    () => props.channel.patterns[props.channel.cells[props.bar] ?? 0]?.notes ?? [],
  );
  let gesture: Gesture | null = null;
  let surface: SVGSVGElement | null = null;
  let heldPiano: number | null = null;
  let octaveGesture: {
    trackId: string;
    y: number;
    octave: number;
    dragging: boolean;
  } | null = null;
  const [octavePreview, setOctavePreview] = createSignal<{ trackId: string; value: number } | null>(
    null,
  );
  const [audiblePitch, setAudiblePitch] = createSignal<number | null>(null);
  const [dragPreview, setDragPreview] = createSignal<{
    time: number;
    pitch: number;
    volume: number;
  } | null>(null);
  createEffect(
    on(
      [(): Pattern | null => props.committedPattern, (): boolean => props.disabled],
      () => {
        if (gesture) {
          gesture = null;
          setDragPreview(null);
          props.onGesture(null, "cancel");
        }
      },
      { defer: true },
    ),
  );
  const [hover, setHover] = createSignal<{
    beat: number;
    pitch: number;
  } | null>(null);
  const [copiedByChannel, setCopiedByChannel] = createSignal<Record<string, Note["pins"]>>({});
  const defaultLength = createMemo(() =>
    props.song.rhythm % 3 === 0 && props.song.rhythm % 4 !== 0 ? 1 / 3 : 1,
  );
  const copiedPins = createMemo(
    () =>
      copiedByChannel()[props.channel.id] ?? [
        { time: 0, interval: 0, volume: 3 },
        { time: defaultLength(), interval: 0, volume: 3 },
      ],
  );
  const template = createMemo(() => copiedPins().at(-1)?.time ?? defaultLength());
  const remember = (note: Note): void => {
    const pins = note.pins.map((pin) => ({ ...pin, interval: 0 }));
    for (let i = 1; i < pins.length - 1;) {
      if (pins[i - 1]?.volume === pins[i]?.volume && pins[i]?.volume === pins[i + 1]?.volume) {
        pins.splice(i, 1);
      } else {
        i++;
      }
    }
    setCopiedByChannel((previous) => ({ ...previous, [props.channel.id]: pins }));
  };
  const insertionPins = (duration: number): Note["pins"] => {
    const result = copiedPins()
      .filter((pin) => pin.time < duration)
      .map((pin) => ({ ...pin }));
    const last = copiedPins().find((pin) => pin.time >= duration) ?? copiedPins().at(-1);
    result.push({ time: duration, interval: 0, volume: last?.volume ?? 3 });
    return result;
  };
  const octaves = (): number => props.channel.octaves;
  const octave = (): number => {
    const preview = octavePreview();
    return preview?.trackId === props.channel.id
      ? Math.min(preview.value, 9 - octaves())
      : trackOctave(props.channel);
  };
  const rows = createMemo(() => octaves() * 12 + 1);
  const bottom = createMemo(() => octave() * 12);
  const [size, setSize] = createSignal({ width: 480, height: 481, available: 480, wide: true });
  const playhead = createPlayhead<SVGLineElement>(
    () => props.playhead,
    (element, position) => {
      element.setAttribute("transform", `translate(${(position % 1) * size().width} 0)`);
    },
  );
  onMount(() => {
    const svg = surface;
    if (!svg) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setSize({
        width: svg.clientWidth,
        height: svg.clientHeight,
        available: svg.parentElement?.clientWidth ?? svg.clientWidth,
        wide: window.innerWidth > 710,
      });
    });
    observer.observe(svg);
    if (svg.parentElement) {
      observer.observe(svg.parentElement);
    }
    onCleanup(() => {
      observer.disconnect();
    });
  });
  const rowHeight = createMemo(() => size().height / rows());
  const patternWidth = createMemo(() =>
    size().wide
      ? Math.max(
          size().available / 3,
          Math.min(size().available / (props.song.beatsPerBar + 2), rowHeight() * 5) *
            props.song.beatsPerBar,
        )
      : size().available,
  );
  const pianoFollowsPattern = createMemo(() => !props.leftAlignPiano && size().wide);
  const colors = createMemo(() =>
    colorsForChannel(props.song.channels.findIndex((t) => t.id === props.channel.id)),
  );
  const unit = createMemo(() => 1 / props.song.rhythm);
  const snapPitch = (value: number): number => {
    const guess = clamp(value + 0.5, 0, 108);
    const pitch = Math.floor(guess);
    if (props.allowOutsideScale || props.scale.includes(pitch % 12)) {
      return pitch;
    }
    let upper = pitch + 1;
    let lower = pitch - 1;
    while (upper <= 108 && !props.scale.includes(upper % 12)) {
      upper++;
    }
    while (lower >= 0 && !props.scale.includes(lower % 12)) {
      lower--;
    }
    if (upper > 108) {
      return Math.max(0, lower);
    }
    if (lower < 0) {
      return upper;
    }
    const upperRange = upper - (upper % 12 === 0 || upper % 12 === 7 ? 0.5 : 0);
    const lowerRange = lower + 1 + (lower % 12 === 0 || lower % 12 === 7 ? 0.5 : 0);
    return guess - lowerRange > upperRange - guess ? upper : lower;
  };
  const position = (
    event: PointerEvent & {
      currentTarget: SVGSVGElement;
    },
  ): {
    beat: number;
    pitch: number;
  } => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      beat: clamp(
        ((event.clientX - rect.left) / rect.width) * props.song.beatsPerBar,
        0,
        props.song.beatsPerBar,
      ),
      pitch: snapPitch(
        bottom() + rows() - 0.5 - ((event.clientY - rect.top) / rect.height) * rows(),
      ),
    };
  };
  const x = (beat: number): number => {
    return (beat / props.song.beatsPerBar) * size().width;
  };
  const y = (pitch: number): number => {
    return (bottom() + rows() - 1 - pitch + 0.5) * rowHeight();
  };
  const update = (
    event: PointerEvent & {
      currentTarget: SVGSVGElement;
    },
  ): void => {
    const pos = position(event);
    const bounds = event.currentTarget.getBoundingClientRect();
    const rawBeat = ((event.clientX - bounds.left) / bounds.width) * props.song.beatsPerBar;
    setHover(pos);
    props.onPointerBeat(pos.beat);
    const g = gesture;
    if (!g) {
      return;
    }
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 5) {
      return;
    }
    if (!g.moved && g.touch && event.timeStamp - g.beganAt > 450) {
      g.mode = "select";
    }
    g.moved = true;
    if (g.mode === "pending") {
      const note = g.notes[g.noteIndex];
      g.mode = ((): "bend" | "expression" | "time" => {
        if (Math.abs(dx) > Math.abs(dy)) {
          return "time";
        } else {
          if (
            note?.pitches.some(
              (p) => Math.abs(p + evaluatePin(note, g.beat - note.start).interval - g.pitch) < 1,
            ) === true
          ) {
            return "bend";
          } else {
            return "expression";
          }
        }
      })();
    }
    if (g.mode === "select") {
      props.onSelection({
        start: Math.floor(Math.min(g.beat, pos.beat) / unit()) * unit(),
        end: Math.min(
          props.song.beatsPerBar,
          Math.ceil(Math.max(g.beat, pos.beat) / unit()) * unit(),
        ),
      });
      return;
    }
    if ((g.mode === "boundary-start" || g.mode === "boundary-end") && g.selected) {
      const at = Math.round(pos.beat / unit()) * unit();
      props.onSelection(
        g.mode === "boundary-start"
          ? { start: Math.min(at, g.selected.end - unit()), end: g.selected.end }
          : { start: g.selected.start, end: Math.max(at, g.selected.start + unit()) },
      );
      return;
    }
    let next = clone(g.notes);
    if (g.mode === "move" && g.selected) {
      const offset = Math.round((pos.beat - g.beat) / unit()) * unit();
      const delta = pos.pitch - g.pitch;
      const { selected } = g;
      const moved = next.flatMap((n) => {
        const fragment = cropNote(n, selected.start, selected.end, offset);
        if (!fragment) {
          return [];
        }
        const clipped = cropNote(fragment, 0, props.song.beatsPerBar);
        if (!clipped) {
          return [];
        }
        clipped.pitches = clipped.pitches.map((p) => snapPitch(p + delta));
        return [clipped];
      });
      next = removeNoteTime(next, selected.start, selected.end);
      for (const note of moved) {
        next = removeNoteTime(next, note.start, note.end).concat(note);
      }
    } else if (g.noteIndex < 0) {
      const start = Math.floor(Math.min(g.beat, pos.beat) / unit()) * unit();
      const end = Math.min(
        props.song.beatsPerBar,
        Math.max(start + unit(), Math.ceil(Math.max(g.beat, pos.beat) / unit()) * unit()),
      );
      next = removeNoteTime(next, start, end);
      next.push({
        id: identity(),
        start,
        end,
        pitches: [g.pitch],
        continues: start === 0 && rawBeat < 0,
        pins: [
          { time: 0, interval: 0, volume: 3 },
          { time: end - start, interval: 0, volume: 3 },
        ],
      });
      const drawn = next.at(-1);
      if (drawn) {
        remember(drawn);
      }
    } else {
      const note = required(next[g.noteIndex]);
      if (g.mode === "time") {
        const nearest = g.notes[g.noteIndex]?.pins.toSorted(
          (a, b) => Math.abs(g.beat - note.start - a.time) - Math.abs(g.beat - note.start - b.time),
        )[0];
        const shiftedTime =
          Math.round(((nearest?.time ?? 0) + note.start + rawBeat - g.beat) / unit()) * unit();
        const value = clamp(shiftedTime, 0, props.song.beatsPerBar);
        if (nearest) {
          const index = note.pins.findIndex((p) => p.time === nearest.time);
          if (moveNotePin(note, index, value, shiftedTime < 0)) {
            next = removeNoteTime(
              next.filter((_, i) => i !== g.noteIndex),
              note.start,
              note.end,
            ).concat(note);
          } else {
            next.splice(g.noteIndex, 1);
          }
        }
        remember(note);
      } else if (g.mode === "bend") {
        const forward = dx >= 0;
        const start = forward
          ? Math.max(note.start, Math.floor(g.beat / unit()) * unit())
          : Math.min(note.end, (Math.floor(g.beat / unit()) + 1) * unit());
        const end = clamp(
          (Math.floor(rawBeat / unit()) + (forward ? 1 : 0)) * unit(),
          0,
          props.song.beatsPerBar,
        );
        const { interval } = evaluatePin(note, g.beat - note.start);
        const pitchIndex = note.pitches.findIndex((p) => Math.abs(p + interval - g.pitch) < 1);
        bendNote(note, start, end, pos.pitch, Math.max(0, pitchIndex));
        next = removeNoteTime(
          next.filter((_, i) => i !== g.noteIndex),
          note.start,
          note.end,
        ).concat(note);
        remember(note);
      } else {
        const time = clamp(
          Math.round((pos.beat - note.start) / unit()) * unit(),
          0,
          note.end - note.start,
        );
        const existing = evaluatePin(note, time);
        const pin = {
          time,
          interval: existing.interval,
          volume:
            g.mode === "expression"
              ? clamp(Math.round(existing.volume - dy / 25), 0, 3)
              : existing.volume,
        };
        if (g.uniform && g.mode === "expression") {
          note.pins = note.pins.map((p) => ({ ...p, volume: pin.volume }));
        } else {
          note.pins = note.pins
            .filter((p) => Math.abs(p.time - time) > unit() / 2)
            .concat(pin)
            .sort((a, b) => a.time - b.time);
        }
        remember(note);
      }
    }
    if (g.mode !== "move") {
      const active =
        next.find((n) => n.start <= pos.beat && n.end >= pos.beat) ?? next[g.noteIndex];
      if (active) {
        const time = clamp(Math.round(pos.beat / unit()) * unit(), active.start, active.end);
        const pin = evaluatePin(active, time - active.start);
        setDragPreview({
          time,
          pitch: (active.pitches[0] ?? g.pitch) + pin.interval,
          volume: pin.volume,
        });
      }
    }
    props.onGesture(
      next.sort((a, b) => a.start - b.start),
      "preview",
    );
  };
  const down = (
    event: PointerEvent & {
      currentTarget: SVGSVGElement;
    },
  ): void => {
    if (props.disabled || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const pos = position(event);
    const index = notes().findIndex((n) => pos.beat >= n.start && pos.beat < n.end);
    const clicked = notes()[index];
    if (clicked) {
      const rect = event.currentTarget.getBoundingClientRect();
      const raw = bottom() + rows() - 0.5 - ((event.clientY - rect.top) / rect.height) * rows();
      const bend = evaluatePin(clicked, pos.beat - clicked.start).interval;
      const exact = clicked.pitches.find((p) => Math.abs(p + bend - raw) < 0.7);
      if (exact !== undefined) {
        pos.pitch = exact + bend;
      }
    }
    const selected = props.selection;
    gesture = {
      beganAt: event.timeStamp,
      touch: event.pointerType !== "mouse",
      x: event.clientX,
      y: event.clientY,
      ...pos,
      noteIndex: index,
      notes: clone(notes()),
      mode: ((): "boundary-end" | "boundary-start" | "move" | "pending" | "select" => {
        if (event.shiftKey) {
          return "select";
        } else {
          if (selected && Math.abs(pos.beat - selected.start) < props.song.beatsPerBar * 0.012) {
            return "boundary-start";
          } else {
            if (selected && Math.abs(pos.beat - selected.end) < props.song.beatsPerBar * 0.012) {
              return "boundary-end";
            } else {
              if (selected && pos.beat >= selected.start && pos.beat <= selected.end) {
                return "move";
              } else {
                return "pending";
              }
            }
          }
        }
      })(),
      moved: false,
      shift: event.shiftKey,
      uniform: event.ctrlKey || event.metaKey,
      selected,
      inserted: false,
    };
    if (!event.shiftKey && (!selected || pos.beat < selected.start || pos.beat > selected.end)) {
      props.onSelection(null);
    }
    if (index === -1 && !event.shiftKey && !selected && event.pointerType === "mouse") {
      const { start, end } = insertionRange(
        pos.beat,
        template(),
        props.song.rhythm,
        props.song.beatsPerBar,
        notes(),
      );
      if (end > start) {
        const next = clone(notes());
        next.push({
          id: identity(),
          start,
          end,
          pitches: [pos.pitch],
          pins: insertionPins(end - start),
        });
        gesture.inserted = true;
        props.onGesture(
          next.sort((left, right) => left.start - right.start),
          "preview",
        );
        props.onPreviewNote(pos.pitch);
      }
    }
  };
  const up = (
    event: PointerEvent & {
      currentTarget: SVGSVGElement;
    },
  ): void => {
    const g = gesture;
    if (!g) {
      return;
    }
    gesture = null;
    setDragPreview(null);
    if (g.inserted && !g.moved) {
      props.onGesture(null, "commit");
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (!g.moved) {
      const note = g.notes[g.noteIndex];
      if (g.shift) {
        if (props.selection && g.beat >= props.selection.start && g.beat <= props.selection.end) {
          props.onSelection(null);
        } else {
          props.onSelection(
            note
              ? { start: note.start, end: note.end }
              : {
                  start: Math.floor(g.beat),
                  end: Math.min(props.song.beatsPerBar, Math.floor(g.beat) + 1),
                },
          );
        }
        return;
      }
      if (g.mode === "move") {
        return;
      }
      let next = clone(g.notes);
      if (note) {
        const target = required(next[g.noteIndex]);
        const bend = evaluatePin(target, g.beat - target.start).interval;
        const existing = target.pitches.findIndex((p) => Math.abs(p + bend - g.pitch) < 0.7);
        if (existing !== -1) {
          target.pitches.splice(existing, 1);
        } else {
          target.pitches.push(clamp(g.pitch - bend, 0, 108));
          remember(target);
          props.onPreviewNote(g.pitch);
        }
        if (target.pitches.length === 0) {
          next.splice(g.noteIndex, 1);
        }
      } else {
        const { start, end } = insertionRange(
          g.beat,
          template(),
          props.song.rhythm,
          props.song.beatsPerBar,
          g.notes,
        );
        next = removeNoteTime(next, start, end);
        next.push({
          id: identity(),
          start,
          end,
          pitches: [g.pitch],
          pins: insertionPins(end - start),
        });
        props.onPreviewNote(g.pitch);
      }
      props.onGesture(
        next.sort((a, b) => a.start - b.start),
        "commit",
      );
    } else if (g.mode !== "select" && g.mode !== "boundary-start" && g.mode !== "boundary-end") {
      props.onGesture(null, "commit");
      if (g.mode === "move" && g.selected) {
        const pos = position(event);
        const offset = Math.round((pos.beat - g.beat) / unit()) * unit();
        props.onSelection({
          start: clamp(g.selected.start + offset, 0, props.song.beatsPerBar),
          end: clamp(g.selected.end + offset, 0, props.song.beatsPerBar),
        });
      }
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const contextNotes = createMemo(() =>
    props.song.channels.flatMap((other, channelIndex) => {
      if (other.kind !== "track" || other.id === props.channel.id) {
        return [];
      }
      const rowCount = other.octaves * 12 + 1;
      const top = trackOctave(other) * 12 + rowCount - 1;
      const height = size().height / rowCount;
      const pitchToY = (pitch: number): number => (top - pitch + 0.5) * height;
      return (other.patterns[other.cells[props.bar] ?? 0]?.notes ?? []).map((note) => ({
        note,
        color: colorsForChannel(channelIndex).secondary,
        pitchToY,
        height,
      }));
    }),
  );
  const background = (): JSX.Element[] =>
    Array.from({ length: props.song.beatsPerBar }, (_, beat) =>
      Array.from({ length: rows() }, (_row, i) => {
        const pitch = bottom() + rows() - 1 - i;
        if (!props.scale.includes(pitch % 12)) {
          return null;
        }
        let fill = "var(--pitch-background)";
        if (pitch % 12 === 0) {
          fill = "var(--tonic-background)";
        }
        if (pitch % 12 === 7) {
          fill = "var(--fifth-background)";
        }
        return (
          <rect
            x={x(beat) + 1}
            y={i * rowHeight() + 1}
            width={Math.max(0, x(1) - 2)}
            height={Math.max(0, rowHeight() - 2)}
            fill={fill}
          />
        );
      }),
    )
      .flat()
      .filter((element): element is JSX.Element => element !== null);
  const ribbon = (
    note: Note,
    pitch: number,
    context: boolean,
    color = colors().secondary,
    pitchToY = y,
    height = rowHeight(),
  ): JSX.Element => {
    return (
      <g>
        {!context && (
          <path
            d={notePath(
              note,
              pitch,
              size().width / props.song.beatsPerBar,
              pitchToY,
              height / 2 + 1,
              false,
            )}
            fill={colors().secondary}
          />
        )}
        <path
          d={notePath(
            note,
            pitch,
            size().width / props.song.beatsPerBar,
            pitchToY,
            context ? height * 0.19 : height / 2 + 1,
            !context,
          )}
          fill={context ? color : colors().note}
          class={context ? "context-note" : "note"}
          data-testid={context ? "context-note" : "note"}
        />
        {note.start === 0 && note.continues === true && (
          <path
            d={`M 2 ${pitchToY(pitch)} h 9 m -4 -3 l 4 3 -4 3`}
            stroke={context ? color : "var(--background, #111)"}
            stroke-width={1.5}
            fill="none"
            data-testid={context ? undefined : "tie-over"}
          >
            <title>Tied from previous bar</title>
          </path>
        )}
      </g>
    );
  };
  return (
    <section class="pattern-region" aria-label="Pattern editor">
      <header
        class="pattern-header"
        aria-label={`${props.channel.name}, Bar ${props.bar + 1}, Pattern ${props.channel.cells[props.bar]}`}
      >
        <span>
          {props.channel.name} · Bar {props.bar + 1} · Pattern {props.channel.cells[props.bar]}
        </span>
        <span>
          <button
            type="button"
            class="control small"
            disabled={props.disabled || octaves() >= 9}
            onClick={() => {
              props.onZoom(octaves() + 1);
            }}
            aria-label="Zoom out"
            title="Show more pitches in the note editor"
          >
            <Icon name="zoom-out" />
          </button>
          <button
            type="button"
            class="control small"
            disabled={props.disabled || octaves() <= 1}
            onClick={() => {
              props.onZoom(octaves() - 1);
            }}
            aria-label="Zoom in"
            title="Show larger notes over fewer pitches"
          >
            <Icon name="zoom-in" />
          </button>
        </span>
      </header>
      <div class={`note-editor ${pianoFollowsPattern() ? "piano-aligned" : ""}`}>
        <div
          class="piano"
          style={
            pianoFollowsPattern()
              ? { left: `${Math.max(0, (size().available - patternWidth()) / 2 - 32)}px` }
              : undefined
          }
          aria-label="Piano keyboard"
          onPointerMove={(event) => {
            if (heldPiano === null) {
              return;
            }
            const bounds = event.currentTarget.getBoundingClientRect();
            const pitch = snapPitch(
              clamp(
                bottom() +
                  rows() -
                  1 -
                  Math.floor(((event.clientY - bounds.top) / bounds.height) * rows()),
                bottom(),
                bottom() + rows() - 1,
              ),
            );
            if (pitch !== heldPiano) {
              props.onAudition(null);
              heldPiano = pitch;
              setAudiblePitch(pitch);
              props.onAudition(pitch);
            }
          }}
        >
          {Array.from({ length: rows() }, (_, i) => bottom() + rows() - 1 - i).map((pitch) => (
            <button
              type="button"
              tabIndex={-1}
              disabled={props.disabled}
              class={`piano-key ${!props.scale.includes(pitch % 12) ? "excluded" : ""} ${audiblePitch() === pitch ? "auditioning" : ""} ${[1, 3, 6, 8, 10].includes((pitch + props.song.key) % 12) ? "black" : ""} ${pitch % 12 === 0 ? "tonic" : ""}`}
              aria-label={`Play ${rowNames[(pitch + props.song.key) % 12]} ${Math.floor((pitch + props.song.key) / 12)}`}
              title="Preview this pitch with the selected instrument"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                const played = snapPitch(pitch);
                heldPiano = played;
                setAudiblePitch(played);
                props.onAudition(played);
              }}
              onPointerUp={() => {
                heldPiano = null;
                setAudiblePitch(null);
                props.onAudition(null);
              }}
              onPointerCancel={() => {
                heldPiano = null;
                setAudiblePitch(null);
                props.onAudition(null);
              }}
            >
              {rowNames[(pitch + props.song.key) % 12]}
              {pitch % 12 === 0 ? Math.floor(pitch / 12) : ""}
            </button>
          ))}
        </div>
        <div class="pattern-canvases">
          <svg
            style={{ width: `${patternWidth()}px` }}
            class="adjacent-preview"
            aria-label="Previous bar preview"
            viewBox={`0 0 ${size().width} ${size().height}`}
            preserveAspectRatio="none"
          >
            {background()}
            {(props.channel.patterns[props.channel.cells[props.bar - 1] ?? 0]?.notes ?? []).flatMap(
              (n) => n.pitches.map((p) => ribbon(n, p, true)),
            )}
          </svg>
          <svg
            ref={(element) => {
              surface = element;
            }}
            style={{ width: `${patternWidth()}px` }}
            role="grid"
            aria-label="Note grid"
            data-testid="note-grid"
            class={`note-grid ${props.disabled ? "disabled" : ""}`}
            viewBox={`0 0 ${size().width} ${size().height}`}
            preserveAspectRatio="none"
            onPointerDown={down}
            onPointerMove={update}
            onPointerUp={up}
            onPointerCancel={() => {
              gesture = null;
              setDragPreview(null);
              props.onGesture(null, "cancel");
            }}
            onPointerLeave={() => {
              setHover(null);
              props.onPointerBeat(null);
            }}
          >
            {background()}
            {contextNotes().flatMap(({ note, color, pitchToY, height }) =>
              note.pitches.map((pitch) => ribbon(note, pitch, true, color, pitchToY, height)),
            )}
            {notes().flatMap((n) => n.pitches.map((p) => ribbon(n, p, false)))}
            {props.selection ? (
              <rect
                class="time-selection"
                x={x(props.selection.start)}
                y={0}
                width={x(props.selection.end - props.selection.start)}
                height={size().height}
              />
            ) : null}
            {hover() && !props.disabled && !dragPreview() ? (
              <path
                class="note-hover"
                d={((): string => {
                  const point = hover();
                  if (!point) {
                    return "";
                  }
                  const existing = notes().find(
                    (note) => note.start <= point.beat && note.end > point.beat,
                  );
                  const range = insertionRange(
                    point.beat,
                    template(),
                    props.song.rhythm,
                    props.song.beatsPerBar,
                    notes(),
                  );
                  const preview = existing ?? {
                    id: "preview",
                    ...range,
                    pitches: [point.pitch],
                    pins: [
                      { time: 0, interval: 0, volume: 3 },
                      { time: range.end - range.start, interval: 0, volume: 3 },
                    ],
                  };
                  return notePath(
                    preview,
                    point.pitch,
                    size().width / props.song.beatsPerBar,
                    y,
                    rowHeight() / 2 + 1,
                    true,
                  );
                })()}
              />
            ) : null}
            {dragPreview() ? (
              <path
                d={((): string => {
                  const preview = dragPreview();
                  if (!preview) {
                    return "";
                  }
                  const atX = x(preview.time);
                  const atY = y(preview.pitch);
                  const radius = ((rowHeight() / 2) * preview.volume) / 3;
                  return `M ${atX} ${atY - radius} v -60 M ${atX} ${atY + radius} v 60 M ${atX - 80} ${atY - radius} h 160 M ${atX - 80} ${atY + radius} h 160`;
                })()}
                fill="none"
                stroke="var(--editor-preview)"
                stroke-width={1}
                pointer-events="none"
              />
            ) : null}
            {props.playhead !== null && (
              <line ref={playhead} class="playhead" x1={0} x2={0} y1={0} y2={size().height} />
            )}
          </svg>
          <svg
            style={{ width: `${patternWidth()}px` }}
            class="adjacent-preview"
            aria-label="Next bar preview"
            viewBox={`0 0 ${size().width} ${size().height}`}
            preserveAspectRatio="none"
          >
            {background()}
            {(props.channel.patterns[props.channel.cells[props.bar + 1] ?? 0]?.notes ?? []).flatMap(
              (n) => n.pitches.map((p) => ribbon(n, p, true)),
            )}
          </svg>
        </div>
        <div class="octave-scroll">
          <input
            type="range"
            class="graph-input"
            min={0}
            max={9 - octaves()}
            value={octave()}
            disabled={props.disabled}
            onInput={(event) => {
              props.onOctave(Number(event.currentTarget.value));
            }}
            title="Show higher or lower pitches in the note editor"
            tabIndex={0}
            aria-label="Octave"
            aria-valuemin={0}
            aria-valuemax={9 - octaves()}
            aria-valuenow={octave()}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                props.onOctave(
                  clamp(octave() + (event.key === "ArrowUp" ? 1 : -1), 0, 9 - octaves()),
                );
              }
            }}
            onPointerDown={(event) => {
              if (props.disabled) {
                return;
              }
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              const bounds = event.currentTarget.getBoundingClientRect();
              const at = ((event.clientY - bounds.top) / bounds.height) * 481;
              const top = (9 - octave() - octaves()) * 53;
              octaveGesture = {
                trackId: props.channel.id,
                y: at,
                octave: octave(),
                dragging: at >= top && at <= top + octaves() * 53 + 4,
              };
            }}
            onPointerMove={(event) => {
              const active = octaveGesture;
              if (active?.dragging !== true) {
                return;
              }
              const bounds = event.currentTarget.getBoundingClientRect();
              const at = ((event.clientY - bounds.top) / bounds.height) * 481;
              const delta = Math.round((active.y - at) / 53);
              setOctavePreview({
                trackId: active.trackId,
                value: clamp(active.octave + delta, 0, 9 - octaves()),
              });
            }}
            onPointerUp={() => {
              const active = octaveGesture;
              const preview = octave();
              octaveGesture = null;
              setOctavePreview(null);
              if (active?.trackId !== props.channel.id) {
                return;
              }
              if (active.dragging) {
                props.onOctave(preview);
              } else {
                const top = (9 - active.octave - octaves()) * 53;
                const delta = active.y < top ? 1 : -1;
                props.onOctave(clamp(active.octave + delta, 0, 9 - octaves()));
              }
            }}
            onPointerCancel={() => {
              octaveGesture = null;
              setOctavePreview(null);
            }}
          />
          <svg
            class="octave-drawing"
            viewBox="0 0 20 481"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <rect
              x={2}
              y={(9 - octave() - octaves()) * 53}
              width={16}
              height={octaves() * 53 + 4}
              fill="var(--graph-fill)"
            />
            {Array.from({ length: 10 }, (_, i) => (
              <rect x={0} y={i * 53} width={20} height={4} fill="var(--tonic-background)" />
            ))}
          </svg>
        </div>
      </div>
    </section>
  );
};
