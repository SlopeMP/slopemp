import type { AudioTrackCommand, AudioTrackReply } from "./audio-thread-pool";
import { AudioTrackSession, TrackPlanDecoder } from "./audio-track-session";

declare const postMessage: (reply: AudioTrackReply, transfer: Transferable[]) => void;
declare const addEventListener: (
  type: "message",
  listener: (event: MessageEvent<AudioTrackCommand>) => void,
) => void;

let session: AudioTrackSession | null = null;
const plans = new TrackPlanDecoder();
addEventListener("message", ({ data }) => {
  try {
    switch (data.type) {
      case "init": {
        session?.close();
        session = new AudioTrackSession(data.config, data.trackIds, data.resources);
        break;
      }
      case "update": {
        session?.update(data.command, data.trackIds, data.position);
        break;
      }
      case "render": {
        if (!session) {
          throw new Error("Track synthesis is not initialized.");
        }
        const stems = session.render(data.frames, data.plan && plans.decode(data.plan));
        postMessage(
          { type: "rendered", id: data.id, stems },
          stems.flatMap((stem) => [stem.left.buffer, stem.right.buffer]),
        );
        break;
      }
    }
  } catch (error) {
    postMessage({ type: "error", message: String(error) }, []);
  }
});
