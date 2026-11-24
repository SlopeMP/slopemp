import { createSignal, For, Show } from "solid-js";
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
  let password: HTMLInputElement | null = null;
  return (
    <div class="multiplayer-dialog">
      <output>{connectionLabel(props.state)}</output>
      <Show
        when={props.state.status === "offline"}
        fallback={
          <>
            <p class="server-address">{props.state.address}</p>
            <Show when={props.state.editors.length > 0}>
              <h3>Connected editors</h3>
              <ul class="connected-editors">
                <For each={props.state.editors}>
                  {(editor) => (
                    <li>
                      <span class="editor-color" style={{ "background-color": editor.color }} />
                      <span>
                        {editor.id === props.state.editorId
                          ? "You"
                          : `Editor ${editor.id.slice(0, 8)}`}
                      </span>
                      <Show when={editor.selection}>
                        {(selection) => (
                          <span class="editor-location">
                            Bar {selection().bar + 1} · Pattern {selection().pattern ?? 0}
                          </span>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
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
