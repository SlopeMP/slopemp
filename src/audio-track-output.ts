import type { TrackStem } from "./audio-thread-pool";
import type { StereoBlock } from "./audio-track-session";

export type TrackOutputConfig = {
  buffer: SharedArrayBuffer;
  frames: number;
  trackIds: readonly string[];
};

// The coordinator reads these samples only after the owning worker publishes
// its reply. The next render starts after mixing, so no sample atomics are needed.
export class AudioTrackOutput {
  public readonly config: TrackOutputConfig;
  public readonly buffers = new Map<string, StereoBlock>();

  public constructor(config: TrackOutputConfig) {
    this.config = config;
    const { buffer, frames, trackIds } = config;
    const channelBytes = frames * Float32Array.BYTES_PER_ELEMENT;
    for (const [index, channelId] of trackIds.entries()) {
      const offset = index * channelBytes * 2;
      this.buffers.set(channelId, {
        left: new Float32Array(buffer, offset, frames),
        right: new Float32Array(buffer, offset + channelBytes, frames),
      });
    }
  }

  public static create(frames: number, trackIds: readonly string[]): AudioTrackOutput {
    return new AudioTrackOutput({
      buffer: new SharedArrayBuffer(frames * trackIds.length * 2 * Float32Array.BYTES_PER_ELEMENT),
      frames,
      trackIds: [...trackIds],
    });
  }

  public matches(frames: number, trackIds: readonly string[]): boolean {
    const { config } = this;
    return (
      config.frames === frames &&
      config.trackIds.length === trackIds.length &&
      config.trackIds.every((id, index) => id === trackIds[index])
    );
  }

  public stems(channelIds: readonly string[]): TrackStem[] {
    return channelIds.map((channelId) => {
      const block = this.buffers.get(channelId);
      if (!block) {
        throw new Error("No shared audio output is assigned to this track.");
      }
      return { channelId, ...block };
    });
  }
}
