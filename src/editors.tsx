import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  splitProps,
  useContext,
} from "solid-js";
import type { Accessor, ComponentProps, JSX } from "solid-js";

import { Icon } from "./icons";
import type { FilterPoint } from "./instruments";

export const Setting = (props: {
  readonly label: string;
  readonly tooltip: string;
  readonly children: JSX.Element;
}): JSX.Element => (
  <div class="setting-row" title={props.tooltip}>
    <label title={props.tooltip}>{props.label}</label>
    <div class="setting-control">{props.children}</div>
  </div>
);

// Native buttons keep the drawing surfaces focusable and keyboard operable.
export const GraphControl = (
  props: ComponentProps<"button"> & {
    readonly viewBox: string;
  },
): JSX.Element => {
  const [local, button] = splitProps(props, ["viewBox", "children"]);
  return (
    <button {...button} type="button">
      <svg viewBox={local.viewBox} preserveAspectRatio="none" aria-hidden="true">
        {local.children}
      </svg>
    </button>
  );
};
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
export const selectValueRef =
  (
    value: Accessor<number | string>,
    options: Accessor<unknown>,
  ): ((element: HTMLSelectElement) => void) =>
  (element) => {
    // Replacing options can reset the native selection even if the model value stays the same.
    createEffect(
      on([value, options], ([selected]) => {
        element.value = String(selected);
      }),
    );
  };
export const SelectWrap = (props: {
  readonly children: JSX.Element;
  readonly class?: string;
}): JSX.Element => (
  <div class={props.class === undefined ? "select-wrap" : `select-wrap ${props.class}`}>
    {props.children}
    <span class="arrow">
      <Icon name="chevron-down" />
    </span>
  </div>
);
export const SelectControl = (props: {
  readonly label: string;
  readonly tooltip: string;
  readonly value: string;
  readonly options: ReadonlyArray<
    | string
    | {
        label: string;
        value: string;
      }
  >;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}): JSX.Element => {
  const id = createUniqueId();
  return (
    <div class="setting-row" title={props.tooltip}>
      <label for={id} title={props.tooltip}>
        {props.label}
      </label>
      <SelectWrap>
        <select
          class="control"
          id={id}
          ref={selectValueRef(
            () => props.value,
            () => props.options,
          )}
          disabled={props.disabled ?? false}
          onInput={(event) => {
            props.onChange(event.currentTarget.value);
            event.currentTarget.value = props.value;
          }}
        >
          {props.options.map((option) =>
            typeof option === "string" ? (
              <option value={option} selected={option === props.value}>
                {option}
              </option>
            ) : (
              <option value={option.value} selected={option.value === props.value}>
                {option.label}
              </option>
            ),
          )}
        </select>
      </SelectWrap>
    </div>
  );
};
export const NumericControl = (props: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit?: string;
  readonly onChange: (value: number) => void;
  readonly onPreview?: (value: number | null) => void;
  readonly disabled?: boolean;
  readonly tooltip: string;
}): JSX.Element => {
  const id = createUniqueId();
  const [draft, setDraft] = createSignal<number | null>(null);
  const shown = createMemo(() => draft() ?? props.value);
  return (
    <div class="setting-row" title={props.tooltip}>
      <label for={id} title={props.tooltip}>
        {props.label}
        {(props.unit ?? "") ? <span class="unit"> {props.unit ?? ""}</span> : null}
      </label>
      <div class="range-number">
        <input
          type="range"
          aria-label={`${props.label} slider`}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={clamp(shown(), props.min, props.max)}
          disabled={props.disabled ?? false}
          onInput={(event) => {
            const next = Number(event.currentTarget.value);
            setDraft(next);
            props.onPreview?.(next);
          }}
          onPointerCancel={() => {
            setDraft(null);
            props.onPreview?.(null);
          }}
          onPointerUp={(event) => {
            props.onChange(Number(event.currentTarget.value));
            setDraft(null);
          }}
          onKeyUp={(event) => {
            props.onChange(Number(event.currentTarget.value));
            setDraft(null);
          }}
        />
        <input
          class="control numeric"
          id={id}
          type="number"
          min={Number.isFinite(props.min) ? props.min : undefined}
          max={Number.isFinite(props.max) ? props.max : undefined}
          step={props.step ?? 1}
          value={Number.isFinite(shown()) ? shown() : String(shown())}
          disabled={props.disabled ?? false}
          onInput={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (Number.isFinite(next)) {
              props.onChange(clamp(next, props.min, props.max));
            }
          }}
        />
      </div>
    </div>
  );
};
export const ToggleControl = (props: {
  readonly label: string;
  readonly tooltip: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}): JSX.Element => (
  <label class="setting-row" title={props.tooltip}>
    <span>{props.label}</span>
    <input
      class="switch"
      type="checkbox"
      role="switch"
      checked={props.value}
      aria-checked={props.value}
      onInput={(event) => {
        props.onChange(event.currentTarget.checked);
      }}
    />
  </label>
);
// Harmonics has 28 strengths with the final position controlling the high-frequency tail.
// Custom chip waves draw a repeating cycle of 64 integer samples from -24 to 24.
// Strokes interpolate skipped positions and commit as one reversible gesture.
export const DrawingLock = createContext<{
  acquire: () => Promise<(() => void) | null>;
  interrupted: () => boolean;
}>();

export const DrawingEditor = (props: {
  readonly label: string;
  readonly tooltip?: string;
  readonly values: number[];
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly mode?: "bars" | "curve" | "wave";
  readonly onChange: (values: number[]) => void;
  readonly onPreview: (values: number[] | null) => void;
  readonly enlarged?: boolean;
}): JSX.Element => {
  const [draft, setDraft] = createSignal<number[] | null>(null);
  const [expanded, setExpanded] = createSignal(false);
  let graph: HTMLButtonElement | null = null;
  const locking = useContext(DrawingLock);
  let release: (() => void) | null = null;
  let disposed = false;
  const [acquiring, setAcquiring] = createSignal(false);
  const openExpanded = async (): Promise<void> => {
    if (acquiring()) {
      return;
    }
    if (locking) {
      setAcquiring(true);
      const lock = await locking.acquire();
      setAcquiring(false);
      if (!lock || disposed || locking.interrupted()) {
        lock?.();
        return;
      }
      release = lock;
    }
    setExpanded(true);
  };
  onCleanup(() => {
    disposed = true;
    release?.();
  });
  const closeExpanded = (): void => {
    setExpanded(false);
    release?.();
    release = null;
    props.onPreview(null);
    graph?.focus();
  };
  createEffect(() => {
    if (locking?.interrupted() === true && expanded()) {
      closeExpanded();
    }
  });
  const [selected, setSelected] = createSignal(0);
  let gesture: {
    values: number[];
    index: number;
    value: number;
  } | null = null;
  const shown = createMemo(() => draft() ?? props.values);
  const spectral = createMemo(
    () => (props.mode ?? "bars") === "bars" || (props.mode ?? "bars") === "curve",
  );
  const help = createMemo(
    () =>
      props.tooltip ?? (spectral() ? "Shape the brightness and texture" : "Draw the tone's shape"),
  );
  const width = createMemo(() => (spectral() ? 120 : 320));
  const height = createMemo(() => (spectral() ? 26 : 76));
  const spectrumX = (index: number): number => ((index + 1) * width()) / (shown().length + 2);
  const harmonicX = (index: number): number =>
    ((index + 0.5) * (width() - 8)) / (shown().length - 1);
  const x = (index: number): number => (index / Math.max(1, shown().length - 1)) * width();
  const y = (value: number): number =>
    height() -
    ((value - (props.min ?? 0)) / ((props.max ?? 1) - (props.min ?? 0))) *
      ((props.mode ?? "bars") === "curve" ? height() - 1 : height());
  const lastValue = createMemo(() => shown().at(-1) ?? 0);
  const lastHeight = createMemo(() => y(lastValue()));
  const spectrumPath = createMemo(() => {
    let path = `M 0 ${height()} `;
    shown().forEach((value, index) => {
      path += `${value !== 0 || (shown()[index - 1] ?? 0) !== 0 ? "L" : "M"} ${spectrumX(index)} ${y(value)} `;
    });
    if (lastValue() > 0) {
      path += `L ${width() - 1} ${lastHeight()} `;
    }
    return path;
  });
  const position = (
    event: PointerEvent & {
      currentTarget: HTMLButtonElement;
    },
  ): {
    index: number;
    value: number;
  } => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - bounds.left) / bounds.width;
    let column = clamp(ratio, 0, 1) * (props.values.length - 1);
    if ((props.mode ?? "bars") === "curve") {
      column = ratio * (props.values.length + 2) - 1;
    }
    if ((props.mode ?? "bars") === "bars") {
      column = (ratio * width() * (props.values.length - 1)) / (width() - 8) - 0.5;
    }
    const index = Math.round(column);
    const boundedIndex = clamp(index, 0, props.values.length - 1);
    const localY = ((event.clientY - bounds.top) / bounds.height) * height();
    let value =
      (props.max ?? 1) -
      clamp(
        (props.mode ?? "bars") === "curve" ? (localY - 1) / (height() - 2) : localY / height(),
        0,
        1,
      ) *
        ((props.max ?? 1) - (props.min ?? 0));
    if (spectral()) {
      value = Math.round(value * 7) / 7;
    }
    if (props.integer ?? false) {
      value = Math.round(value);
    }
    return { index: boundedIndex, value };
  };
  const paint = (
    event: PointerEvent & {
      currentTarget: HTMLButtonElement;
    },
  ): void => {
    const active = gesture;
    if (!active) {
      return;
    }
    const next = position(event);
    const distance = Math.abs(next.index - active.index);
    for (let i = 0; i <= distance; i++) {
      const index = active.index + Math.sign(next.index - active.index) * i;
      const value =
        active.value + (next.value - active.value) * (distance === 0 ? 1 : i / distance);
      active.values[index] = value;
      if (props.integer ?? false) {
        active.values[index] = Math.round(value);
      }
      if (spectral()) {
        active.values[index] = Math.round(value * 7) / 7;
      }
    }
    active.index = next.index;
    active.value = next.value;
    setSelected(next.index);
    setDraft([...active.values]);
    props.onPreview([...active.values]);
  };
  const finish = (): void => {
    if (!gesture) {
      return;
    }
    props.onChange([...gesture.values]);
    gesture = null;
    setDraft(null);
  };
  return (
    <div
      class={`drawing-editor ${spectral() ? "spectral-editor" : ""} ${(props.enlarged ?? false) ? "enlarged" : ""}`}
      title={help()}
    >
      <div class="graph-heading">
        <span title={help()}>{props.label}</span>
        {!(props.enlarged ?? false) && (
          <button
            type="button"
            class="icon-button"
            aria-label={`Enlarge ${props.label}`}
            title="Open a larger sound editor"
            onClick={() => {
              void openExpanded();
            }}
          >
            <Icon name="arrows-maximize" />
          </button>
        )}
      </div>
      <GraphControl
        ref={(element) => {
          graph = element;
        }}
        class="mini-graph"
        aria-label={props.label}
        viewBox={`0 0 ${width()} ${height()}`}
        style={{
          "touch-action": "none",
          height: `${(props.enlarged ?? false) ? 220 : height()}px`,
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const at = position(event);
          gesture = { values: [...props.values], index: at.index, value: at.value };
          paint(event);
        }}
        onPointerMove={paint}
        onPointerUp={finish}
        onPointerCancel={() => {
          gesture = null;
          setDraft(null);
          props.onPreview(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setSelected(
              clamp(selected() + (event.key === "ArrowLeft" ? -1 : 1), 0, props.values.length - 1),
            );
          } else if (
            event.key === "ArrowUp" ||
            event.key === "ArrowDown" ||
            event.key === "Delete" ||
            event.key === "Backspace"
          ) {
            event.preventDefault();
            const next = [...props.values];
            next[selected()] =
              event.key === "Delete" || event.key === "Backspace"
                ? 0
                : clamp(
                    (next[selected()] ?? 0) +
                      (event.key === "ArrowUp" ? 1 : -1) *
                        ((props.integer ?? false) ? 1 : ((props.max ?? 1) - (props.min ?? 0)) / 24),
                    props.min ?? 0,
                    props.max ?? 1,
                  );
            props.onChange(next);
          }
        }}
      >
        {(props.mode ?? "bars") === "curve" && (
          <>
            <path
              d={`${spectrumPath()}L ${width()} ${lastHeight()} L ${width()} ${height()} L 0 ${height()} z`}
              fill="var(--graph-fill)"
            />
            {Array.from({ length: 5 }, (_, i) => (
              <rect
                x={((i * 7 + 1) * width()) / (shown().length + 2) - 1}
                y={0}
                width={2}
                height={height()}
                fill="var(--tonic-background)"
              />
            ))}
            <path d={spectrumPath()} fill="none" stroke="currentColor" stroke-width={2} />
            {lastValue() > 0 && (
              <path
                d={`M ${width()} ${lastHeight()} L ${width() - 4} ${lastHeight() - 4} L ${width() - 4} ${lastHeight() + 4} z`}
                fill="currentColor"
              />
            )}
          </>
        )}
        {(props.mode ?? "bars") === "bars" && (
          <>
            {[1, 2, 4, 8, 16]
              .filter((value) => value <= shown().length)
              .map((value) => (
                <rect
                  x={harmonicX(value - 1) - 1}
                  y={0}
                  width={2}
                  height={height()}
                  fill="var(--tonic-background)"
                />
              ))}
            {shown()
              .slice(0, -1)
              .map((value, index) =>
                value > 0 ? (
                  <line
                    x1={harmonicX(index)}
                    x2={harmonicX(index)}
                    y1={height()}
                    y2={y(value)}
                    stroke="currentColor"
                    stroke-width={2}
                  />
                ) : null,
              )}
            {[0, 1, 2, 3].map((index) => (
              <rect
                x={width() - index * 2 - 1}
                y={lastHeight()}
                width={1}
                height={height() - lastHeight()}
                fill="currentColor"
              />
            ))}
          </>
        )}
        {(props.mode ?? "bars") === "wave" && (
          <>
            <polyline
              points={shown()
                .map((value, index) => `${x(index)},${y(value)}`)
                .join(" ")}
              fill="none"
              stroke="#b396f3"
              stroke-width={2}
            />
          </>
        )}
      </GraphControl>
      {expanded() ? (
        <div
          class="modal-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              closeExpanded();
            }
          }}
        >
          <dialog
            open
            class="dialog"
            aria-modal="true"
            aria-label={`${props.label} editor`}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeExpanded();
              }
              if (event.key === "Tab") {
                const controls = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>('button,[tabindex="0"]'),
                );
                const [first] = controls;
                const last = controls.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <h2>{props.label}</h2>
            <DrawingEditor
              {...{
                label: props.label,
                tooltip: help(),
                values: props.values,
                min: props.min ?? 0,
                max: props.max ?? 1,
                integer: props.integer ?? false,
                mode: props.mode ?? "bars",
                onChange: props.onChange,
                onPreview: props.onPreview,
              }}
              enlarged
            />
            <button
              type="button"
              class="control accent"
              title="Return to the instrument editor"
              autofocus
              onClick={closeExpanded}
            >
              <Icon name="x" leading />
              Close
            </button>
          </dialog>
        </div>
      ) : null}
    </div>
  );
};
// Each EQ effect owns a graph with up to eight distinct frequency slots.
// Drag horizontally for frequency and vertically for gain; dragging out horizontally deletes.
// Mouse click deletes a point; touch tap selects it. Each gesture is one undo step.
export const FilterEditor = (props: {
  readonly points: FilterPoint[];
  readonly onChange: (points: FilterPoint[]) => void;
  readonly onPreview: (points: FilterPoint[] | null) => void;
}): JSX.Element => {
  const [draft, setDraft] = createSignal<FilterPoint[] | null>(null);
  let drag: {
    points: FilterPoint[];
    id: string;
    x: number;
    y: number;
    existing: boolean;
    moved: boolean;
    touch: boolean;
  } | null = null;
  const [selected, setSelected] = createSignal("");
  const shown = createMemo(() => draft() ?? props.points);
  const frequencyX = (frequency: number): number =>
    ((Math.log2(frequency / 62.5) * 4 + 0.5) / 34) * 120;
  const gainY = (gain: number): number => 0.5 + (1 - (gain + 24) / 48) * 25;
  const pointer = (
    event: PointerEvent & {
      currentTarget: HTMLButtonElement;
    },
  ): {
    x: number;
    y: number;
  } => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * 120,
      y: ((event.clientY - box.top) / box.height) * 26,
    };
  };
  // Plot the cascaded biquad response, rather than connecting control-point gains.
  const response = createMemo(() =>
    Array.from({ length: 36 }, (_, index) => {
      const frequency = 62.5 * 2 ** ((index - 1) / 4);
      const omega = (Math.PI * 2 * frequency) / 44_100;
      let magnitude = 1;
      for (const point of shown()) {
        const angle = (Math.PI * 2 * Math.min(20_000, point.frequency)) / 44_100;
        const cos = Math.cos(angle);
        const alpha = Math.sin(angle) / (2 * Math.SQRT1_2);
        const a = 10 ** (point.gain / 40);
        let b0 = 1 + alpha * a;
        let b1 = -2 * cos;
        let b2 = 1 - alpha * a;
        let a0 = 1 + alpha / a;
        const a1 = -2 * cos;
        let a2 = 1 - alpha / a;
        if (point.type !== "peaking") {
          a0 = 1 + alpha;
          a2 = 1 - alpha;
          b0 = (1 - cos) / 2;
          b1 = 1 - cos;
          b2 = b0;
          if (point.type === "highpass") {
            b0 = (1 + cos) / 2;
            b1 = -(1 + cos);
            b2 = b0;
          }
        }
        const real = b0 + b1 * Math.cos(omega) + b2 * Math.cos(2 * omega);
        const imag = -b1 * Math.sin(omega) - b2 * Math.sin(2 * omega);
        const denominatorReal = a0 + a1 * Math.cos(omega) + a2 * Math.cos(2 * omega);
        const denominatorImag = -a1 * Math.sin(omega) - a2 * Math.sin(2 * omega);
        magnitude *= Math.sqrt(
          (real * real + imag * imag) /
            (denominatorReal * denominatorReal + denominatorImag * denominatorImag),
        );
      }
      return `${((index - 0.5) / 34) * 120},${gainY(20 * Math.log10(Math.max(1e-8, magnitude)))}`;
    }).join(" "),
  );
  const move = (
    event: PointerEvent & {
      currentTarget: HTMLButtonElement;
    },
  ): void => {
    const active = drag;
    if (!active) {
      return;
    }
    const at = pointer(event);
    if (Math.abs(at.x - active.x) + Math.abs(at.y - active.y) > 4) {
      active.moved = true;
    }
    let slot = Math.round(Math.max(0, Math.min(33, (at.x / 120) * 34 - 0.5)));
    const occupied = new Set(
      active.points
        .filter((point) => point.id !== active.id)
        .map((point) => Math.round(Math.log2(point.frequency / 62.5) * 4)),
    );
    if (occupied.has(slot)) {
      const [free] = Array.from({ length: 34 }, (_, index) => index)
        .filter((index) => !occupied.has(index))
        .sort((a, b) => Math.abs(a - slot) - Math.abs(b - slot));
      if (free !== undefined) {
        slot = free;
      }
    }
    const point = active.points.find((item) => item.id === active.id);
    if (point) {
      point.frequency = 62.5 * 2 ** (slot / 4);
      point.gain = clamp((1 - (at.y - 0.5) / 25) * 48 - 24, -24, 24);
    }
    const preview =
      at.x < -2 || at.x > 122
        ? active.points.filter((item) => item.id !== active.id)
        : [...active.points];
    setDraft(preview);
    props.onPreview(preview);
  };
  return (
    <div class="drawing-editor compact-editor" title="Boost or cut parts of the tone">
      <div class="graph-heading">
        <span title="Boost or cut parts of the tone">EQ Filter</span>
        <span class="hint">
          {shown().some((point) => point.id === selected())
            ? `${Math.round(shown().find((point) => point.id === selected())?.frequency ?? 0)} Hz`
            : `${shown().length}/8 points`}
        </span>
      </div>
      <GraphControl
        class="mini-graph"
        aria-label="EQ Filter graph"
        viewBox="0 0 120 26"
        style={{ height: "26px", "touch-action": "none" }}
        onKeyDown={(event) => {
          if (event.key === "Delete" && selected()) {
            props.onChange(props.points.filter((point) => point.id !== selected()));
          }
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const at = pointer(event);
          const [nearby] = [...props.points].sort(
            (a, b) =>
              Math.abs(frequencyX(a.frequency) - at.x) - Math.abs(frequencyX(b.frequency) - at.x),
          );
          const existing =
            nearby !== undefined && Math.abs(frequencyX(nearby.frequency) - at.x) < 4;
          const next = structuredClone(props.points);
          let point = existing ? next.find((item) => item.id === nearby.id) : undefined;
          if (!point && next.length < 8) {
            point = {
              id: crypto.randomUUID(),
              type: at.x < 24 ? "highpass" : "peaking",
              frequency: 1000,
              gain: 0,
            };
            if (at.x > 96) {
              point.type = "lowpass";
            }
            next.push(point);
          }
          if (!point) {
            return;
          }
          setSelected(point.id);
          drag = {
            points: next,
            id: point.id,
            x: at.x,
            y: at.y,
            existing,
            moved: false,
            touch: event.pointerType !== "mouse",
          };
          move(event);
        }}
        onPointerMove={move}
        onPointerUp={() => {
          const active = drag;
          if (!active) {
            return;
          }
          props.onChange(
            active.existing && !active.moved && !active.touch
              ? active.points.filter((point) => point.id !== active.id)
              : (draft() ?? active.points),
          );
          drag = null;
          setDraft(null);
        }}
        onPointerCancel={() => {
          drag = null;
          setDraft(null);
          props.onPreview(null);
        }}
      >
        <path
          d={`M 0 26 L ${response().replaceAll(",", " ")} L 120 26 L 0 26 z`}
          fill="var(--graph-fill)"
        />
        <line x1={0} x2={120} y1={13} y2={13} stroke="currentColor" stroke-dasharray="3 2" />
        {shown().map((point, index) => (
          <g>
            <circle
              cx={frequencyX(point.frequency)}
              cy={gainY(point.gain)}
              r={2}
              fill={point.id === selected() ? "var(--editor-preview)" : "currentColor"}
            />
            <text
              x={frequencyX(point.frequency)}
              y={Math.max(6, gainY(point.gain) - 3)}
              fill="#e3d2ff"
              text-anchor="middle"
              font-size="5"
            >
              {index + 1}
            </text>
          </g>
        ))}
      </GraphControl>
    </div>
  );
};
// The fade graph edits attack on the left and ending on the right, retaining the chosen handle.
// Endings can fade before note end or release afterward; each gesture is one undo step.
export const FadeEditor = (props: {
  readonly attack: number;
  readonly release: number;
  readonly onChange: (attack: number, release: number) => void;
  readonly onPreview: (
    values: {
      attack: number;
      release: number;
    } | null,
  ) => void;
}): JSX.Element => {
  const [draft, setDraft] = createSignal<{
    attack: number;
    release: number;
  } | null>(null);
  const [handle, setHandle] = createSignal<"attack" | "release">("attack");
  let gesture: "attack" | "release" | null = null;
  const current = createMemo(() => draft() ?? { attack: props.attack, release: props.release });
  const move = (
    event: PointerEvent & {
      currentTarget: HTMLButtonElement;
    },
  ): void => {
    if (!gesture) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    const next =
      gesture === "attack"
        ? { attack: clamp(x / 0.4, 0, 1) ** 3 * 2, release: props.release }
        : { attack: props.attack, release: clamp(Math.round((x - 0.5) * 80) / 20, -0.5, 2) };
    setDraft(next);
    props.onPreview(next);
  };
  const attackX = createMemo(() => (current().attack / 2) ** (1 / 3) * 128);
  const endX = createMemo(() => clamp(160 + current().release * 80, 0, 320));
  const fadeEnd = createMemo(() => (current().release < 0 ? 160 : endX()));
  const fadePath = createMemo(() =>
    Array.from({ length: 65 }, (_, index) => {
      const x = (index / 64) * fadeEnd();
      const rise = attackX() === 0 ? 1 : clamp(x / attackX(), 0, 1);
      const fall =
        current().release === 0 ? 1 : clamp((fadeEnd() - x) / Math.abs(endX() - 160), 0, 1);
      return `L${x} ${58 * (1 - rise * fall)}`;
    }).join(" "),
  );
  return (
    <div class="drawing-editor compact-editor" title="Soften note beginnings and endings">
      <div class="graph-heading">
        <span title="Soften note beginnings and endings">Fade In/Out</span>
        <span class="hint">
          {current().attack.toFixed(3)} s / {current().release.toFixed(2)} beats
        </span>
      </div>
      <GraphControl
        class="mini-graph"
        aria-label="Fade In/Out graph"
        aria-description={`Editing fade ${handle() === "attack" ? "in" : "out"}. Up selects fade in; Down selects fade out; Left and Right adjust. Negative fade out fades before the note ends.`}
        viewBox="0 0 320 58"
        style={{ height: "26px", "touch-action": "none" }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = ((event.clientX - bounds.left) / bounds.width) * 320;
          gesture = Math.abs(x - attackX()) < Math.abs(x - endX()) ? "attack" : "release";
          setHandle(gesture);
          move(event);
        }}
        onPointerMove={move}
        onPointerUp={() => {
          const values = draft();
          if (values) {
            props.onChange(values.attack, values.release);
          }
          gesture = null;
          setDraft(null);
        }}
        onPointerCancel={() => {
          gesture = null;
          setDraft(null);
          props.onPreview(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setHandle(event.key === "ArrowUp" ? "attack" : "release");
          } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const direction = event.key === "ArrowLeft" ? -1 : 1;
            props.onChange(
              handle() === "attack" ? clamp(props.attack + direction * 0.01, 0, 2) : props.attack,
              handle() === "release"
                ? clamp(Math.round(props.release * 20 + direction) / 20, -0.5, 2)
                : props.release,
            );
          }
        }}
      >
        <line x1={160} x2={160} y1={0} y2={58} stroke="#626775" stroke-dasharray="3 2" />
        <path
          d={`M0 58 ${fadePath()} L${fadeEnd()} 58 Z`}
          stroke="#b396f3"
          stroke-width={2}
          fill="var(--graph-fill)"
        />
        <path
          d={`M${attackX()} 0 V58`}
          stroke="#b396f3"
          stroke-width={handle() === "attack" ? 4 : 2}
        />
        <path
          d={`M${endX()} 0 V58`}
          stroke="#b396f3"
          stroke-width={handle() === "release" ? 4 : 2}
        />
      </GraphControl>
    </div>
  );
};
