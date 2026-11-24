import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";

import { Icon } from "./icons";
import type { MultiplayerState } from "./multiplayer";

const statusLabel = {
  offline: "Offline",
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Disconnected · Reconnecting…",
};

export const connectionLabel = (state: MultiplayerState): string =>
  state.status === "connected" && state.recovering ? "Resynchronizing…" : statusLabel[state.status];

export const MultiplayerDialog = (props: {
  readonly state: MultiplayerState;
  readonly connect: (address: string, password: string) => void;
  readonly disconnect: () => void;
}): JSX.Element => {
  const [address, setAddress] = createSignal(props.state.address ?? "");
  const otherEditors = (): number =>
    props.state.editors.filter((editor) => editor.id !== props.state.editorId).length;
  let password: HTMLInputElement | null = null;
  return (
    <div class="multiplayer-dialog">
      <output class="connection-summary">
        <span>
          {connectionLabel(props.state)}
          {props.state.status !== "offline" ? " to" : ""}
        </span>
        <Show when={props.state.status !== "offline"}>
          <input
            class="server-address"
            aria-label="Connected server address"
            readonly
            value={props.state.address ?? ""}
          />
        </Show>
      </output>
      <Show
        when={props.state.status === "offline"}
        fallback={
          <>
            <Show when={props.state.status === "connected"}>
              <p>
                {otherEditors() === 0
                  ? "You're the only editor"
                  : `${otherEditors()} other editor${otherEditors() === 1 ? "" : "s"}`}
              </p>
            </Show>
            <div class="dialog-actions">
              <button class="control" type="button" onClick={props.disconnect}>
                Disconnect
              </button>
            </div>
          </>
        }
      >
        <p>
          Joining makes the server's song your active song. Save your local work before connecting.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = password?.value ?? "";
            if (password) {
              password.value = "";
            }
            props.connect(address().trim(), value);
          }}
        >
          <label>
            Server WebSocket address
            <input
              class="control"
              required
              placeholder="wss://example.com"
              autocomplete="off"
              value={address()}
              onInput={(event) => {
                setAddress(event.currentTarget.value);
              }}
            />
          </label>
          <label>
            Password (optional)
            <input
              ref={(element) => {
                password = element;
              }}
              class="control"
              type="password"
              autocomplete="off"
            />
          </label>
          <div class="dialog-actions">
            <button class="control accent" type="submit">
              <Icon name="check" leading />
              Connect
            </button>
          </div>
        </form>
      </Show>
      <Show when={props.state.error}>
        <p role="alert">{props.state.error}</p>
      </Show>
    </div>
  );
};
