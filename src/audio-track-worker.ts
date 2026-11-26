import type { AudioTrackCommand, AudioTrackReply } from "./audio-thread-pool";
import { AudioTrackOutput } from "./audio-track-output";
import { AudioTrackSession, TrackPlanDecoder } from "./audio-track-session";

declare const postMessage: (reply: AudioTrackReply, transfer: Transferable[]) => void;
declare const addEventListener: (
  type: "message",
  listener: (event: MessageEvent<AudioTrackCommand>) => void,
) => void;

let session: AudioTrackSession | null = null;
let output: AudioTrackOutput | null = null;
const plans = new TrackPlanDecoder();
addEventListener("message", ({ data }) => {
  try {
    switch (data.type) {
      case "init": {
        session?.close();
        output = null;
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
        const plan = data.plan && plans.decode(data.plan);
        if (data.output !== undefined) {
          if (data.output !== true) {
            output = new AudioTrackOutput(data.output);
          }
          if (!output) {
            throw new Error("Track synthesis has no shared output buffer.");
          }
          const stems = session.render(data.frames, plan, output.buffers);
          postMessage(
            {
              type: "renderedShared",
              id: data.id,
              channelIds: stems.map((stem) => stem.channelId),
            },
            [],
          );
          break;
        }
        const stems = session.render(data.frames, plan);
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
