/* eslint-disable jsx-a11y/label-has-associated-control -- Solid labels use the native for attribute to associate controls. */
import { createMemo } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import type { AssetDraft } from "./asset-draft";
import { SelectWrap } from "./editors";
import { Icon } from "./icons";
import type { AssetView } from "./resource-identity";

type Props = {
  readonly entry: Accessor<AssetView>;
  readonly index: number;
  readonly draft?: AssetDraft;
  readonly disabled?: boolean;
  readonly urlDisabled?: boolean;
};
export const AssetFields = (props: Props): JSX.Element => {
  const { entry, draft } = props;
  return (
    <>
      <input
        class="control wide"
        aria-label={`Asset ${props.index + 1} URL`}
        placeholder="https://example.com/asset"
        value={entry().url}
        readOnly={draft === undefined}
        disabled={props.urlDisabled}
        onInput={(event) => {
          draft?.changeUrl(entry(), event.currentTarget.value);
        }}
        onBlur={() => {
          draft?.loadOnBlur(entry());
        }}
      />
      {entry().status === "error" && <p role="alert">{entry().error ?? "Loading failed."}</p>}
      {entry().type === "audio" && (
        <details>
          <summary title="Sample tuning and looping settings">
            <Icon name="chevron-right" />
            Playback metadata
          </summary>
          {(
            [
              [
                "rootKey",
                "Root MIDI key",
                0,
                127,
                "Note that plays the sample at its original pitch",
              ],
              [
                "start",
                "Start offset",
                0,
                Number.MAX_SAFE_INTEGER,
                "Where each note starts in the sample",
              ],
              [
                "loopStart",
                "Loop start",
                0,
                Number.MAX_SAFE_INTEGER,
                "Start of the repeating part of the sample",
              ],
              [
                "loopEnd",
                "Loop end",
                1,
                Number.MAX_SAFE_INTEGER,
                "End of the repeating part of the sample",
              ],
            ] as const
          ).map(([key, label, min, max, tooltip]) => {
            const maximum = (): number =>
              key === "start" || key === "loopStart" || key === "loopEnd"
                ? (entry().frames ?? max)
                : max;
            const defaultValue = (): number | undefined => {
              if (key === "rootKey") {
                return 60;
              }
              return key === "loopEnd" ? entry().frames : 0;
            };
            const value = createMemo(() => entry()[key] ?? defaultValue());
            return (
              <div class="setting-row">
                <label for={`resource-${key}-${entry().id}`} title={tooltip}>
                  {label}
                </label>
                <input
                  id={`resource-${key}-${entry().id}`}
                  class="control numeric"
                  aria-label={`${entry().name} ${label}`}
                  type="number"
                  min={min}
                  max={maximum()}
                  value={value()}
                  readOnly={draft === undefined}
                  disabled={props.disabled}
                  onInput={(e) => {
                    const field = e.currentTarget;
                    const input = field.valueAsNumber;
                    if (Number.isFinite(input)) {
                      const clamped = Math.max(min, Math.min(maximum(), input));
                      if (input !== clamped) {
                        field.valueAsNumber = clamped;
                      }
                      draft?.update(entry().id, (v) => {
                        v[key] = clamped;
                      });
                    }
                  }}
                />
              </div>
            );
          })}
          <div class="setting-row">
            <label for={`resource-mode-${entry().id}`} title="How the sample repeats or stops">
              Playback mode
            </label>
            <SelectWrap>
              <select
                id={`resource-mode-${entry().id}`}
                class="control"
                aria-label={`${entry().name} playback mode`}
                value={entry().mode ?? "Loop"}
                disabled={draft === undefined || props.disabled}
                onChange={(e) => {
                  draft?.update(entry().id, (v) => {
                    v.mode = e.target.value;
                  });
                }}
              >
                {["Loop", "Ping-Pong", "Play Once", "Play Loop Once"].map((mode) => (
                  <option>{mode}</option>
                ))}
              </select>
            </SelectWrap>
          </div>
          <label class="setting-row" title="Play the sample in reverse">
            Backwards
            <input
              class="switch"
              type="checkbox"
              checked={entry().backwards ?? false}
              disabled={draft === undefined || props.disabled}
              onChange={(e) => {
                draft?.update(entry().id, (v) => {
                  v.backwards = e.target.checked;
                });
              }}
            />
          </label>
        </details>
      )}
    </>
  );
};
