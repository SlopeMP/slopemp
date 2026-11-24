import { expect, test } from "@playwright/test";

test("media session actions control playback and follow the transport state", async ({ page }) => {
  await page.addInitScript(() => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
    Object.defineProperty(navigator, "mediaSession", {
      value: {
        playbackState: "none",
        setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
          handlers.set(action, handler);
        },
      },
    });
    for (const action of ["play", "pause"] as const) {
      globalThis.addEventListener(`test-media-${action}`, () => {
        const handler = handlers.get(action);
        if (!handler) {
          throw new Error(`Missing media session handler for ${action}`);
        }
        handler({ action });
      });
    }
  });
  const dispatch = async (action: "pause" | "play"): Promise<void> => {
    await page.evaluate((value) => {
      globalThis.dispatchEvent(new Event(`test-media-${value}`));
    }, action);
  };
  const state = async (): Promise<MediaSessionPlaybackState> =>
    await page.evaluate(() => navigator.mediaSession.playbackState);
  const play = page.getByRole("button", { name: "Play", exact: true });
  const pause = page.getByRole("button", { name: "Pause", exact: true });

  await page.goto("./");
  await play.click();
  await expect.poll(state).toBe("playing");

  await dispatch("play");
  await expect(pause).toBeVisible();
  await dispatch("pause");
  await expect(play).toBeVisible();
  await expect.poll(state).toBe("paused");
  await dispatch("pause");
  await expect(play).toBeVisible();

  await dispatch("play");
  await expect(pause).toBeVisible();
  await expect.poll(state).toBe("playing");
  await pause.click();
  await expect.poll(state).toBe("paused");
});
