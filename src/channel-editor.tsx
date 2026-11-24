import type { EditorPresence } from "@slopemp/song/protocol";
// See ../license/README.md for the source of editor geometry and gestures.
import { createEffect, createMemo, createSignal, For, Index } from "solid-js";
import type { JSX } from "solid-js";

import { barWidth, colorsForChannel, loopPath, patternHeight } from "./editor-geometry";
import { selectValueRef } from "./editors";
import { Icon } from "./icons";
import type { Channel, Selection, Song } from "./model";
import { createPlayhead } from "./playhead";
import type { PlayheadSource } from "./playhead";
type Props = {
  readonly song: Song;
  readonly onChannelCount: (kind: "automation" | "track", count: number) => void;
  readonly channel: number;
  readonly bar: number;
  readonly selection: Selection;
  readonly muted: Set<string>;
  readonly playhead: PlayheadSource | null;
  readonly disabled: boolean;
  readonly editors: readonly EditorPresence[];
  readonly localEditor: string | null;
  readonly onSelect: (channel: number, bar: number, extend: boolean) => void;
  readonly onRectangle: (channel: number, bar: number) => void;
  readonly onAssign: (delta: number) => void;
  readonly onMute: (channel: number) => void;
  readonly onLoop: (start: number, end: number, phase: "cancel" | "commit" | "preview") => void;
  readonly onPointerBar: (bar: number | null) => void;
};
type ChannelStyle = JSX.CSSProperties & {
  "--channel-color": string;
  "--channel-dim": string;
};
const groupHeadingHeight = 20;
const channelStyle = (index: number): ChannelStyle => ({
  "--channel-color": colorsForChannel(index).channel,
  "--channel-dim": colorsForChannel(index).dim,
});
const ArrangementRow = (props: {
  readonly channel: Channel;
  readonly index: number;
  readonly activeBar: number;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly muted: boolean;
  readonly disabled: boolean;
  readonly editors: readonly EditorPresence[];
  readonly localEditor: string | null;
}): JSX.Element => (
  <div
    class={`channel-row ${props.channel.kind}`}
    style={channelStyle(props.index)}
    aria-label={props.channel.name}
  >
    <div class={`channel-label ${props.activeBar >= 0 ? "selected" : ""}`}>
      <button
        type="button"
        class="control mute-button toggle-button"
        disabled={props.disabled}
        data-mute={props.index}
        aria-label={`Mute ${props.channel.name}`}
        title={
          props.muted ? "Hear this channel during playback" : "Silence this channel during playback"
        }
        aria-pressed={props.muted}
      >
        <Icon name={props.muted ? "volume-off" : "volume"} />
      </button>
      <span title={props.channel.name}>{props.index + 1}</span>
    </div>
    <Index each={props.channel.cells}>
      {(number, bar) => {
        const nonempty = createMemo(
          () =>
            (props.channel.patterns[number()]?.notes.length ?? 0) +
              (props.channel.patterns[number()]?.lanes.length ?? 0) >
            0,
        );
        return (
          <button
            type="button"
            disabled={props.disabled}
            data-channel={props.index}
            data-bar={bar}
            data-testid={`cell-${props.index}-${bar}`}
            aria-label={`${props.channel.name}, bar ${bar + 1}, pattern ${number()}`}
            aria-pressed={bar >= props.selectionStart && bar <= props.selectionEnd}
            class={`control channel-cell ${props.activeBar === bar ? "current" : ""} ${nonempty() ? "populated" : ""} ${number() === 0 ? "empty" : ""}`}
            title={
              props.channel.kind === "automation"
                ? "Choose the automation pattern for this bar"
                : "Choose the note pattern for this bar"
            }
          >
            {number()}
            <span class="cell-editors">
              <For
                each={props.editors.filter(
                  (editor) =>
                    editor.selection?.channelId === props.channel.id &&
                    editor.selection.bar === bar,
                )}
              >
                {(editor) => (
                  <span
                    class="editor-color"
                    style={{ "background-color": editor.color }}
                    title={
                      editor.id === props.localEditor ? "You" : `Editor ${editor.id.slice(0, 8)}`
                    }
                  />
                )}
              </For>
            </span>
            {props.activeBar === bar && (
              <span class="cell-arrows">
                <Icon name="chevron-up" />
                <Icon name="chevron-down" />
              </span>
            )}
          </button>
        );
      }}
    </Index>
  </div>
);
const pointerCell = (
  event: PointerEvent & {
    currentTarget: HTMLDivElement;
  },
): HTMLButtonElement | null =>
  event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-bar]") : null;
// Cells reference channel-local patterns; zero is empty and reused numbers share note edits.
// Drag selects a rectangle. The loop uses bar boundaries and stays nonempty; dragging its
// halves edits boundaries, while dragging outside moves it. Mutes are temporary listening state.
export const ChannelEditor = (props: Props): JSX.Element => {
  const trackCount = createMemo(
    () => props.song.channels.filter((channel) => channel.kind === "track").length,
  );
  const automationCount = createMemo(() => props.song.channels.length - trackCount());
  const rowTop = (index: number): number =>
    index * patternHeight + groupHeadingHeight + (index >= trackCount() ? groupHeadingHeight : 0);
  const channelAt = (y: number): number =>
    Math.max(
      0,
      Math.min(
        props.song.channels.length - 1,
        Math.floor(
          (y -
            groupHeadingHeight -
            (y >= trackCount() * patternHeight + groupHeadingHeight ? groupHeadingHeight : 0)) /
            patternHeight,
        ),
      ),
    );
  const groupHeader = (kind: "automation" | "track", count: number): JSX.Element => (
    <div class="arrangement-group-heading" style={{ height: `${groupHeadingHeight}px` }}>
      <span>
        {count === 0
          ? `No ${kind === "automation" ? "automations" : "tracks"}`
          : `${count} ${kind === "automation" ? "automation" : "track"}${count === 1 ? "" : "s"}`}
      </span>
      <button
        type="button"
        class="control"
        aria-label={`Add ${kind === "automation" ? "automation" : "track"}`}
        title={
          kind === "automation"
            ? "Add a channel for sound changes over time"
            : "Add a track for another musical part"
        }
        disabled={props.disabled}
        onClick={() => {
          props.onChannelCount(kind, count + 1);
        }}
      >
        <Icon name="plus" />
      </button>
      <button
        type="button"
        class="control"
        aria-label={`Remove ${kind === "automation" ? "automation" : "track"}`}
        title={
          kind === "automation"
            ? "Remove the last automation channel"
            : "Remove the last track and its notes"
        }
        disabled={props.disabled || count <= (kind === "track" ? 1 : 0)}
        onClick={() => {
          props.onChannelCount(kind, count - 1);
        }}
      >
        <Icon name="minus" />
      </button>
    </div>
  );
  const playhead = createPlayhead<HTMLDivElement>(
    () => props.playhead,
    (element, position) => {
      element.style.transform = `translateX(${position * barWidth - 2}px)`;
    },
  );
  let dragging: {
    channel: number;
    bar: number;
    moved: boolean;
    current: boolean;
  } | null = null;
  let loop: {
    mode: "end" | "move" | "start";
    start: number;
    end: number;
    pointer: number;
  } | null = null;
  let scroll: HTMLDivElement | null = null;
  let cells: HTMLDivElement | null = null;
  createEffect(() => {
    const viewport = scroll;
    const cell = cells?.querySelector(`[data-testid="cell-${props.channel}-${props.bar}"]`);
    if (!viewport || !cell) {
      return;
    }
    const bounds = viewport.getBoundingClientRect();
    const target = cell.getBoundingClientRect();
    // Keep the selected bar visible without scrolling the surrounding page.
    viewport.scrollLeft +=
      Math.min(0, target.left - bounds.left - 64) +
      Math.max(0, target.right - bounds.left - viewport.clientWidth);
    viewport.scrollTop +=
      Math.min(0, target.top - bounds.top - 18) +
      Math.max(0, target.bottom - bounds.top - viewport.clientHeight);
  });
  const [loopDragging, setLoopDragging] = createSignal(false);
  const [touch, setTouch] = createSignal(false);
  const [loopHover, setLoopHover] = createSignal<number | null>(null);
  const loopMode = (pos: number): "end" | "move" | "start" => {
    if (pos > props.song.loopStart - 0.25 && pos < props.song.loopEnd + 0.25) {
      return pos - props.song.loopStart < (props.song.loopEnd - props.song.loopStart) / 2
        ? "start"
        : "end";
    }
    return "move";
  };
  const loopPosition = (
    event: PointerEvent & {
      currentTarget: HTMLInputElement;
    },
  ): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(props.song.barCount, (event.clientX - rect.left) / barWidth));
  };
  const previewLoop = (pos: number): void => {
    const gesture = loop;
    if (gesture === null) {
      return;
    }
    if (gesture.mode === "move") {
      const length = gesture.end - gesture.start;
      const start = Math.max(
        0,
        Math.min(props.song.barCount - length, Math.round(pos - length / 2)),
      );
      props.onLoop(start, start + length, "preview");
      return;
    }
    const fixed = gesture.mode === "start" ? gesture.end : gesture.start;
    const original = gesture.mode === "start" ? gesture.start : gesture.end;
    const at = Math.max(
      0,
      Math.min(props.song.barCount, original + Math.round(pos - gesture.pointer)),
    );
    const start = Math.min(at, fixed);
    const end = Math.max(at, fixed);
    if (start === end) {
      if (gesture.mode === "start") {
        props.onLoop(Math.max(0, end - 1), end, "preview");
      } else {
        props.onLoop(start, Math.min(props.song.barCount, start + 1), "preview");
      }
      return;
    }
    props.onLoop(start, end, "preview");
  };
  return (
    <section class="channel-region" aria-label="Channel arrangement">
      <div class="arrangement-shell">
        <div
          class="arrangement-scroll"
          ref={(element) => {
            scroll = element;
          }}
          onPointerUp={() => {
            dragging = null;
          }}
          onPointerLeave={() => {
            dragging = null;
          }}
        >
          <div
            class="arrangement-content"
            style={{ width: `${props.song.barCount * barWidth + 64}px` }}
          >
            <div class="bar-labels">
              {Array.from({ length: props.song.barCount }, (_, bar) => (
                <span>{bar + 1}</span>
              ))}
            </div>
            <div
              class="channel-grid"
              ref={(element) => {
                cells = element;
              }}
              on:click={(event) => {
                const mute =
                  event.target instanceof Element
                    ? event.target.closest<HTMLButtonElement>("[data-mute]")
                    : null;
                if (mute && !props.disabled) {
                  props.onMute(Number(mute.dataset["mute"]));
                }
              }}
              onPointerDown={(event) => {
                const cell = pointerCell(event);
                if (event.button !== 0 || !cell || props.disabled) {
                  return;
                }
                const t = Number(cell.dataset["channel"]);
                const b = Number(cell.dataset["bar"]);
                setTouch(event.pointerType === "touch");
                cell.setPointerCapture(event.pointerId);
                const current = props.channel === t && props.bar === b;
                dragging = { channel: t, bar: b, moved: false, current };
                if (event.shiftKey || !current) {
                  props.onSelect(t, b, event.shiftKey);
                }
              }}
              onPointerUp={(event) => {
                const cell = pointerCell(event);
                const drag = dragging;
                if (
                  cell &&
                  drag &&
                  !drag.moved &&
                  !event.shiftKey &&
                  drag.current &&
                  event.pointerType !== "touch"
                ) {
                  const rect = cell.getBoundingClientRect();
                  props.onAssign(event.clientY - rect.top < rect.height / 2 ? 1 : -1);
                }
                dragging = null;
              }}
              onPointerMove={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                const t = channelAt(event.clientY - bounds.top);
                const b = Math.max(
                  0,
                  Math.min(
                    props.song.barCount - 1,
                    Math.floor((event.clientX - bounds.left - 64) / barWidth),
                  ),
                );
                const hovered = pointerCell(event);
                if (hovered) {
                  hovered.dataset["half"] =
                    (event.clientY - bounds.top - rowTop(t)) % patternHeight < patternHeight / 2
                      ? "upper"
                      : "lower";
                }
                props.onPointerBar(
                  Math.max(
                    0,
                    Math.min(
                      props.song.barCount - 0.0001,
                      (event.clientX - bounds.left - 64) / barWidth,
                    ),
                  ),
                );
                const drag = dragging;
                if (drag && (drag.channel !== t || drag.bar !== b)) {
                  drag.moved = true;
                  drag.channel = t;
                  drag.bar = b;
                  props.onRectangle(t, b);
                }
              }}
              onPointerCancel={() => {
                dragging = null;
              }}
              onPointerLeave={() => {
                if (!dragging) {
                  props.onPointerBar(null);
                }
              }}
            >
              {groupHeader("track", trackCount())}
              <Index each={props.song.channels}>
                {(channel, t) => (
                  <div>
                    {t === trackCount() ? groupHeader("automation", automationCount()) : null}
                    <ArrangementRow
                      channel={channel()}
                      editors={props.editors}
                      localEditor={props.localEditor}
                      index={t}
                      activeBar={props.channel === t ? props.bar : -1}
                      selectionStart={
                        t >= props.selection.channelStart && t <= props.selection.channelEnd
                          ? props.selection.barStart
                          : -1
                      }
                      selectionEnd={
                        t >= props.selection.channelStart && t <= props.selection.channelEnd
                          ? props.selection.barEnd
                          : -1
                      }
                      muted={props.muted.has(channel().id)}
                      disabled={props.disabled}
                    />
                  </div>
                )}
              </Index>
              {automationCount() === 0 ? groupHeader("automation", 0) : null}
              {touch() ? (
                <select
                  class="pattern-select-overlay"
                  aria-label="Choose pattern"
                  title="Pattern played in this bar"
                  ref={selectValueRef(
                    () => props.song.channels[props.channel]?.cells[props.bar] ?? 0,
                    () => props.song.patternCount,
                  )}
                  style={{
                    left: `${props.bar * barWidth + 64}px`,
                    top: `${rowTop(props.channel)}px`,
                    width: `${barWidth}px`,
                    height: `${patternHeight}px`,
                  }}
                  onInput={(event) => {
                    props.onAssign(
                      Number(event.currentTarget.value) -
                        (props.song.channels[props.channel]?.cells[props.bar] ?? 0),
                    );
                  }}
                >
                  {Array.from({ length: props.song.patternCount + 1 }, (_, number) => (
                    <option value={number}>{number}</option>
                  ))}
                </select>
              ) : null}
              {(props.selection.barEnd > props.selection.barStart ||
                props.selection.channelEnd > props.selection.channelStart) && (
                <div
                  class="channel-selection"
                  style={{
                    left: `${props.selection.barStart * barWidth + 65}px`,
                    top: `${rowTop(props.selection.channelStart) + 1}px`,
                    width: `${(props.selection.barEnd - props.selection.barStart + 1) * barWidth - 2}px`,
                    height: `${
                      rowTop(props.selection.channelEnd) -
                      rowTop(props.selection.channelStart) +
                      patternHeight -
                      2
                    }px`,
                  }}
                />
              )}
            </div>
            {props.playhead ? <div ref={playhead} class="channel-playhead" /> : null}
            <div class="loop-strip">
              <input
                type="range"
                class="graph-input"
                min={0}
                max={props.song.barCount - (props.song.loopEnd - props.song.loopStart)}
                value={props.song.loopStart}
                onInput={(event) => {
                  const start = Number(event.currentTarget.value);
                  props.onLoop(start, start + props.song.loopEnd - props.song.loopStart, "preview");
                  props.onLoop(0, 0, "commit");
                }}
                aria-label="Loop region"
                title="Bars to repeat during playback"
                aria-valuetext={`Bars ${props.song.loopStart + 1} to ${props.song.loopEnd}`}
                disabled={props.disabled}
                onPointerDown={(event) => {
                  if (props.disabled) {
                    return;
                  }
                  event.currentTarget.setPointerCapture(event.pointerId);
                  event.preventDefault();
                  const pos = loopPosition(event);
                  const mode = loopMode(pos);
                  setLoopDragging(true);
                  loop = {
                    mode,
                    start: props.song.loopStart,
                    end: props.song.loopEnd,
                    pointer: pos,
                  };
                  previewLoop(pos);
                }}
                onPointerMove={(event) => {
                  const pos = loopPosition(event);
                  setLoopHover(pos);
                  previewLoop(pos);
                }}
                onPointerLeave={() => {
                  setLoopHover(null);
                }}
                onPointerUp={() => {
                  if (loop) {
                    setLoopDragging(false);
                    loop = null;
                    props.onLoop(0, 0, "commit");
                  }
                }}
                onPointerCancel={() => {
                  setLoopDragging(false);
                  loop = null;
                  props.onLoop(0, 0, "cancel");
                }}
              />
              <svg
                class="loop-drawing"
                width={props.song.barCount * barWidth}
                height={20}
                aria-hidden="true"
              >
                <path
                  d={loopPath(props.song.loopStart * barWidth, props.song.loopEnd * barWidth)}
                  fill="color-mix(in srgb, var(--loop-accent) 14%, transparent)"
                  stroke="var(--loop-accent)"
                  stroke-width={2}
                />
                {loopHover() !== null &&
                  !loopDragging() &&
                  ((): JSX.Element => {
                    const hovered = loopHover();
                    if (hovered === null) {
                      return null;
                    }
                    const mode = loopMode(hovered);
                    let start = props.song.loopStart * barWidth;
                    let end = props.song.loopEnd * barWidth;
                    if (mode === "start") {
                      end = start + 20;
                    } else if (mode === "end") {
                      start = end - 20;
                    } else {
                      const length = props.song.loopEnd - props.song.loopStart;
                      start =
                        Math.max(
                          0,
                          Math.min(props.song.barCount - length, Math.round(hovered - length / 2)),
                        ) * barWidth;
                      end = start + length * barWidth;
                    }
                    return <path d={loopPath(start, end, 4)} fill="var(--editor-preview)" />;
                  })()}
              </svg>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
