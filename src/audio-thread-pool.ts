import type {
  AudioCommand,
  AudioResourceUpdate,
  RendererClock,
  RenderPlan,
  SongRenderer,
} from "./audio";
import { audioResourceIds } from "./audio-resource-ids";
import { AudioTrackSession, packTrackPlan, updateTrackConfig } from "./audio-track-session";
import type { StereoBlock, TrackRenderPlan } from "./audio-track-session";
import type { Song } from "./model";
import { normalizeAudioThreads } from "./preferences";

export type TrackPosition = { bar: number; beat: number; clock?: RendererClock };
export type TrackPoolConfig = TrackPosition & {
  song: Song;
  sampleRate: number;
  playing: boolean;
  recording: boolean;
  muted: string[];
  threadCount: number;
  sequence?: number[];
};
export type TrackStem = StereoBlock & { channelId: string };
export type TrackUpdate = Exclude<AudioCommand, { type: "init" | "threads" | "volume" }>;
export type AudioTrackCommand =
  | {
      type: "init";
      config: TrackPoolConfig;
      trackIds: string[];
      resources: AudioResourceUpdate[];
    }
  | { type: "render"; id: number; frames: number; plan?: TrackRenderPlan }
  | { type: "update"; command: TrackUpdate; trackIds: string[]; position: TrackPosition };
export type AudioTrackReply =
  { type: "error"; message: string } | { type: "rendered"; id: number; stems: TrackStem[] };

type PendingRender = {
  resolve: (stems: TrackStem[]) => void;
  reject: (error: Error) => void;
};
type TrackResource = { update: AudioResourceUpdate; version: number };
type TrackWorker = {
  worker: Worker;
  trackIds: string[];
  resources: Map<string, number>;
  pending: Map<number, PendingRender>;
  failure: Error | null;
};

export const mixStems = (stems: readonly TrackStem[], length: number): StereoBlock => {
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const stem of stems) {
    for (let frame = 0; frame < length; frame++) {
      left[frame] = (left[frame] ?? 0) + (stem.left[frame] ?? 0);
      right[frame] = (right[frame] ?? 0) + (stem.right[frame] ?? 0);
    }
  }
  return { left, right };
};

// The coordinator is one processing thread. Remaining slots own stable tracks;
// track-local automation travels with its target instead of crossing threads.
export class AudioThreadPool {
  private config: TrackPoolConfig;
  private readonly workers: TrackWorker[] = [];
  private readonly resources = new Map<string, TrackResource>();
  private resourceVersion = 0;
  private local: AudioTrackSession | null = null;
  private taskId = 0;
  private closed = false;

  public constructor(config: TrackPoolConfig, resources: readonly AudioResourceUpdate[] = []) {
    this.config = { ...config, threadCount: normalizeAudioThreads(config.threadCount) };
    const trackIds = this.trackIds();
    if (this.config.threadCount === 1) {
      this.local = new AudioTrackSession(this.config, trackIds, resources);
    } else {
      for (const update of resources) {
        this.rememberResource(update);
      }
      this.assign(trackIds);
    }
  }

  public update(command: TrackUpdate, position: TrackPosition = this.config): void {
    this.ensureOpen();
    this.config = { ...this.config, ...position };
    updateTrackConfig(this.config, command);
    const trackIds = this.trackIds();
    if (this.local) {
      this.local.update(command, trackIds, position);
      return;
    }
    if (command.type === "song") {
      this.assign(trackIds);
    } else if (command.type === "resource") {
      this.rememberResource(command.update);
      for (const slot of this.workers) {
        if (command.update.type === "remove") {
          if (slot.resources.has(command.update.id)) {
            this.send(slot, { type: "update", command, trackIds: slot.trackIds, position });
          }
        } else {
          this.syncResources(slot, position);
        }
      }
      return;
    }
    for (const slot of this.workers) {
      if (command.type === "song") {
        this.syncResources(slot, position);
      }
      this.send(slot, { type: "update", command, trackIds: slot.trackIds, position });
      if (command.type === "song") {
        const ids = audioResourceIds(this.config.song, new Set(slot.trackIds));
        for (const id of slot.resources.keys()) {
          if (!ids.has(id)) {
            this.send(slot, {
              type: "update",
              command: { type: "resource", update: { type: "remove", id } },
              trackIds: slot.trackIds,
              position,
            });
          }
        }
      }
    }
  }

  public async renderBlock(
    renderer: SongRenderer,
    frames: number,
    finite = false,
  ): Promise<StereoBlock> {
    const plan = renderer.preparePlan(frames, finite);
    const { length } = plan.frames;
    const block = mixStems(length === 0 ? [] : await this.render(length, plan), length);
    if (length > 0) {
      renderer.processMix(block.left, block.right, plan);
    }
    return block;
  }

  public async render(frames: number, plan?: RenderPlan): Promise<TrackStem[]> {
    this.ensureOpen();
    if (this.local) {
      return this.local.render(frames, plan);
    }
    const trackPlan = plan && packTrackPlan(plan);
    const id = this.taskId++;
    const trackIds = this.trackIds();
    const groups = await Promise.all(
      this.workers.map(async (slot): Promise<TrackStem[]> => {
        if (slot.failure) {
          throw slot.failure;
        }
        return await new Promise<TrackStem[]>((resolve, reject) => {
          slot.pending.set(id, { resolve, reject });
          this.send(slot, { type: "render", id, frames, ...(trackPlan && { plan: trackPlan }) });
        });
      }),
    );
    const stems = new Map(groups.flat().map((stem) => [stem.channelId, stem]));
    // Mix in the order at the start of the block, independent of worker completion.
    return trackIds.flatMap((channelId) => {
      const stem = stems.get(channelId);
      return stem ? [stem] : [];
    });
  }

  public close(): void {
    this.closed = true;
    this.local?.close();
    this.local = null;
    for (const slot of this.workers) {
      this.fail(slot, new Error("Audio thread pool closed."));
      slot.worker.terminate();
    }
    this.workers.length = 0;
  }

  private trackIds(): string[] {
    return this.config.song.channels
      .filter((channel) => channel.kind === "track")
      .map((channel) => channel.id);
  }

  private assign(trackIds: readonly string[]): void {
    const unassigned = new Set(trackIds);
    for (const slot of this.workers) {
      slot.trackIds = slot.trackIds.filter((id) => unassigned.delete(id));
    }
    const existing = this.workers.length;
    for (const id of unassigned) {
      let owner = this.workers.find((slot) => slot.trackIds.length === 0);
      if (!owner && this.workers.length < this.config.threadCount - 1) {
        owner = this.addWorker();
      }
      owner ??= this.workers.reduce<TrackWorker | undefined>(
        (least, slot) => (!least || slot.trackIds.length < least.trackIds.length ? slot : least),
        undefined,
      );
      if (!owner) {
        throw new Error("No audio processing thread is available.");
      }
      owner.trackIds.push(id);
    }
    for (const slot of this.workers.slice(existing)) {
      this.send(slot, {
        type: "init",
        config: this.config,
        trackIds: slot.trackIds,
        resources: this.resourceUpdates(slot),
      });
    }
    for (const slot of this.workers.filter((worker) => worker.trackIds.length === 0)) {
      this.fail(slot, new Error("Audio track worker no longer has tracks."));
      slot.worker.terminate();
      this.workers.splice(this.workers.indexOf(slot), 1);
    }
  }

  private addWorker(): TrackWorker {
    const worker = new Worker(new URL("./audio-track-worker.js", import.meta.url), {
      type: "module",
    });
    const slot: TrackWorker = {
      worker,
      trackIds: [],
      resources: new Map(),
      pending: new Map(),
      failure: null,
    };
    worker.addEventListener("error", (event) => {
      this.fail(slot, new Error(event.message || "Audio track worker failed."));
    });
    worker.addEventListener("message", (event: MessageEvent<AudioTrackReply>) => {
      const reply = event.data;
      if (reply.type === "error") {
        this.fail(slot, new Error(reply.message));
      } else {
        slot.pending.get(reply.id)?.resolve(reply.stems);
        slot.pending.delete(reply.id);
      }
    });
    this.workers.push(slot);
    return slot;
  }

  private send(slot: TrackWorker, command: AudioTrackCommand): void {
    try {
      slot.worker.postMessage(command, []);
      if (command.type === "init") {
        for (const update of command.resources) {
          this.markResourceSent(slot, update.id);
        }
      } else if (command.type === "update" && command.command.type === "resource") {
        const { update } = command.command;
        if (update.type === "remove") {
          slot.resources.delete(update.id);
        } else {
          this.markResourceSent(slot, update.id);
        }
      }
    } catch (error) {
      this.fail(slot, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private resourceUpdates(slot: TrackWorker): AudioResourceUpdate[] {
    return [...audioResourceIds(this.config.song, new Set(slot.trackIds))].flatMap((id) => {
      const resource = this.resources.get(id);
      return resource && resource.version !== slot.resources.get(id) ? [resource.update] : [];
    });
  }

  private syncResources(slot: TrackWorker, position: TrackPosition): void {
    for (const update of this.resourceUpdates(slot)) {
      this.send(slot, {
        type: "update",
        command: { type: "resource", update },
        trackIds: slot.trackIds,
        position,
      });
    }
  }

  private markResourceSent(slot: TrackWorker, id: string): void {
    const resource = this.resources.get(id);
    if (resource) {
      slot.resources.set(id, resource.version);
    } else {
      slot.resources.delete(id);
    }
  }

  private fail(slot: TrackWorker, error: Error): void {
    slot.failure = error;
    for (const pending of slot.pending.values()) {
      pending.reject(error);
    }
    slot.pending.clear();
  }

  private rememberResource(update: AudioResourceUpdate): void {
    if (update.type === "remove") {
      this.resources.delete(update.id);
    } else {
      this.resources.set(update.id, { update, version: this.resourceVersion++ });
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("Audio thread pool is closed.");
    }
  }
}
