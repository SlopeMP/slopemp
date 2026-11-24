import { render } from "solid-js/web";

import { App } from "./app";
import { loadEditor } from "./browser-history";
import { installControlInteractions } from "./control-interactions";
installControlInteractions();

const container = document.querySelector("#root");
if (container === null) {
  throw new Error("Missing app root element.");
}
const initial = await loadEditor();
render(() => <App {...initial} />, container);

const registerServiceWorker = async (): Promise<void> => {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  try {
    await navigator.serviceWorker.register("./service-worker.js");
  } catch {
    // The editor can still run online if the browser denies service worker registration.
  }
};
void registerServiceWorker();
