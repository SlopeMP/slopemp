import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  Index,
  onCleanup,
  Show,
} from "solid-js";
import type { JSX } from "solid-js";

import { getAudioResourceInfo } from "./audio";
import { CategoryBrowser, focusDialogSearch } from "./category-browser";
import type { CategoryItem } from "./category-browser";
import {
  DrawingEditor,
  FadeEditor,
  FilterEditor,
  GraphControl,
  NumericControl,
  NumericInput,
  SelectControl,
  selectValueRef,
  SelectWrap,
  ToggleControl,
} from "./editors";
import {
  effectFilterPoints,
  filterParameters,
  remapFilterParameter,
  setEffectFilterPoints,
} from "./filters";
import { Icon } from "./icons";
import { envelopeTargets, envelopeTypes } from "./instrument-envelopes";
import {
  effectTooltip,
  envelopeTooltips,
  operatorTooltips,
  soundTooltips,
} from "./instrument-tooltips";
import {
  CHIP_WAVES,
  createEffect as createInstrumentEffect,
  createEnvelope,
  createFMOperator,
  createInstrument,
  EFFECT_GROUPS,
  EFFECT_PARAMETERS,
  FM_WAVES,
  INSTRUMENT_TYPES,
  MAX_INSTRUMENT_VOLUME,
  PRESET_GROUPS,
  presetInstrument,
  validFMGraph,
} from "./instruments";
import type { Effect, Envelope, FMOperator, Instrument, SFModulator } from "./instruments";
import type { AutomationLane, AutomationPoint, Channel, Song } from "./model";
import { randomInstrument, randomPreset } from "./random-instruments";
import type { AssetView } from "./resource-identity";
import { resourceCacheKey } from "./resource-identity";
import { noises } from "./synth/noise";

const EffectPicker = (props: { readonly onChoose: (name: string) => void }): JSX.Element => {
  const [open, setOpen] = createSignal(false);
  let dialog: HTMLDialogElement | null = null;
  createEffect(() => {
    if (open() && dialog) {
      dialog.showModal();
      focusDialogSearch(dialog);
    }
  });
  const categories = Object.entries(EFFECT_GROUPS).map(([title, names]) => ({
    title,
    items: names.map((name) => ({
      label: name,
      render: (): JSX.Element => (
        <button
          type="button"
          class="control"
          onClick={() => {
            props.onChoose(name);
          }}
        >
          {name}
        </button>
      ),
    })),
  }));
  return (
    <>
      <button
        type="button"
        class="control"
        aria-label="Add Effect…"
        title="Add another way to shape the sound"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Icon name="plus" />
      </button>
      <Show when={open()}>
        <dialog
          ref={(element) => {
            dialog = element;
          }}
          class="dialog effect-picker"
          aria-label="Add Effect"
          on:close={() => {
            setOpen(false);
          }}
        >
          <div class="dialog-heading">
            <h2>Add Effect</h2>
            <button
              type="button"
              class="icon-button"
              aria-label="Close dialog"
              title="Return to the editor"
              onClick={() => {
                dialog?.close();
              }}
            >
              <Icon name="x" />
            </button>
          </div>
          <CategoryBrowser label="Effect categories" filterTabs categories={categories} />
          <div class="dialog-actions">
            <button
              type="button"
              class="control accent"
              onClick={() => {
                dialog?.close();
              }}
            >
              <Icon name="check" leading />
              Done
            </button>
          </div>
        </dialog>
      </Show>
    </>
  );
};
const uniqueId = (): string => crypto.randomUUID();
type EffectClipboardProps = {
  readonly copiedEffect: Effect | null;
  readonly onCopyEffect: (effect: Effect) => void;
};
type InstrumentPanelProps = EffectClipboardProps & {
  readonly channel: Channel;
  readonly assets: readonly AssetView[];
  readonly selectedInstrument: number;
  readonly onSelectInstrument: (index: number) => void;
  readonly onCopyInstrument: () => void;
  readonly onPasteInstrument: () => void;
  readonly onChange: (channel: Channel) => void;
  readonly onPreview: (channel: Channel | null) => void;
  readonly onAddAssets: () => void;
  readonly onDialogChange: (open: boolean) => void;
};
type AutomationPanelProps = EffectClipboardProps & {
  readonly channel: Channel;
  readonly song: Song;
  readonly bar: number;
  readonly onChange: (channel: Channel) => void;
  readonly onPreview: (channel: Channel | null) => void;
};
type InstrumentRecipe = (recipe: (instrument: Instrument) => void) => void;
type InstrumentPreview = (recipe: ((instrument: Instrument) => void) | null) => void;
type ChannelPreview = (recipe: ((channel: Channel) => void) | null) => void;
const EndpointControl = (props: {
  readonly label: string;
  readonly tooltip: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
}): JSX.Element => {
  const id = createUniqueId();
  const [text, setText] = createSignal(String(props.value));
  const [draft, setDraft] = createSignal<number | null>(null);
  createEffect(() => {
    setText(String(props.value));
  });
  const commit = (): void => {
    const parsed = Number(text().replace("∞", "Infinity"));
    if (!Number.isNaN(parsed)) {
      props.onChange(parsed);
    } else {
      setText(String(props.value));
    }
  };
  return (
    <div class="setting-row" title={props.tooltip}>
      <label for={id} title={props.tooltip}>
        {props.label}
      </label>
      <div class="range-number">
        <input
          type="range"
          aria-label={`${props.label} slider`}
          title={props.tooltip}
          min={props.min ?? -2}
          max={props.max ?? 2}
          step={0.01}
          value={Math.max(props.min ?? -2, Math.min(props.max ?? 2, draft() ?? props.value))}
          onInput={(event) => {
            setDraft(Number(event.target.value));
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
          aria-label={props.label}
          title={props.tooltip}
          value={draft() ?? text()}
          onInput={(event) => {
            setText(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit();
            }
          }}
        />
      </div>
    </div>
  );
};
const remapFilterBindings = (
  owner: {
    effects: Effect[];
    envelopes?: Envelope[];
    patterns?: Channel["patterns"];
  },
  effects: Effect[],
): void => {
  const remap = (effectId: string, parameter: string): string | undefined => {
    const previous = owner.effects.find((effect) => effect.id === effectId);
    const next = effects.find((effect) => effect.id === effectId);
    return previous && next ? remapFilterParameter(previous, next, parameter) : parameter;
  };
  if (owner.envelopes) {
    owner.envelopes.forEach((envelope: Envelope) => {
      const [prefix, effectId, parameter] = envelope.target.split(":");
      if (
        prefix !== "effect" ||
        effectId === undefined ||
        effectId === "" ||
        parameter === undefined ||
        parameter === ""
      ) {
        return;
      }
      const next = remap(effectId, parameter);
      if (next === undefined) {
        envelope.enabled = false;
        envelope.target = `effect:${effectId}:removed-${parameter}`;
      } else {
        envelope.target = `effect:${effectId}:${next}`;
      }
    });
  }
  if (owner.patterns) {
    Object.values(owner.patterns).forEach((pattern) => {
      pattern.lanes.forEach((lane) => {
        if (lane.effectId === undefined || lane.effectId === "") {
          return;
        }
        const next = remap(lane.effectId, lane.target);
        if (next === undefined) {
          lane.enabled = false;
          lane.target = `removed-${lane.target}`;
        } else {
          lane.target = next;
        }
      });
    });
  }
};
const EffectChain = (
  props: EffectClipboardProps & {
    readonly effects: Effect[];
    readonly onChange: (effects: Effect[]) => void;
    readonly onPreview: (effects: Effect[] | null) => void;
  },
): JSX.Element => {
  const update = (index: number, recipe: (effect: Effect) => void): void => {
    const next = structuredClone(props.effects);
    const effect = next[index];
    if (effect) {
      recipe(effect);
      props.onChange(next);
    }
  };
  return (
    <section class="effects-section" aria-label="Effects chain">
      <div class="section-heading">
        <h3>Effects</h3>
        <div class="effect-chain-actions">
          <button
            type="button"
            class="control"
            aria-label="Paste Effect"
            title="Append the copied effect to this chain"
            disabled={!props.copiedEffect}
            onClick={() => {
              const effect = props.copiedEffect;
              if (effect) {
                props.onChange([...props.effects, { ...structuredClone(effect), id: uniqueId() }]);
              }
            }}
          >
            <Icon name="clipboard" />
          </button>
          <EffectPicker
            onChoose={(name) => {
              props.onChange([...props.effects, createInstrumentEffect(name)]);
            }}
          />
        </div>
      </div>
      {props.effects.length > 0 && (
        <div class="effects-flow">
          <Index each={props.effects}>
            {(effect, index) => (
              <section class="effect-card">
                <div class="effect-heading">
                  <h4>{effect().type}</h4>
                  <button
                    type="button"
                    class="icon-button toggle-button"
                    aria-label={`Bypass ${effect().type} ${index + 1}`}
                    title="Hear the sound with or without this effect"
                    aria-pressed={!effect().enabled}
                    onClick={() => {
                      update(index, (target) => {
                        target.enabled = !target.enabled;
                      });
                    }}
                  >
                    <Icon name={effect().enabled ? "volume" : "volume-off"} />
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    aria-label={`Move ${effect().type} up`}
                    title="Apply this effect earlier in the chain"
                    disabled={index === 0}
                    onClick={() => {
                      const next = [...props.effects];
                      const current = next[index];
                      const previous = next[index - 1];
                      if (current && previous) {
                        next[index - 1] = current;
                        next[index] = previous;
                        props.onChange(next);
                      }
                    }}
                  >
                    <Icon name="arrow-up" />
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    aria-label={`Move ${effect().type} down`}
                    title="Apply this effect later in the chain"
                    disabled={index === props.effects.length - 1}
                    onClick={() => {
                      const next = [...props.effects];
                      const current = next[index];
                      const following = next[index + 1];
                      if (current && following) {
                        next[index + 1] = current;
                        next[index] = following;
                        props.onChange(next);
                      }
                    }}
                  >
                    <Icon name="arrow-down" />
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    aria-label={`Copy ${effect().type}`}
                    title="Copy this effect to the clipboard"
                    onClick={() => {
                      props.onCopyEffect(effect());
                    }}
                  >
                    <Icon name="clipboard-copy" />
                  </button>
                  <button
                    type="button"
                    class="icon-button danger"
                    aria-label={`Remove ${effect().type}`}
                    title="Remove this effect from the sound"
                    onClick={() => {
                      props.onChange(props.effects.filter((_, number) => number !== index));
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
                {effect().type === "EQ" && (
                  <FilterEditor
                    points={effectFilterPoints(effect())}
                    onPreview={(points) => {
                      if (points === null) {
                        props.onPreview(null);
                        return;
                      }
                      const next = structuredClone(props.effects);
                      const target = next[index];
                      if (target) {
                        setEffectFilterPoints(target, points);
                        props.onPreview(next);
                      }
                    }}
                    onChange={(points) => {
                      update(index, (target) => {
                        setEffectFilterPoints(target, points);
                      });
                    }}
                  />
                )}
                {effect().type !== "Monoize" && effect().type !== "EQ" && (
                  <Index each={EFFECT_PARAMETERS[effect().type] ?? []}>
                    {(parameter) => (
                      <>
                        {parameter().options ? (
                          <SelectControl
                            label={parameter().label}
                            tooltip={effectTooltip(effect().type, parameter().key)}
                            value={String(
                              effect().parameters[parameter().key] ??
                                parameter().options?.[parameter().value],
                            )}
                            options={parameter().options ?? []}
                            onChange={(value) => {
                              update(index, (target) => {
                                target.parameters[parameter().key] = value;
                              });
                            }}
                          />
                        ) : (
                          <NumericControl
                            label={parameter().label}
                            tooltip={effectTooltip(effect().type, parameter().key)}
                            value={Number(
                              effect().parameters[parameter().key] ?? parameter().value,
                            )}
                            min={parameter().min}
                            max={parameter().max}
                            step={parameter().step}
                            unit={
                              parameter().key === "time" &&
                              effect().parameters["timeBasis"] === "Beats"
                                ? "beats"
                                : parameter().unit
                            }
                            onPreview={(value) => {
                              const next = structuredClone(props.effects);
                              const target = next[index];
                              if (target && value !== null) {
                                target.parameters[parameter().key] = value;
                              }
                              props.onPreview(value === null ? null : next);
                            }}
                            onChange={(value) => {
                              update(index, (target) => {
                                target.parameters[parameter().key] = value;
                              });
                            }}
                          />
                        )}
                      </>
                    )}
                  </Index>
                )}
                {["Auto Pan", "3D Panning"].includes(effect().type) && (
                  <SelectControl
                    label="Mode"
                    tooltip="How the effect treats the stereo image"
                    value={String(effect().parameters["mode"] ?? "Stereo")}
                    options={["Stereo", "Split Stereo", "Mono"]}
                    onChange={(value) => {
                      update(index, (target) => {
                        target.parameters["mode"] = value;
                      });
                    }}
                  />
                )}
              </section>
            )}
          </Index>
        </div>
      )}
    </section>
  );
};
const ModulatorSource = (props: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}): JSX.Element => {
  const index = createMemo(() => props.value & 127);
  const cc = createMemo(() => Boolean(props.value & 128));
  const general = createMemo(() => [
    {
      label: "None",
      value: "0",
    },
    {
      label: "Note velocity",
      value: "2",
    },
    {
      label: "Note key",
      value: "3",
    },
    {
      label: "Poly pressure",
      value: "10",
    },
    {
      label: "Channel pressure",
      value: "13",
    },
    {
      label: "Pitch wheel",
      value: "14",
    },
    {
      label: "Pitch wheel sensitivity",
      value: "16",
    },
  ]);
  return (
    <details>
      <summary title="Choose how playing changes the sound">
        <Icon name="chevron-right" />
        {props.label} · {props.value}
      </summary>
      <ToggleControl
        label={`${props.label} is MIDI CC`}
        tooltip="Let a performance control shape the sound"
        value={cc()}
        onChange={(next) => {
          props.onChange(next ? props.value | 128 : props.value & ~128);
        }}
      />
      {cc() ? (
        <NumericControl
          label={`${props.label} CC number`}
          tooltip="Choose the performance control that shapes the sound"
          value={index()}
          min={0}
          max={127}
          onChange={(next) => {
            props.onChange((props.value & ~127) | next);
          }}
        />
      ) : (
        <SelectControl
          label={`${props.label} controller`}
          tooltip="Choose which part of playing shapes the sound"
          value={String(index())}
          options={[
            ...(general().some((item) => item.value === String(index()))
              ? []
              : [
                  {
                    label: `Source ${index()}`,
                    value: String(index()),
                  },
                ]),
            ...general(),
          ]}
          onChange={(next) => {
            props.onChange((props.value & ~127) | Number(next));
          }}
        />
      )}
      <SelectControl
        label={`${props.label} curve`}
        tooltip="Shape how playing changes the sound"
        value={String(props.value >>> 10)}
        options={[
          {
            label: "Linear",
            value: "0",
          },
          {
            label: "Concave",
            value: "1",
          },
          {
            label: "Convex",
            value: "2",
          },
          {
            label: "Switch",
            value: "3",
          },
        ]}
        onChange={(next) => {
          props.onChange((props.value & 1023) | (Number(next) << 10));
        }}
      />
      <ToggleControl
        label={`${props.label} reversed direction`}
        tooltip="Reverse how playing changes the sound"
        value={Boolean(props.value & 256)}
        onChange={(next) => {
          props.onChange(next ? props.value | 256 : props.value & ~256);
        }}
      />
      <ToggleControl
        label={`${props.label} bipolar`}
        tooltip="Let playing move the sound in both directions"
        value={Boolean(props.value & 512)}
        onChange={(next) => {
          props.onChange(next ? props.value | 512 : props.value & ~512);
        }}
      />
      <NumericControl
        label={`${props.label} raw identity`}
        tooltip="Choose how playing shapes the sound"
        value={props.value}
        min={0}
        max={65_535}
        onChange={props.onChange}
      />
    </details>
  );
};

const SampleLoopGraph = (props: {
  readonly waveform: number[];
  readonly frames: number;
  readonly start: number;
  readonly loopStart: number;
  readonly loopEnd: number;
  readonly onChange: (key: string, value: number) => void;
}): JSX.Element => {
  const [draft, setDraft] = createSignal<{
    key: string;
    value: number;
  } | null>(null);
  let gesture: string | null = null;
  const handles = createMemo(() => [
    {
      key: "sampleStart",
      value: props.start,
      label: "Start",
      color: "#f2bf76",
    },
    {
      key: "loopStart",
      value: props.loopStart,
      label: "Loop start",
      color: "#71d6d1",
    },
    {
      key: "loopEnd",
      value: props.loopEnd,
      label: "Loop end",
      color: "#b396f3",
    },
  ]);
  const move = (
    event: PointerEvent & {
      currentTarget: SVGSVGElement;
    },
  ): void => {
    if (gesture === null) {
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    let value = Math.round(
      Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * props.frames,
    );
    if (gesture === "loopStart") {
      value = Math.min(props.loopEnd - 1, value);
    } else if (gesture === "loopEnd") {
      value = Math.max(props.loopStart + 1, value);
    } else {
      value = Math.min(props.frames - 1, value);
    }
    setDraft({
      key: gesture,
      value,
    });
  };
  return (
    <svg
      class="mini-graph"
      role="application"
      aria-label="Sample waveform and loop handles"
      viewBox="0 0 320 100"
      preserveAspectRatio="none"
      style={{
        height: "100px",
        "touch-action": "none",
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const box = event.currentTarget.getBoundingClientRect();
        const frame = ((event.clientX - box.left) / box.width) * props.frames;
        gesture =
          [...handles()].sort((a, b) => Math.abs(a.value - frame) - Math.abs(b.value - frame))[0]
            ?.key ?? "sampleStart";
        move(event);
      }}
      onPointerMove={move}
      onPointerUp={() => {
        const currentDraft = draft();
        if (currentDraft) {
          props.onChange(currentDraft.key, currentDraft.value);
        }
        gesture = null;
        setDraft(null);
      }}
      onPointerCancel={() => {
        gesture = null;
        setDraft(null);
      }}
    >
      <title>Choose the sample start and repeating section</title>
      <rect
        x={(props.loopStart / props.frames) * 320}
        width={((props.loopEnd - props.loopStart) / props.frames) * 320}
        y={0}
        height={100}
        fill="#8560ce22"
      />
      <line x1={0} x2={320} y1={50} y2={50} stroke="#626775" />
      <polyline
        points={props.waveform
          .map(
            (value, index) =>
              `${(index / Math.max(1, props.waveform.length - 1)) * 320},${50 - value * 40}`,
          )
          .join(" ")}
        fill="none"
        stroke="#a58cc8"
      />
      <Index each={handles()}>
        {(handle) => {
          const value = createMemo(() =>
            draft()?.key === handle().key ? (draft()?.value ?? handle().value) : handle().value,
          );
          const x = createMemo(() => (value() / props.frames) * 320);
          return (
            <g>
              <line x1={x()} x2={x()} y1={0} y2={100} stroke={handle().color} stroke-width={2} />
              <text
                x={Math.max(4, Math.min(280, x() + 3))}
                y={
                  {
                    sampleStart: 14,
                    loopStart: 28,
                    loopEnd: 42,
                  }[handle().key] ?? 14
                }
                fill={handle().color}
                font-size="9"
              >
                {handle().label}
              </text>
            </g>
          );
        }}
      </Index>
    </svg>
  );
};
const SoundFontEditor = (props: {
  readonly instrument: Instrument;
  readonly assets: readonly AssetView[];
  readonly onEdit: InstrumentRecipe;
  readonly onAddAssets: () => void;
}): JSX.Element => {
  const [file, setFile] = createSignal(props.instrument.resourceId);
  createEffect(() => {
    setFile(props.instrument.resourceId);
  });
  const fonts = createMemo(() => props.assets.filter((resource) => resource.type === "soundfont"));
  const resource = createMemo(() => fonts().find((entry) => entry.id === file()));
  const presets = createMemo(() => resource()?.presets ?? []);
  const unresolved = createMemo(() => resource()?.status !== "ready");
  return (
    <>
      <SelectControl
        label="SoundFont"
        tooltip="Choose a collection of instrument sounds"
        value={file()}
        options={[
          ...(resource()
            ? []
            : [
                {
                  value: file(),
                  label: file() ? "Unresolved SoundFont" : "Choose SoundFont…",
                },
              ]),
          ...fonts().map((entry) => ({
            value: entry.id,
            label: `${entry.name}${entry.status === "ready" ? "" : " (unresolved)"}`,
          })),
          {
            value: "add",
            label: "Add Assets…",
          },
        ]}
        onChange={(value) => {
          if (value === "add") {
            props.onAddAssets();
          } else {
            setFile(value);
          }
        }}
      />
      <SelectControl
        label="Instrument"
        tooltip="Choose the instrument sound from this collection"
        value={
          file() === props.instrument.resourceId
            ? `${props.instrument.bank}:${props.instrument.program}`
            : ""
        }
        options={[
          {
            value: "",
            label: "Choose preset…",
          },
          ...presets().map((preset) => ({
            label: `${preset.name} (${preset.bank}:${preset.program})`,
            value: `${preset.bank}:${preset.program}`,
          })),
        ]}
        disabled={unresolved()}
        onChange={(value) => {
          const preset = presets().find((item) => `${item.bank}:${item.program}` === value);
          if (preset && resource()) {
            props.onEdit((target) => {
              target.resourceId = resource()?.id ?? file();
              target.bank = preset.bank;
              target.program = preset.program;
              target.name = preset.name;
            });
          }
        }}
      />
      <ToggleControl
        label="Preset effects"
        tooltip="Include the preset's chorus and reverb"
        value={props.instrument.presetEffects}
        onChange={(value) => {
          props.onEdit((target) => {
            target.presetEffects = value;
          });
        }}
      />
    </>
  );
};
const ChipSampleEditor = (props: {
  readonly instrument: Instrument;
  readonly assets: readonly AssetView[];
  readonly onEdit: InstrumentRecipe;
  readonly onAddAssets: () => void;
}): JSX.Element => {
  const [advanced, setAdvanced] = createSignal(false);
  const samples = createMemo(() => props.assets.filter((entry) => entry.type === "audio"));
  const resource = createMemo(() =>
    samples().find((entry) => entry.id === props.instrument.resourceId),
  );
  const sample = createMemo(() => Boolean(props.instrument.resourceId));
  const waveValue = (): string =>
    sample() ? `sample:${props.instrument.resourceId}` : props.instrument.wave;
  const audioInfo = createMemo(() => {
    const asset = resource();
    return asset?.status === "ready" ? getAudioResourceInfo(resourceCacheKey(asset)) : undefined;
  });
  const frames = createMemo(() => audioInfo()?.frames ?? resource()?.frames ?? 44_100);
  const start = createMemo(() => props.instrument.sampleStart ?? resource()?.start ?? 0);
  const loopStart = createMemo(() => props.instrument.loopStart ?? resource()?.loopStart ?? 0);
  const loopEnd = createMemo(() => props.instrument.loopEnd ?? resource()?.loopEnd ?? frames());
  return (
    <>
      <div class="setting-row">
        <span title="Choose the character of the sound">Wave</span>
        <SelectWrap>
          <select
            class="control"
            aria-label="Wave"
            title="Choose the character of the sound"
            ref={selectValueRef(waveValue, samples)}
            onChange={(event) => {
              const select = event.currentTarget;
              const { value } = select;
              if (value === "add") {
                select.value = waveValue();
                props.onAddAssets();
              } else if (value.startsWith("sample:")) {
                const selected = samples().find((entry) => entry.id === value.slice(7));
                if (selected?.status !== "ready") {
                  select.value = waveValue();
                  return;
                }
                props.onEdit((target) => {
                  target.resourceId = selected.id;
                  target.rootKey = selected.rootKey ?? 60;
                  target.sampleStart = selected.start ?? 0;
                  target.loopStart = selected.loopStart ?? 0;
                  target.loopEnd = selected.loopEnd ?? selected.frames ?? frames();
                  target.loopMode = selected.mode ?? "Loop";
                  target.backwards = selected.backwards ?? false;
                });
              } else {
                props.onEdit((target) => {
                  target.resourceId = "";
                  target.wave = value;
                });
              }
            }}
          >
            <optgroup label="Factory waves">
              <Index each={CHIP_WAVES}>{(wave) => <option>{wave()}</option>}</Index>
            </optgroup>
            <optgroup label="Samples">
              {sample() && !resource() ? (
                <option value={`sample:${props.instrument.resourceId}`}>Unresolved sample</option>
              ) : null}
              <Index each={samples()}>
                {(entry) => (
                  <option value={`sample:${entry().id}`} disabled={entry().status !== "ready"}>
                    {entry().name}
                    {entry().status === "ready" ? "" : " (unresolved)"}
                  </option>
                )}
              </Index>
            </optgroup>
            <option value="add">Add Assets…</option>
          </select>
        </SelectWrap>
      </div>
      {sample() ? (
        <>
          <button
            type="button"
            class="control wide toggle-button"
            aria-pressed={advanced()}
            title="Adjust the sample start and repeating section"
            onClick={() => {
              setAdvanced(!advanced());
            }}
          >
            <Icon name="repeat" leading />
            Advanced Loop Controls
          </button>
          {advanced() ? (
            <section class="sample-controls">
              <h4>{resource()?.name ?? "Missing sample"}</h4>
              <SampleLoopGraph
                frames={frames()}
                waveform={audioInfo()?.waveform ?? []}
                start={start()}
                loopStart={loopStart()}
                loopEnd={loopEnd()}
                onChange={(key, value) => {
                  props.onEdit((target) => {
                    target[key] = value;
                  });
                }}
              />
              <NumericControl
                label="Root MIDI key"
                tooltip="Set the sample's original pitch"
                value={props.instrument.rootKey ?? resource()?.rootKey ?? 60}
                min={0}
                max={127}
                onChange={(value) => {
                  props.onEdit((target) => {
                    target.rootKey = value;
                  });
                }}
              />
              <NumericControl
                label="Start frame"
                tooltip="Choose where sample playback starts"
                value={start()}
                min={0}
                max={Math.max(0, frames() - 1)}
                unit="frames"
                onChange={(value) => {
                  props.onEdit((target) => {
                    target.sampleStart = value;
                  });
                }}
              />
              <NumericControl
                label="Loop start"
                tooltip="Choose where the repeating section starts"
                value={loopStart()}
                min={0}
                max={Math.max(0, loopEnd() - 1)}
                unit="frames"
                onChange={(value) => {
                  props.onEdit((target) => {
                    target.loopStart = value;
                  });
                }}
              />
              <NumericControl
                label="Loop end"
                tooltip="Choose where the repeating section ends"
                value={loopEnd()}
                min={loopStart() + 1}
                max={frames()}
                unit="frames"
                onChange={(value) => {
                  props.onEdit((target) => {
                    target.loopEnd = value;
                  });
                }}
              />
              <SelectControl
                label="Playback mode"
                tooltip="Choose how the sample repeats"
                value={
                  typeof props.instrument.loopMode === "string"
                    ? props.instrument.loopMode
                    : (resource()?.mode ?? "Loop")
                }
                options={["Loop", "Ping-Pong", "Play Once", "Play Loop Once"]}
                onChange={(value) => {
                  props.onEdit((target) => {
                    target.loopMode = value;
                  });
                }}
              />
              <ToggleControl
                label="Backwards"
                tooltip="Play the sample in reverse"
                value={props.instrument.backwards ?? resource()?.backwards ?? false}
                onChange={(value) => {
                  props.onEdit((target) => {
                    target.backwards = value;
                  });
                }}
              />
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
};
type FMNumericKey =
  | "amplitude"
  | "coarse"
  | "fine"
  | "offset"
  | "pan"
  | "phase"
  | "pulseWidth"
  | "ratio"
  | "stereoDetune"
  | "stereoPhase";
const fmNumericControls: ReadonlyArray<
  readonly [string, FMNumericKey, number, number, number, string, number]
> = [
  ["Amplitude", "amplitude", 0, 100, 1, "%", 100],
  ["Ratio", "ratio", 0, 100, 0.01, "", 1],
  ["Offset", "offset", -20_000, 20_000, 0.1, "Hz", 1],
  ["Coarse", "coarse", -48, 48, 1, "semitones", 1],
  ["Fine", "fine", -100, 100, 1, "cents", 1],
  ["Phase", "phase", 0, 360, 1, "°", 1],
  ["Pan", "pan", -100, 100, 1, "%", 100],
  ["Stereo phase", "stereoPhase", -180, 180, 1, "°", 1],
  ["Stereo detune", "stereoDetune", -100, 100, 1, "cents", 1],
];
const FMOperatorEditor = (props: {
  readonly operator: FMOperator;
  readonly index: number;
  readonly lastCarrier: boolean;
  readonly onEdit: InstrumentRecipe;
  readonly onPreview: InstrumentPreview;
}): JSX.Element => {
  const edit = (recipe: (operator: FMOperator) => void): void => {
    props.onEdit((target) => {
      const row = target.operators.find((item) => item.id === props.operator.id);
      if (row) {
        recipe(row);
      }
    });
  };
  const numeric = ([
    label,
    key,
    min,
    max,
    step,
    unit,
    scale,
  ]: (typeof fmNumericControls)[number]): JSX.Element => (
    <NumericControl
      label={label}
      tooltip={operatorTooltips[key] ?? "Shape this voice"}
      value={props.operator[key] * scale}
      min={min}
      max={max}
      step={step}
      unit={unit}
      onPreview={(value) => {
        props.onPreview(
          value === null
            ? null
            : (target): void => {
                const row = target.operators.find((item) => item.id === props.operator.id);
                if (row) {
                  row[key] = value / scale;
                }
              },
        );
      }}
      onChange={(value) => {
        edit((row) => {
          row[key] = value / scale;
        });
      }}
    />
  );
  return (
    <section class="operator-row effect-card" aria-label={`Operator ${props.index + 1}`}>
      <div class="section-heading">
        <h4>Operator {props.index + 1}</h4>
        <label class="fm-carrier-toggle" title="Add this voice to the sound you hear">
          <span>Carrier</span>
          <input
            type="checkbox"
            class="switch"
            role="switch"
            aria-label={`Operator ${props.index + 1} carrier`}
            title="Add this voice to the sound you hear"
            checked={props.operator.carrier}
            aria-checked={props.operator.carrier}
            disabled={props.lastCarrier}
            onInput={(event) => {
              edit((row) => {
                row.carrier = event.target.checked;
              });
            }}
          />
        </label>
      </div>
      <div class="fm-wave-controls">
        <SelectControl
          label="Wave"
          tooltip="Choose the character of this voice"
          value={props.operator.wave}
          options={FM_WAVES}
          onChange={(value) => {
            edit((row) => {
              row.wave = value;
            });
          }}
        />
        {props.operator.wave === "pulse width" &&
          numeric(["Pulse Width", "pulseWidth", 1, 99, 0.1, "%", 100])}
        {props.operator.wave === "Custom" && (
          <DrawingEditor
            onPreview={(values) => {
              props.onPreview(
                values
                  ? (target): void => {
                      const row = target.operators.find((item) => item.id === props.operator.id);
                      if (row) {
                        row.customWave = values;
                      }
                    }
                  : null,
              );
            }}
            label={`Operator ${props.index + 1} Custom wave`}
            tooltip="Draw the character of this voice"
            values={props.operator.customWave}
            min={-24}
            max={24}
            integer
            mode="wave"
            onChange={(values) => {
              edit((row) => {
                row.customWave = values;
              });
            }}
          />
        )}
      </div>
      <div class="fm-operator-controls">{fmNumericControls.map(numeric)}</div>
      <ToggleControl
        label="Invert"
        tooltip="Change how this voice combines with the others"
        value={props.operator.invert}
        onChange={(value) => {
          edit((row) => {
            row.invert = value;
          });
        }}
      />
    </section>
  );
};
const fmNodeColor = (id: string, source: string, selected: string): string => {
  if (source === id) {
    return "#8560ce";
  }
  if (selected === id) {
    return "#46405f";
  }
  return "#252932";
};
const FMEditor = (props: {
  readonly instrument: Instrument;
  readonly onEdit: (recipe: (instrument: Instrument) => void) => void;
  readonly onPreview: InstrumentPreview;
}): JSX.Element => {
  const [mode, setMode] = createSignal("Algorithm");
  const [selected, setSelected] = createSignal(props.instrument.operators[0]?.id ?? "");
  const [source, setSource] = createSignal("");
  const [status, setStatus] = createSignal("");
  const operators = createMemo(() => props.instrument.operators);
  const edges = createMemo(() =>
    mode() === "Feedback" ? props.instrument.feedback : props.instrument.connections,
  );
  const nodeX = (index: number): number => 24 + (index * 272) / Math.max(1, operators().length - 1);
  const addEdge = (destination: string): void => {
    if (!source()) {
      setSource(destination);
      setSelected(destination);
      return;
    }
    const key = mode() === "Feedback" ? "feedback" : "connections";
    const existing = props.instrument[key].findIndex(
      (edge) => edge.from === source() && edge.to === destination,
    );
    const next =
      existing !== -1
        ? props.instrument[key].filter((_, index) => index !== existing)
        : [
            ...props.instrument[key],
            {
              from: source(),
              to: destination,
            },
          ];
    if (key === "connections" && !validFMGraph(props.instrument.operators, next)) {
      setStatus("A modulation connection cannot form a cycle. Use Feedback for return routes.");
      setSource("");
      return;
    }
    setStatus("");
    props.onEdit((target) => {
      target[key] = next;
    });
    setSelected(destination);
    setSource("");
  };
  return (
    <section class="fm-editor">
      <div class="section-heading">
        <h3 title="Connect voices to change the tone">FM Routing</h3>
        <SelectWrap>
          <select
            class="control"
            aria-label="FM routing mode"
            title="Choose which voice connections to edit"
            value={mode()}
            onChange={(event) => {
              setMode(event.target.value);
              setSource("");
            }}
          >
            <option>Algorithm</option>
            <option>Feedback</option>
          </select>
        </SelectWrap>
      </div>
      <svg
        class="mini-graph fm-routing"
        viewBox="0 0 320 120"
        aria-label="FM routing canvas"
        style={{
          height: "120px",
        }}
      >
        <title>Connect voices to change the tone</title>
        <defs>
          <marker
            id={`arrow-${props.instrument.id}`}
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0 0 L6 3 L0 6" fill="#b396f3" />
          </marker>
        </defs>
        <Index each={edges()}>
          {(edge, index) => {
            const from = createMemo(() =>
              operators().findIndex((operator) => operator.id === edge().from),
            );
            const to = createMemo(() =>
              operators().findIndex((operator) => operator.id === edge().to),
            );
            const x1 = createMemo(() => nodeX(from()));
            const x2 = createMemo(() => nodeX(to()));
            return (
              <path
                d={
                  from() === to()
                    ? `M${x1() - 8} 48 C${x1() - 40} 0 ${x1() + 40} 0 ${x1() + 8} 48`
                    : `M${x1()} 48 Q${(x1() + x2()) / 2} ${10 + (index % 3) * 10} ${x2()} 48`
                }
                stroke="#b396f3"
                stroke-width={1.5}
                fill="none"
                marker-end={`url(#arrow-${props.instrument.id})`}
              />
            );
          }}
        </Index>
        <Index each={operators()}>
          {(operator, index) => (
            <g>
              <foreignObject x={nodeX(index) - 15} y={47} width={30} height={30}>
                <button
                  type="button"
                  class="fm-node"
                  aria-label={`Operator ${index + 1}${operator().carrier ? " carrier" : " modulator"}`}
                  title="Connect voices to change the tone"
                  onClick={() => {
                    addEdge(operator().id);
                  }}
                />
              </foreignObject>
              <circle
                cx={nodeX(index)}
                cy={62}
                r={15}
                fill={fmNodeColor(operator().id, source(), selected())}
                stroke={operator().carrier ? "#71d6d1" : "#b396f3"}
                stroke-width={operator().carrier ? 3 : 1}
                pointer-events="none"
              />
              <text
                pointer-events="none"
                x={nodeX(index)}
                y={66}
                fill="#e8eaf0"
                text-anchor="middle"
                font-size="12"
              >
                {index + 1}
              </text>
              {operator().carrier ? (
                <>
                  <line x1={nodeX(index)} x2={nodeX(index)} y1={78} y2={99} stroke="#71d6d1" />
                  <text x={nodeX(index)} y={113} fill="#71d6d1" text-anchor="middle" font-size="9">
                    OUT
                  </text>
                </>
              ) : null}
            </g>
          )}
        </Index>
      </svg>
      {status() ? <output>{status()}</output> : null}
      <div class="button-row">
        <button
          title="Add another voice to shape the tone"
          type="button"
          class="control"
          disabled={operators().length >= 10}
          onClick={() => {
            const operator = {
              ...createFMOperator(),
              amplitude: 0,
              carrier: false,
            };
            props.onEdit((target) => {
              target.operators.push(operator);
            });
            setSelected(operator.id);
          }}
        >
          <Icon name="plus" leading />
          Add operator
        </button>
        <button
          title="Remove the selected voice from the sound"
          type="button"
          class="control danger"
          disabled={operators().length <= 1}
          onClick={() => {
            const id = operators().some((operator) => operator.id === selected())
              ? selected()
              : operators().at(-1)?.id;
            props.onEdit((target) => {
              target.operators = target.operators.filter((operator) => operator.id !== id);
              target.connections = target.connections.filter(
                (edge) => edge.from !== id && edge.to !== id,
              );
              target.feedback = target.feedback.filter(
                (edge) => edge.from !== id && edge.to !== id,
              );
              if (!target.operators.some((operator) => operator.carrier) && target.operators[0]) {
                target.operators[0].carrier = true;
              }
              target.envelopes.forEach((envelope) => {
                if (id !== undefined && id !== "" && envelope.target.includes(id)) {
                  envelope.enabled = false;
                }
              });
            });
            setSelected(operators().findLast((operator) => operator.id !== id)?.id ?? "");
            setSource("");
          }}
        >
          <Icon name="minus" leading />
          Remove operator
        </button>
      </div>
      <Index each={operators()}>
        {(operator, index) => (
          <FMOperatorEditor
            operator={operator()}
            index={index}
            lastCarrier={
              operator().carrier ? operators().filter((item) => item.carrier).length === 1 : false
            }
            onEdit={props.onEdit}
            onPreview={props.onPreview}
          />
        )}
      </Index>
      <NumericControl
        label="Phase Randomness"
        tooltip="Vary the tone at each note start"
        value={props.instrument.phaseRandomness * 100}
        min={0}
        max={100}
        unit="%"
        onPreview={(value) => {
          props.onPreview(
            value === null
              ? null
              : (target): void => {
                  target.phaseRandomness = value / 100;
                },
          );
        }}
        onChange={(value) => {
          props.onEdit((target) => {
            target.phaseRandomness = value / 100;
          });
        }}
      />
      <NumericControl
        label="Feedback Volume"
        tooltip="Add grit and complexity to the tone"
        value={props.instrument.feedbackVolume * 100}
        min={0}
        max={100}
        unit="%"
        onChange={(value) => {
          props.onEdit((target) => {
            target.feedbackVolume = value / 100;
          });
        }}
      />
    </section>
  );
};

// Each envelope expands independently with Speed, A, B and type-specific stage controls.
// Expansion is view state only; new envelopes start expanded and targets use stable identities.
const envelopeNumber = (envelope: Envelope, key: string, fallback: number): number => {
  const value = envelope[key];
  return typeof value === "number" ? value : fallback;
};
const envelopeLaw = (envelope: Envelope): string =>
  typeof envelope.law === "string" ? envelope.law : "generic";
const changeEnvelopeLaw = (envelope: Envelope, law: string): void => {
  const oldLaw = envelopeLaw(envelope);
  if (oldLaw === law) {
    return;
  }
  for (const key of ["delay", "attack", "hold", "decay", "release"]) {
    let seconds = envelopeNumber(envelope, key, 0);
    if (oldLaw !== "generic") {
      seconds = seconds <= -32_768 ? 0 : 2 ** (seconds / 1200);
    }
    if (law === "generic") {
      envelope[key] = seconds;
    } else {
      envelope[key] =
        seconds <= 0 ? -32_768 : Math.max(-32_768, Math.min(8000, 1200 * Math.log2(seconds)));
    }
  }
  const nativeSustain = envelopeNumber(envelope, "sustain", 0.7);
  const level = ((): number => {
    if (oldLaw === "SF2 volume") {
      return 10 ** (-nativeSustain / 200);
    }
    if (oldLaw === "SF2 modulation") {
      return 1 - nativeSustain / 1000;
    }
    return nativeSustain;
  })();
  if (law === "SF2 volume") {
    envelope.sustain = level <= 0 ? 1440 : Math.max(0, Math.min(1440, -200 * Math.log10(level)));
  } else if (law === "SF2 modulation") {
    envelope.sustain = Math.max(0, Math.min(1000, (1 - level) * 1000));
  } else {
    envelope.sustain = Math.max(0, Math.min(1, level));
  }
  envelope.law = law;
};
const envelopeGeneratorLabels = [
  "Delay",
  "Attack",
  "Hold",
  "Decay",
  "Sustain",
  "Release",
  "Key to hold",
  "Key to decay",
];
const EnvelopeModulators = (props: {
  readonly envelope: Envelope;
  readonly onChange: (recipe: (envelope: Envelope) => void) => void;
}): JSX.Element => {
  const modulators = createMemo(() => props.envelope.sf2Modulators ?? []);
  const base = createMemo(() => (envelopeLaw(props.envelope) === "SF2 volume" ? 33 : 25));
  const destinations = createMemo(() =>
    envelopeGeneratorLabels.map((label, index) => ({ value: String(base() + index), label })),
  );
  const edit = (index: number, recipe: (modulator: SFModulator) => void): void => {
    props.onChange((target) => {
      const item = target.sf2Modulators?.[index];
      if (item) {
        recipe(item);
      }
    });
  };
  return (
    <details>
      <summary title="Adjust how playing changes the note movement">
        <Icon name="chevron-right" />
        Envelope modulators ({modulators().length})
      </summary>
      <button
        title="Add a response to playing"
        type="button"
        class="control wide"
        onClick={() => {
          props.onChange((target) => {
            target.sf2Modulators ??= [];
            target.sf2Modulators.push({
              source: 3,
              destination: base() + 1,
              amount: 0,
              amountSource: 0,
              transform: 0,
            });
          });
        }}
      >
        <Icon name="plus" leading />
        Add envelope modulator
      </button>
      <Index each={Object.entries(modulators())}>
        {(modulatorEntry) => {
          const index = createMemo(() => Number(modulatorEntry()[0]));
          return (
            <section class="effect-card">
              <header class="effect-heading">
                <h4>Envelope modulator {index() + 1}</h4>
                <button
                  type="button"
                  class="icon-button danger"
                  aria-label={`Remove envelope modulator ${index() + 1}`}
                  title="Remove this response to playing"
                  onClick={() => {
                    props.onChange((target) => {
                      target.sf2Modulators?.splice(index(), 1);
                    });
                  }}
                >
                  <Icon name="trash" />
                </button>
              </header>
              <ModulatorSource
                label="Source"
                value={modulatorEntry()[1].source}
                onChange={(value) => {
                  edit(index(), (target) => {
                    target.source = value;
                  });
                }}
              />
              <SelectControl
                label="Destination"
                tooltip="Choose what the playing changes"
                value={String(modulatorEntry()[1].destination)}
                options={[
                  ...destinations(),
                  ...(destinations().some(
                    (option) => option.value === String(modulatorEntry()[1].destination),
                  )
                    ? []
                    : [
                        {
                          value: String(modulatorEntry()[1].destination),
                          label: `Generator ${modulatorEntry()[1].destination}`,
                        },
                      ]),
                ]}
                onChange={(value) => {
                  edit(index(), (target) => {
                    target.destination = Number(value);
                  });
                }}
              />
              <NumericControl
                label="Amount"
                tooltip="Strength and direction of the change"
                value={modulatorEntry()[1].amount}
                min={-32_768}
                max={32_767}
                step={1}
                onChange={(value) => {
                  edit(index(), (target) => {
                    target.amount = value;
                  });
                }}
              />
              <ModulatorSource
                label="Amount source"
                value={modulatorEntry()[1].amountSource}
                onChange={(value) => {
                  edit(index(), (target) => {
                    target.amountSource = value;
                  });
                }}
              />
              <SelectControl
                label="Transform"
                tooltip="Shape the response to playing"
                value={String(modulatorEntry()[1].transform)}
                options={[
                  {
                    value: "0",
                    label: "Linear",
                  },
                  {
                    value: "2",
                    label: "Absolute value",
                  },
                ]}
                onChange={(value) => {
                  edit(index(), (target) => {
                    target.transform = Number(value);
                  });
                }}
              />
            </section>
          );
        }}
      </Index>
    </details>
  );
};
const EnvelopeParameters = (props: {
  readonly envelope: Envelope;
  readonly onChange: (recipe: (envelope: Envelope) => void) => void;
}): JSX.Element => {
  const law = createMemo(() => envelopeLaw(props.envelope));
  const native = createMemo(() => law() !== "generic");
  const numeric = (
    label: string,
    key: string,
    min: number,
    max: number,
    step = 0.01,
    unit = "",
    fallback = 0,
  ): JSX.Element => (
    <NumericControl
      {...{
        label,
        min,
        max,
        step,
        unit,
      }}
      tooltip={envelopeTooltips[key] ?? "Shape the note movement"}
      value={envelopeNumber(props.envelope, key, fallback)}
      onChange={(value) => {
        props.onChange((target) => {
          target[key] = value;
        });
      }}
    />
  );
  return (
    <div class="envelope-details">
      <EndpointControl
        label="Speed"
        tooltip="Speed of the note movement"
        value={props.envelope.speed}
        min={0}
        max={20}
        onChange={(value) => {
          props.onChange((target) => {
            target.speed = Math.max(0, value);
          });
        }}
      />
      <SelectControl
        label="Time basis"
        tooltip="Follow elapsed time or the song beat"
        value={props.envelope.timeBasis}
        options={["seconds", "beats"]}
        onChange={(value) => {
          props.onChange((target) => {
            target.timeBasis = value;
          });
        }}
      />
      <EndpointControl
        label="A"
        tooltip="First level of the movement"
        value={props.envelope.a}
        onChange={(value) => {
          props.onChange((target) => {
            target.a = value;
          });
        }}
      />
      <EndpointControl
        label="B"
        tooltip="Second level of the movement"
        value={props.envelope.b}
        onChange={(value) => {
          props.onChange((target) => {
            target.b = value;
          });
        }}
      />
      {["Sine", "Square", "Triangle"].includes(props.envelope.type) && (
        <>
          {numeric("Phase", "phase", 0, 360, 1, "°")}
          {numeric("Duty / shape", "duty", 0.01, 0.99)}
          <SelectControl
            label="Clock"
            tooltip="Restart the movement per note or follow the song"
            value={
              typeof props.envelope.clock === "string" ? props.envelope.clock : "song synchronized"
            }
            options={["elapsed time", "song synchronized"]}
            onChange={(value) => {
              props.onChange((target) => {
                target.clock = value;
              });
            }}
          />
        </>
      )}
      {["Flare", "Swell", "Decay", "Twang"].includes(props.envelope.type) &&
        numeric("Curve / shape", "curve", 0.01, 10, 0.01, "", 1)}
      {props.envelope.type === "Staged / SF2" && (
        <>
          <SelectControl
            label="Envelope law"
            tooltip="Choose how the note rises and fades"
            value={law()}
            options={["generic", "SF2 volume", "SF2 modulation"]}
            onChange={(value) => {
              props.onChange((target) => {
                changeEnvelopeLaw(target, value);
              });
            }}
          />
          {
            <Index each={["Delay", "Attack", "Hold", "Decay", "Sustain", "Release"]}>
              {(stage) => {
                const sustain = createMemo(() => stage() === "Sustain");
                const limits = createMemo((): readonly [number, string] => {
                  if (!sustain()) {
                    return native() ? ([8000, "timecents"] as const) : ([20, "s"] as const);
                  }
                  if (law() === "SF2 volume") {
                    return [1440, "centibels"] as const;
                  }
                  if (law() === "SF2 modulation") {
                    return [1000, "0.1% decrease"] as const;
                  }
                  return [1, "level"] as const;
                });
                return (
                  <section class="stage-controls">
                    <h4>{stage()}</h4>
                    {numeric(
                      stage(),
                      stage().toLowerCase(),
                      native() && !sustain() ? -32_768 : 0,
                      limits()[0],
                      native() ? 1 : 0.01,
                      limits()[1],
                      native() && !sustain() ? -32_768 : 0,
                    )}
                  </section>
                );
              }}
            </Index>
          }
          {numeric("Initial level", "initialLevel", 0, 1, 0.01, "", 0)}
          {numeric("Terminal level", "terminalLevel", 0, 1, 0.01, "", 0)}
          {numeric("Key to hold", "keyToHold", -1200, 1200, 1, "timecents/key")}
          {numeric("Key to decay", "keyToDecay", -1200, 1200, 1, "timecents/key")}
          {native() ? (
            <EnvelopeModulators envelope={props.envelope} onChange={props.onChange} />
          ) : null}
        </>
      )}
    </div>
  );
};
const EnvelopeEditor = (props: {
  readonly instrument: Instrument;
  readonly onChange: (envelopes: Envelope[]) => void;
}): JSX.Element => {
  const [expanded, setExpanded] = createSignal<string[]>([]);
  const update = (index: number, recipe: (envelope: Envelope) => void): void => {
    const next = structuredClone(props.instrument.envelopes);
    const envelope = next[index];
    if (envelope) {
      recipe(envelope);
      props.onChange(next);
    }
  };
  const targets = createMemo(() => envelopeTargets(props.instrument));
  return (
    <section class="envelopes" aria-label="Envelopes">
      <div class="section-heading">
        <h3>Envelopes</h3>
        <button
          type="button"
          class="control"
          aria-label="Add envelope"
          title="Add movement over each note"
          onClick={() => {
            const envelope = createEnvelope();
            setExpanded((previous) => [...previous, envelope.id]);
            props.onChange([...props.instrument.envelopes, envelope]);
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
      <Index each={props.instrument.envelopes}>
        {(envelope, index) => {
          const open = createMemo(() => expanded().includes(envelope().id));
          const missing = createMemo(
            () => !targets().some((target) => target.value === envelope().target),
          );
          return (
            <section class="envelope-section effect-card">
              <div class="envelope-heading">
                <button
                  type="button"
                  class="icon-button"
                  aria-expanded={open()}
                  aria-label={`${open() ? "Collapse" : "Expand"} envelope ${index + 1}`}
                  title={
                    open() ? "Hide the note movement settings" : "Show the note movement settings"
                  }
                  onClick={() => {
                    setExpanded(
                      open()
                        ? expanded().filter((id) => id !== envelope().id)
                        : [...expanded(), envelope().id],
                    );
                  }}
                >
                  <Icon name={open() ? "chevron-down" : "chevron-right"} />
                </button>
                <SelectWrap>
                  <select
                    class="control"
                    aria-label={`Envelope ${index + 1} target`}
                    title="Choose what changes over each note"
                    ref={selectValueRef(() => envelope().target, targets)}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      update(index, (target) => {
                        target.target = value;
                        target.enabled = true;
                      });
                    }}
                  >
                    {missing() ? <option value={envelope().target}>None</option> : null}
                    <Index each={targets()}>
                      {(target) => <option value={target().value}>{target().label}</option>}
                    </Index>
                  </select>
                </SelectWrap>
                <SelectWrap>
                  <select
                    class="control"
                    aria-label={`Envelope ${index + 1} type`}
                    title="Shape the movement over each note"
                    value={envelope().type}
                    onChange={(event) => {
                      update(index, (target) => {
                        target.type = event.target.value;
                      });
                    }}
                  >
                    <Index each={envelopeTypes}>{(type) => <option>{type()}</option>}</Index>
                  </select>
                </SelectWrap>
                <button
                  type="button"
                  class="icon-button danger"
                  aria-label={`Delete envelope ${index + 1}`}
                  title="Remove this movement from the sound"
                  onClick={() => {
                    props.onChange(
                      props.instrument.envelopes.filter((_, number) => number !== index),
                    );
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
              {open() ? (
                <EnvelopeParameters
                  envelope={envelope()}
                  onChange={(recipe) => {
                    update(index, recipe);
                  }}
                />
              ) : null}
            </section>
          );
        }}
      </Index>
    </section>
  );
};
const SoundEditor = (props: {
  readonly instrument: Instrument;
  readonly assets: readonly AssetView[];
  readonly onEdit: (recipe: (instrument: Instrument) => void) => void;
  readonly onPreview: InstrumentPreview;
  readonly onAddAssets: () => void;
}): JSX.Element => {
  const type = createMemo(() => props.instrument.type);
  const numeric = (
    label: string,
    key: "dynamism" | "phaseRandomness" | "pulseWidth" | "shape" | "spread" | "sustain",
    min = 0,
    max = 1,
  ): JSX.Element => (
    <NumericControl
      label={label}
      tooltip={soundTooltips[key] ?? "Shape the instrument tone"}
      value={props.instrument[key] * 100}
      min={min * 100}
      max={max * 100}
      unit="%"
      onPreview={(value) => {
        props.onPreview(
          value === null
            ? null
            : (target): void => {
                target[key] = value / 100;
              },
        );
      }}
      onChange={(value) => {
        props.onEdit((target) => {
          target[key] = value / 100;
        });
      }}
    />
  );
  return (
    <>
      {type() === "chip wave" && (
        <ChipSampleEditor
          instrument={props.instrument}
          assets={props.assets}
          onEdit={props.onEdit}
          onAddAssets={props.onAddAssets}
        />
      )}
      {type() === "basic noise" && (
        <SelectControl
          label="Noise"
          tooltip="Choose the character of the noise"
          value={props.instrument.noise}
          options={noises.map((noise) => noise.name)}
          onChange={(value) => {
            props.onEdit((target) => {
              target.noise = value;
            });
          }}
        />
      )}
      {type() === "Custom chip wave" && (
        <DrawingEditor
          onPreview={(values) => {
            props.onPreview(
              values
                ? (target): void => {
                    target.customWave = values;
                  }
                : null,
            );
          }}
          label="Custom chip wave"
          tooltip="Draw the character of the tone"
          values={props.instrument.customWave}
          min={-24}
          max={24}
          integer
          mode="wave"
          onChange={(values) => {
            props.onEdit((target) => {
              target.customWave = values;
            });
          }}
        />
      )}
      {type() === "FM (n-op)" && (
        <FMEditor instrument={props.instrument} onEdit={props.onEdit} onPreview={props.onPreview} />
      )}
      {["harmonics", "picked string"].includes(type()) && (
        <DrawingEditor
          onPreview={(values) => {
            props.onPreview(
              values
                ? (target): void => {
                    target.harmonics = values;
                  }
                : null,
            );
          }}
          label="Harmonics"
          tooltip="Shape the balance of overtones"
          values={props.instrument.harmonics}
          onChange={(values) => {
            props.onEdit((target) => {
              target.harmonics = values;
            });
          }}
        />
      )}
      {type() === "spectrum" && (
        <DrawingEditor
          onPreview={(values) => {
            props.onPreview(
              values
                ? (target): void => {
                    target.spectrum = values;
                  }
                : null,
            );
          }}
          label="Spectrum"
          tooltip="Shape the balance of low and high tones"
          values={props.instrument.spectrum}
          mode="curve"
          onChange={(values) => {
            props.onEdit((target) => {
              target.spectrum = values;
            });
          }}
        />
      )}
      {type() === "drumset" && (
        <div class="drumset-editor">
          <Index each={props.instrument.drums.toReversed()}>
            {(drum, rowIndex) => {
              const index = createMemo(() => props.instrument.drums.length - 1 - rowIndex);
              return (
                <section class="drum-row">
                  <SelectControl
                    label={`Drum ${index() + 1} Envelope`}
                    tooltip="Shape how this drum hit changes over time"
                    value={drum().envelope.type}
                    options={envelopeTypes}
                    onChange={(value) => {
                      props.onEdit((target) => {
                        const row = target.drums[index()];
                        if (row) {
                          row.envelope.type = value;
                        }
                      });
                    }}
                  />
                  <details class="drum-envelope-details">
                    <summary title="Adjust how this drum hit changes over time">
                      <Icon name="chevron-right" />
                      <span>Drum {index() + 1}</span> · Envelope settings
                    </summary>
                    <EnvelopeParameters
                      envelope={drum().envelope}
                      onChange={(recipe) => {
                        props.onEdit((target) => {
                          const row = target.drums[index()];
                          if (row) {
                            recipe(row.envelope);
                          }
                        });
                      }}
                    />
                  </details>
                  <DrawingEditor
                    onPreview={(values) => {
                      props.onPreview(
                        values
                          ? (target): void => {
                              const row = target.drums[index()];
                              if (row) {
                                row.spectrum = values;
                              }
                            }
                          : null,
                      );
                    }}
                    label={`Drum ${index() + 1} Spectrum`}
                    tooltip="Shape the balance of tones in this drum hit"
                    values={drum().spectrum}
                    mode="curve"
                    onChange={(values) => {
                      props.onEdit((target) => {
                        const row = target.drums[index()];
                        if (row) {
                          row.spectrum = values;
                        }
                      });
                    }}
                  />
                </section>
              );
            }}
          </Index>
        </div>
      )}
      {type() === "supersaw" && (
        <>
          {numeric("Dynamism", "dynamism")}
          {numeric("Spread", "spread")}
          {numeric("Saw↔Pulse", "shape")}
        </>
      )}
      {["supersaw", "pulse width"].includes(type()) && (
        <NumericControl
          label="Pulse Width"
          value={props.instrument.pulseWidth * 100}
          min={4.4}
          max={50}
          step={0.1}
          unit="%"
          tooltip="Make the tone thinner or fuller"
          onPreview={(value) => {
            props.onPreview(
              value === null
                ? null
                : (target): void => {
                    target.pulseWidth = value / 100;
                  },
            );
          }}
          onChange={(value) => {
            props.onEdit((target) => {
              target.pulseWidth = value / 100;
            });
          }}
        />
      )}
      {type() === "picked string" && numeric("Sustain", "sustain")}
      {type() === "SoundFont" && (
        <SoundFontEditor
          instrument={props.instrument}
          assets={props.assets}
          onEdit={props.onEdit}
          onAddAssets={props.onAddAssets}
        />
      )}
    </>
  );
};
const TypeDialog = (props: {
  readonly instrument: Instrument;
  readonly assets: readonly AssetView[];
  readonly onClose: () => void;
  readonly onChoose: (instrument: Instrument) => void;
  readonly onCopy: () => void;
  readonly onPaste: () => void;
}): JSX.Element => {
  let dialog: HTMLDialogElement | null = null;
  createEffect(() => {
    const previous = document.activeElement;
    focusDialogSearch(dialog);
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        props.onClose();
      }
      if (event.key === "Tab") {
        const focusable = Array.from(
          dialog?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]',
          ) ?? [],
        );
        const [first] = focusable;
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    onCleanup((): void => {
      document.removeEventListener("keydown", key);
      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    });
  });
  const choose = (type: string, preset?: string): void => {
    const next =
      preset !== undefined && preset !== ""
        ? presetInstrument(preset, props.instrument)
        : createInstrument(type);
    if (preset === undefined || preset === "") {
      for (const key of [
        "attack",
        "release",
        "transition",
        "chords",
        "arpeggioSpeed",
        "fastTwoNote",
        "effects",
        "envelopes",
      ] as const) {
        Object.assign(next, {
          [key]: structuredClone(props.instrument[key]),
        });
      }
      if (
        next.chords === "custom interval" &&
        !["chip wave", "FM (n-op)", "harmonics", "Custom chip wave"].includes(type)
      ) {
        next.chords = "simultaneous";
      }
      const valid = new Set(envelopeTargets(next).map((target) => target.value));
      next.envelopes.forEach((envelope) => {
        if (!valid.has(envelope.target)) {
          envelope.enabled = false;
        }
      });
    }
    next.volume = props.instrument.volume;
    if (type === props.instrument.type && (preset === undefined || preset === "")) {
      Object.assign(next, structuredClone(props.instrument), {
        preset: "",
      });
    }
    next.presetEffects = props.instrument.presetEffects;
    props.onChoose(next);
  };
  const editActions = [
    {
      label: "Copy Instrument",
      title: "Keep this sound to use elsewhere",
      run: (): void => {
        props.onCopy();
      },
    },
    {
      label: "Paste Instrument",
      title: "Replace this sound with the copied instrument",
      run: (): void => {
        props.onPaste();
      },
    },
    {
      label: "Random Preset",
      title: "Try a randomly chosen preset sound",
      run: (): void => {
        props.onChoose(randomPreset(props.instrument, props.assets));
      },
    },
    {
      label: "Random Generated",
      title: "Create a new random sound",
      run: (): void => {
        props.onChoose(randomInstrument(props.instrument, Math.random, props.assets));
      },
    },
  ] as const;
  const instrumentItems = (
    names: readonly string[],
    select: (name: string) => void,
  ): CategoryItem[] =>
    names.map((name) => ({
      label: name,
      render: (): JSX.Element => (
        <button
          type="button"
          class="control"
          title="Use this instrument sound"
          onClick={() => {
            select(name);
          }}
        >
          {name}
        </button>
      ),
    }));
  const groups = createMemo(() => [
    {
      title: "Edit",
      items: editActions.map((action) => ({
        label: action.label,
        render: (): JSX.Element => (
          <button type="button" class="control" title={action.title} onClick={action.run}>
            {action.label}
          </button>
        ),
      })),
    },
    {
      title: "Custom Instruments",
      items: instrumentItems(INSTRUMENT_TYPES, choose),
    },
    ...Object.entries(PRESET_GROUPS).map(([title, names]) => ({
      title,
      items: instrumentItems(names, (name) => {
        choose("chip wave", name);
      }),
    })),
    ...props.assets
      .filter((resource) => resource.type === "soundfont")
      .map((resource) => ({
        title: resource.name,
        items: (resource.presets ?? []).map((preset) => ({
          label: preset.name,
          render: (): JSX.Element => (
            <button
              type="button"
              class="control"
              title="Use this preset sound"
              onClick={() => {
                const next = createInstrument("SoundFont");
                next.volume = props.instrument.volume;
                next.presetEffects = props.instrument.presetEffects;
                next.resourceId = resource.id;
                next.bank = preset.bank;
                next.program = preset.program;
                next.preset = preset.name;
                props.onChoose(next);
              }}
            >
              {preset.name} ({preset.bank}:{preset.program})
            </button>
          ),
        })),
      })),
  ]);
  return (
    <div
      class="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
    >
      <dialog
        open
        ref={(element) => {
          dialog = element;
        }}
        class="dialog"
        aria-modal="true"
        aria-label="Choose instrument type"
      >
        <div class="dialog-heading">
          <h2>Choose Instrument</h2>
          <button
            type="button"
            class="icon-button"
            aria-label="Close instrument dialog"
            title="Return to the instrument editor"
            onClick={props.onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <CategoryBrowser label="Instrument categories" filterTabs categories={groups()} />
      </dialog>
    </div>
  );
};
const laneDefinitions = (
  kind: Channel["target"]["kind"],
  effects: readonly Effect[],
): Array<{
  label: string;
  value: string;
  min: number;
  max: number;
  unit: string;
  base: number;
  effectId?: string;
}> => {
  const definitions: Array<{
    label: string;
    value: string;
    min: number;
    max: number;
    unit: string;
    base: number;
    effectId?: string;
  }> = [];
  if (kind === "song") {
    definitions.push(
      {
        label: "Song: Volume",
        value: "volume",
        min: 0,
        max: 100,
        unit: "%",
        base: 100,
      },
      {
        label: "Song: Tempo",
        value: "tempo",
        min: 1,
        max: 300,
        unit: "BPM",
        base: 150,
      },
      {
        label: "Song: Global detune",
        value: "detune",
        min: -250,
        max: 250,
        unit: "cents",
        base: 0,
      },
      {
        label: "Transport: Next Bar",
        value: "nextBar",
        min: 0,
        max: 1,
        unit: "event",
        base: 1,
      },
    );
  }
  effects.forEach((effect, index) => {
    if (effect.type === "Monoize") {
      return;
    }
    for (const parameter of effect.type === "EQ"
      ? filterParameters(effect)
      : (EFFECT_PARAMETERS[effect.type] ?? [])) {
      if (!parameter.options) {
        definitions.push({
          label: `${index + 1}. ${effect.type}: ${parameter.label}`,
          value: `effect:${effect.id}:${parameter.key}`,
          min: parameter.min,
          max: parameter.max,
          unit: parameter.unit,
          base: Number(effect.parameters[parameter.key] ?? parameter.value),
          effectId: effect.id,
        });
      }
    }
  });
  return definitions;
};
const AutomationGraph = (props: {
  readonly label: string;
  readonly points: AutomationPoint[];
  readonly beats: number;
  readonly min: number;
  readonly max: number;
  readonly interpolation: string;
  readonly onChange: (points: AutomationPoint[]) => void;
  readonly onPreview: (points: AutomationPoint[] | null) => void;
}): JSX.Element => {
  const [draft, setDraft] = createSignal<AutomationPoint[] | null>(null);
  let active: {
    points: AutomationPoint[];
    index: number;
  } | null = null;
  const shown = createMemo(() => draft() ?? props.points);
  const x = (time: number): number => (time / props.beats) * 320;
  const y = (value: number): number =>
    90 - ((value - props.min) / (props.max - props.min || 1)) * 80;
  const move = (
    event: PointerEvent & {
      currentTarget: HTMLButtonElement;
    },
  ): void => {
    const gesture = active;
    if (!gesture) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const time =
      Math.round(
        Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * props.beats * 24,
      ) / 24;
    const value =
      props.max -
      Math.max(0, Math.min(1, (((event.clientY - rect.top) / rect.height) * 100 - 10) / 80)) *
        (props.max - props.min);
    gesture.points[gesture.index] = {
      time,
      value,
    };
    setDraft([...gesture.points]);
    props.onPreview([...gesture.points]);
  };
  const sorted = createMemo(() => [...shown()].sort((a, b) => a.time - b.time));
  return (
    <GraphControl
      class="mini-graph automation-graph"
      aria-label={props.label}
      title="Draw how the setting changes through the bar"
      viewBox="0 0 320 100"
      style={{
        "touch-action": "none",
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = event.currentTarget.getBoundingClientRect();
        const at = ((event.clientX - rect.left) / rect.width) * 320;
        const nearest = props.points.findIndex((point) => Math.abs(x(point.time) - at) < 10);
        const next = structuredClone(props.points);
        const index =
          nearest !== -1
            ? nearest
            : next.push({
                time: 0,
                value: props.min,
              }) - 1;
        active = {
          points: next,
          index,
        };
        move(event);
      }}
      onPointerMove={move}
      onPointerUp={() => {
        if (active) {
          const result = [...active.points].sort((a, b) => a.time - b.time);
          props.onChange(result.filter((point, index) => result[index + 1]?.time !== point.time));
        }
        active = null;
        setDraft(null);
      }}
      onPointerCancel={() => {
        active = null;
        setDraft(null);
        props.onPreview(null);
      }}
    >
      {Array.from(
        {
          length: props.beats + 1,
        },
        (_, index) => (
          <line x1={x(index)} x2={x(index)} y1={0} y2={100} stroke="#292d35" />
        ),
      )}
      <Index each={[10, 50, 90]}>
        {(position) => <line x1={0} x2={320} y1={position()} y2={position()} stroke="#292d35" />}
      </Index>
      <path
        d={sorted()
          .map((point, index) => {
            let prefix = "M";
            if (index > 0) {
              prefix = props.interpolation === "hold" ? `H${x(point.time)} L` : "L";
            }
            return `${prefix}${x(point.time)} ${y(point.value)}`;
          })
          .join(" ")}
        stroke="#b396f3"
        stroke-width={2}
        fill="none"
      />
      <Index each={Object.entries(shown())}>
        {(pointEntry) => (
          <circle cx={x(pointEntry()[1].time)} cy={y(pointEntry()[1].value)} r={4} fill="#dfceff" />
        )}
      </Index>
    </GraphControl>
  );
};
const AutomationEditor = (props: {
  readonly channel: Channel;
  readonly song: Song;
  readonly bar: number;
  readonly onEdit: (recipe: (channel: Channel) => void) => void;
  readonly onPreview: ChannelPreview;
}): JSX.Element => {
  const number = createMemo(() => props.channel.cells[props.bar] ?? 0);
  const pattern = createMemo(() => props.channel.patterns[number()]);
  const kind = createMemo(() => props.channel.target.kind);
  const effects = createMemo(() => props.channel.effects);
  const definitions = createMemo(() => laneDefinitions(kind(), effects()));
  const update = (index: number, recipe: (lane: AutomationLane) => void): void => {
    props.onEdit((target) => {
      const lane = target.patterns[number()]?.lanes[index];
      if (lane) {
        recipe(lane);
      }
    });
  };
  const add = (): void => {
    const [definition] = definitions();
    if (!definition) {
      return;
    }
    props.onEdit((target) => {
      let cell = target.cells[props.bar] ?? 0;
      if (cell === 0) {
        const free = Object.entries(target.patterns).find(
          ([candidate, candidatePattern]) =>
            !target.cells.includes(Number(candidate)) &&
            candidatePattern.notes.length === 0 &&
            candidatePattern.lanes.length === 0,
        );
        cell = free
          ? Number(free[0])
          : Math.max(0, ...Object.keys(target.patterns).map(Number)) + 1;
        target.cells[props.bar] = cell;
        target.patterns[cell] ??= {
          notes: [],
          lanes: [],
        };
      }
      const lane: AutomationLane = {
        id: uniqueId(),
        target: definition.value.split(":").at(-1) ?? definition.value,
        points: [
          {
            time: 0,
            value: definition.base,
          },
          {
            time: props.song.beatsPerBar,
            value: definition.base,
          },
        ],
        interpolation: "linear",
        enabled: true,
      };
      if (definition.effectId !== undefined && definition.effectId !== "") {
        lane.effectId = definition.effectId;
      }
      target.patterns[cell]?.lanes.push(lane);
    });
  };
  return (
    <section class="automation-lanes" aria-label="Automation lanes">
      <div class="section-heading">
        <h3>ENVELOPES</h3>
        <button
          type="button"
          class="control"
          aria-label="Add automation lane"
          title="Add a change over this bar"
          disabled={definitions().length === 0}
          onClick={add}
        >
          <Icon name="plus" leading />
          Add lane
        </button>
      </div>
      <Index each={pattern()?.lanes}>
        {(lane, index) => {
          const key = createMemo(() =>
            lane().effectId !== undefined && lane().effectId !== ""
              ? `effect:${lane().effectId}:${lane().target}`
              : lane().target,
          );
          const definition = createMemo(() => definitions().find((item) => item.value === key()));
          const selectedTarget = createMemo(() =>
            lane().enabled ? (definition()?.value ?? "") : "",
          );
          const min = createMemo(
            () => definition()?.min ?? Math.min(0, ...lane().points.map((point) => point.value)),
          );
          const max = createMemo(
            () => definition()?.max ?? Math.max(1, ...lane().points.map((point) => point.value)),
          );
          return (
            <section class="effect-card automation-lane" aria-label="Automation lane">
              <div class="effect-heading">
                <SelectWrap>
                  <select
                    class="control"
                    aria-label="Target"
                    title="Choose what this lane changes over the bar"
                    ref={selectValueRef(selectedTarget, definitions)}
                    disabled={definitions().length === 0}
                    onChange={(event) => {
                      const next = definitions().find(
                        (item) => item.value === event.currentTarget.value,
                      );
                      if (next) {
                        update(index, (target) => {
                          target.target = next.value.split(":").at(-1) ?? next.value;
                          if (next.effectId !== undefined && next.effectId !== "") {
                            target.effectId = next.effectId;
                          } else {
                            delete target.effectId;
                          }
                          target.enabled = true;
                          if (next.value === "nextBar") {
                            target.interpolation = "hold";
                          }
                          for (const point of target.points) {
                            point.value = Math.max(next.min, Math.min(next.max, point.value));
                          }
                        });
                      }
                    }}
                  >
                    {selectedTarget() === "" && <option value="" disabled aria-hidden="true" />}
                    <Index each={definitions()}>
                      {(item) => <option value={item().value}>{item().label}</option>}
                    </Index>
                  </select>
                </SelectWrap>
                <button
                  type="button"
                  class="icon-button danger"
                  aria-label={`Remove ${lane().target} lane`}
                  title="Remove this change from the bar"
                  onClick={() => {
                    props.onEdit((target) => {
                      target.patterns[number()]?.lanes.splice(index, 1);
                    });
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
              <SelectControl
                label="Interpolation"
                tooltip="Jump between values or change smoothly"
                value={lane().interpolation}
                options={lane().target === "nextBar" ? ["hold"] : ["hold", "linear"]}
                onChange={(value) => {
                  update(index, (target) => {
                    target.interpolation = value === "hold" ? "hold" : "linear";
                  });
                }}
              />
              <AutomationGraph
                label={`${definition()?.label ?? lane().target} automation graph`}
                points={lane().points}
                beats={props.song.beatsPerBar}
                min={min()}
                max={max()}
                interpolation={lane().interpolation}
                onPreview={(points) => {
                  props.onPreview(
                    points
                      ? (target): void => {
                          const selectedLane = target.patterns[number()]?.lanes[index];
                          if (selectedLane) {
                            selectedLane.points = points;
                          }
                        }
                      : null,
                  );
                }}
                onChange={(points) => {
                  update(index, (target) => {
                    target.points = points;
                  });
                }}
              />
              <div class="automation-points">
                <Index each={Object.entries(lane().points)}>
                  {(pointEntry) => {
                    const pointIndex = createMemo(() => Number(pointEntry()[0]));
                    return (
                      <div class="automation-point">
                        <NumericInput
                          class="control numeric"
                          aria-label={`Point ${pointIndex() + 1} beat`}
                          title="Beat where this change happens"
                          min={0}
                          max={props.song.beatsPerBar}
                          step={1 / 24}
                          value={pointEntry()[1].time}
                          onCommit={(value) => {
                            if (Number.isFinite(value)) {
                              update(index, (target) => {
                                const item = target.points[pointIndex()];
                                if (item) {
                                  item.time = Math.max(0, Math.min(props.song.beatsPerBar, value));
                                }
                                target.points.sort((a, b) => a.time - b.time);
                              });
                            }
                          }}
                        />
                        <NumericInput
                          class="control numeric"
                          aria-label={`Point ${pointIndex() + 1} value`}
                          title="Setting reached at this point"
                          min={min()}
                          max={max()}
                          step={0.01}
                          value={pointEntry()[1].value}
                          onCommit={(value) => {
                            if (Number.isFinite(value)) {
                              update(index, (target) => {
                                const item = target.points[pointIndex()];
                                if (item) {
                                  item.value = Math.max(min(), Math.min(max(), value));
                                }
                              });
                            }
                          }}
                        />
                        <span class="unit">{definition()?.unit}</span>
                        <button
                          type="button"
                          class="icon-button danger"
                          aria-label={`Remove point ${pointIndex() + 1}`}
                          title="Remove this point from the movement"
                          onClick={() => {
                            update(index, (target) => {
                              target.points.splice(pointIndex(), 1);
                            });
                          }}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    );
                  }}
                </Index>
              </div>
            </section>
          );
        }}
      </Index>
    </section>
  );
};

// Automations process instrument, channel or Song output through independent effect chains
// without modifying instrument properties or Quick Effects.
export const AutomationPanel = (props: AutomationPanelProps): JSX.Element => {
  const tracks = createMemo(() => props.song.channels.filter((row) => row.kind === "track"));
  const selected = createMemo(() =>
    tracks().find((row) => row.id === props.channel.target.channelId),
  );
  const edit = (recipe: (channel: Channel) => void): void => {
    const next = structuredClone(props.channel);
    recipe(next);
    props.onChange(next);
  };
  const preview: ChannelPreview = (recipe) => {
    if (!recipe) {
      props.onPreview(null);
      return;
    }
    const next = structuredClone(props.channel);
    recipe(next);
    props.onPreview(next);
  };
  return (
    <section class="instrument-panel" aria-label="Automation Settings">
      <h2>AUTOMATION SETTINGS</h2>
      <SelectControl
        label="Target"
        tooltip="Choose which sound the automation affects"
        value={props.channel.target.kind}
        options={[
          {
            value: "instrument",
            label: "Instrument",
          },
          {
            value: "channel",
            label: "Channel",
          },
          {
            value: "song",
            label: "Song",
          },
        ]}
        onChange={(value) => {
          edit((target) => {
            if (value === "song") {
              target.target = {
                kind: "song",
              };
            } else if (value === "channel") {
              target.target = {
                kind: "channel",
                channelId: tracks()[0]?.id ?? "",
              };
            } else {
              target.target = {
                kind: "instrument",
                channelId: tracks()[0]?.id ?? "",
                instrumentId: tracks()[0]?.instruments[0]?.id ?? "",
              };
            }
            Object.values(target.patterns).forEach((pattern) => {
              pattern.lanes.forEach((lane) => {
                if (value !== "song" && (lane.effectId === undefined || lane.effectId === "")) {
                  lane.enabled = false;
                }
              });
            });
          });
        }}
      />
      {props.channel.target.kind !== "song" && (
        <SelectControl
          label="Track"
          tooltip="Choose the track affected by automation"
          value={props.channel.target.channelId ?? ""}
          options={[
            ...(selected()
              ? []
              : [
                  {
                    value: props.channel.target.channelId ?? "",
                    label: "Disconnected target",
                  },
                ]),
            ...tracks().map((row) => ({
              value: row.id,
              label: row.name,
            })),
          ]}
          onChange={(value) => {
            edit((target) => {
              target.target.channelId = value;
              if (target.target.kind === "instrument") {
                target.target.instrumentId =
                  tracks().find((row) => row.id === value)?.instruments[0]?.id ?? "";
              }
            });
          }}
        />
      )}
      {props.channel.target.kind === "instrument" && selected() ? (
        <SelectControl
          label="Instrument"
          tooltip="Choose the instrument affected by automation"
          value={props.channel.target.instrumentId ?? ""}
          options={(selected()?.instruments ?? []).map((instrument, index) => ({
            value: instrument.id,
            label: `${index + 1}. ${instrument.preset || instrument.type}`,
          }))}
          onChange={(value) => {
            edit((target) => {
              target.target.instrumentId = value;
            });
          }}
        />
      ) : null}
      <EffectChain
        effects={props.channel.effects}
        copiedEffect={props.copiedEffect}
        onCopyEffect={props.onCopyEffect}
        onPreview={(effects) => {
          preview(
            effects
              ? (target): void => {
                  remapFilterBindings(target, effects);
                  target.effects = effects;
                }
              : null,
          );
        }}
        onChange={(effects) => {
          edit((target) => {
            remapFilterBindings(target, effects);
            target.effects = effects;
            const ids = new Set(effects.map((effect) => effect.id));
            Object.values(target.patterns).forEach((pattern) => {
              pattern.lanes.forEach((lane) => {
                if (
                  lane.effectId !== undefined &&
                  lane.effectId !== "" &&
                  !ids.has(lane.effectId)
                ) {
                  lane.enabled = false;
                }
              });
            });
          });
        }}
      />
      <AutomationEditor
        channel={props.channel}
        song={props.song}
        bar={props.bar}
        onEdit={edit}
        onPreview={preview}
      />
    </section>
  );
};

// Always expose detailed controls for presets and custom sounds. Type opens grouped tabs;
// choosing a type/preset commits one edit, while browsing or cancelling preserves the sound.
const InstrumentControls = (
  props: InstrumentPanelProps & {
    readonly instrument: Instrument;
  },
): JSX.Element => {
  const [typeOpen, setTypeOpen] = createSignal(false);
  const index = createMemo(() =>
    Math.min(props.selectedInstrument, props.channel.instruments.length - 1),
  );
  const instrument = (): Instrument => props.instrument;
  const edit = (recipe: (instrument: Instrument) => void, keepPreset = false): void => {
    const next = structuredClone(props.channel);
    const target = next.instruments[index()];
    if (!target) {
      return;
    }
    recipe(target);
    if (!keepPreset) {
      target.preset = "";
    }
    props.onChange(next);
  };
  const preview = (recipe: Parameters<InstrumentPreview>[0], keepPreset = false): void => {
    if (!recipe) {
      props.onPreview(null);
      return;
    }
    const next = structuredClone(props.channel);
    const target = next.instruments[index()];
    if (!target) {
      return;
    }
    recipe(target);
    if (!keepPreset) {
      target.preset = "";
    }
    props.onPreview(next);
  };
  const replace = (next: Instrument): void => {
    next.id = instrument().id;
    edit((target) => {
      Object.assign(target, next);
    }, true);
  };
  return (
    <section class="instrument-panel" aria-label="Instrument Settings">
      <div class="number-bar" aria-label="Instruments">
        <Index each={props.channel.instruments}>
          {(_, number) => (
            <button
              type="button"
              class="control toggle-button"
              aria-label={`Instrument ${number + 1}`}
              title="Choose the instrument to edit"
              aria-pressed={number === index()}
              onClick={() => {
                props.onSelectInstrument(number);
              }}
            >
              {number + 1}
            </button>
          )}
        </Index>
        <button
          type="button"
          class="control"
          aria-label="Remove instrument"
          title="Remove this instrument from the track"
          disabled={props.channel.instruments.length <= 1}
          onClick={() => {
            const next = structuredClone(props.channel);
            next.instruments.splice(index(), 1);
            props.onChange(next);
            props.onSelectInstrument(Math.max(0, index() - 1));
          }}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          class="control"
          aria-label="Add instrument"
          title="Add another instrument to this track"
          disabled={props.channel.instruments.length >= 4}
          onClick={() => {
            const next = structuredClone(props.channel);
            next.instruments.push(createInstrument());
            props.onChange(next);
            props.onSelectInstrument(next.instruments.length - 1);
          }}
        >
          <Icon name="plus" />
        </button>
      </div>
      <fieldset class="settings-group instrument-identity" aria-label="Instrument controls">
        <NumericControl
          label="Volume"
          tooltip="Volume of this instrument in the mix"
          value={Math.round(instrument().volume * 100)}
          min={0}
          max={MAX_INSTRUMENT_VOLUME * 100}
          unit="%"
          onPreview={(value) => {
            preview(
              value === null
                ? null
                : (target): void => {
                    target.volume = value / 100;
                  },
              true,
            );
          }}
          onChange={(value) => {
            edit((target) => {
              target.volume = value / 100;
            }, true);
          }}
        />
        <div class="setting-row">
          <span title="Choose the instrument sound">Type</span>
          <button
            type="button"
            class="control type-button"
            title="Choose the instrument sound"
            onClick={() => {
              setTypeOpen(true);
              props.onDialogChange(true);
            }}
          >
            {instrument().preset || instrument().type}
          </button>
        </div>
        {instrument().type !== "drumset" && (
          <FadeEditor
            onPreview={(values) => {
              preview(
                values
                  ? (target): void => {
                      Object.assign(target, values);
                    }
                  : null,
              );
            }}
            attack={instrument().attack}
            release={instrument().release}
            onChange={(attack, release) => {
              edit((target) => {
                target.attack = attack;
                target.release = release;
              });
            }}
          />
        )}
        <SelectControl
          label="Transition"
          tooltip="How consecutive notes connect"
          value={instrument().transition}
          options={["normal", "interrupt", "continue", "slide", "slide in pattern"]}
          onChange={(value) => {
            edit((target) => {
              target.transition = value;
            });
          }}
        />
        <SelectControl
          label="Chords"
          tooltip="Play chord notes together or in sequence"
          value={instrument().chords}
          options={[
            "simultaneous",
            "strum",
            "arpeggio",
            ...(["chip wave", "FM (n-op)", "harmonics", "Custom chip wave"].includes(
              instrument().type,
            )
              ? ["custom interval"]
              : []),
          ]}
          onChange={(value) => {
            edit((target) => {
              target.chords = value;
            });
          }}
        />
        {instrument().chords === "arpeggio" && (
          <>
            <NumericControl
              label="Arpeggio Speed"
              tooltip="Speed of the repeating chord notes"
              value={instrument().arpeggioSpeed}
              min={0}
              max={8}
              step={0.05}
              unit="×"
              onChange={(value) => {
                edit((target) => {
                  target.arpeggioSpeed = value;
                });
              }}
            />
            <ToggleControl
              label="Fast Two-Note"
              tooltip="Play two-note arpeggios twice as fast"
              value={instrument().fastTwoNote}
              onChange={(value) => {
                edit((target) => {
                  target.fastTwoNote = value;
                });
              }}
            />
          </>
        )}
      </fieldset>
      <SoundEditor
        instrument={instrument()}
        assets={props.assets}
        onEdit={edit}
        onPreview={preview}
        onAddAssets={props.onAddAssets}
      />
      <EffectChain
        effects={instrument().effects}
        copiedEffect={props.copiedEffect}
        onCopyEffect={props.onCopyEffect}
        onPreview={(effects) => {
          preview(
            effects
              ? (target): void => {
                  remapFilterBindings(target, effects);
                  target.effects = effects;
                }
              : null,
          );
        }}
        onChange={(effects) => {
          edit((target) => {
            const ids = new Set(effects.map((effect) => effect.id));
            target.envelopes.forEach((envelope) => {
              if (
                envelope.target.startsWith("effect:") &&
                !ids.has(envelope.target.split(":")[1] ?? "")
              ) {
                envelope.enabled = false;
              }
            });
            remapFilterBindings(target, effects);
            target.effects = effects;
          });
        }}
      />
      <EnvelopeEditor
        instrument={instrument()}
        onChange={(envelopes) => {
          edit((target) => {
            target.envelopes = envelopes;
          });
        }}
      />
      {typeOpen() ? (
        <TypeDialog
          instrument={instrument()}
          assets={props.assets}
          onClose={() => {
            setTypeOpen(false);
            props.onDialogChange(false);
          }}
          onChoose={(next) => {
            replace(next);
            setTypeOpen(false);
            props.onDialogChange(false);
          }}
          onCopy={() => {
            props.onCopyInstrument();
            setTypeOpen(false);
            props.onDialogChange(false);
          }}
          onPaste={() => {
            props.onPasteInstrument();
            setTypeOpen(false);
            props.onDialogChange(false);
          }}
        />
      ) : null}
    </section>
  );
};
export const InstrumentPanel = (props: InstrumentPanelProps): JSX.Element => {
  const selected = createMemo(
    () =>
      props.channel.instruments[
        Math.min(props.selectedInstrument, props.channel.instruments.length - 1)
      ],
  );
  return (
    <Show
      when={selected()}
      fallback={
        <section class="instrument-panel">
          <p>No instrument selected.</p>
        </section>
      }
    >
      {(instrument) => <InstrumentControls {...props} instrument={instrument()} />}
    </Show>
  );
};
