import { applyAudioResourceUpdate, prepareStemPlan, SongRenderer } from "./audio";
import type { AudioResourceUpdate, RendererClock, RenderPlan } from "./audio";
import type { TrackPoolConfig, TrackPosition, TrackStem, TrackUpdate } from "./audio-thread-pool";

export type StereoBlock = { left: Float32Array; right: Float32Array };

export const updateTrackConfig = (config: TrackPoolConfig, command: TrackUpdate): void => {
  if (command.type === "song") {
    config.song = command.song;
  } else if (command.type === "play") {
    config.playing = true;
    config.recording = command.recording;
  } else if (command.type === "pause") {
    config.playing = false;
  } else if (command.type === "muted") {
    config.muted = command.muted;
  }
};

// A track and the automation targeting its channels/instruments stay on one worker.
// Keeping one renderer per track lets ownership remain stable when tracks are added.
export class AudioTrackSession {
  private renderers = new Map<string, SongRenderer>();
  private readonly config: TrackPoolConfig;
  private silentBuffers: StereoBlock | null = null;

  public constructor(
    config: TrackPoolConfig,
    trackIds: readonly string[],
    resources: readonly AudioResourceUpdate[] = [],
  ) {
    this.config = { ...config };
    for (const update of resources) {
      applyAudioResourceUpdate(update);
    }
    this.assign(trackIds, config);
  }

  public update(command: TrackUpdate, trackIds: readonly string[], position: TrackPosition): void {
    if (command.type === "resource") {
      applyAudioResourceUpdate(command.update);
      return;
    }
    updateTrackConfig(this.config, command);
    if (command.type === "song") {
      this.assign(trackIds, position);
    }
    for (const [channelId, renderer] of this.renderers) {
      switch (command.type) {
        case "song": {
          renderer.song = this.config.song;
          if (renderer.bar >= this.config.song.barCount) {
            renderer.seek(this.config.song.barCount - 1);
          }
          break;
        }
        case "play": {
          renderer.seek(command.bar);
          renderer.recording = command.recording;
          renderer.playing = true;
          break;
        }
        case "pause": {
          renderer.playing = false;
          renderer.releaseAll();
          renderer.seek(command.bar);
          break;
        }
        case "seek": {
          renderer.seek(command.bar);
          renderer.beat = Math.max(
            0,
            Math.min(command.beat, this.config.song.beatsPerBar - 1 / 24),
          );
          break;
        }
        case "muted": {
          renderer.muted = new Set(command.muted);
          break;
        }
        case "audition": {
          if (command.channelId === channelId) {
            const channel = this.config.song.channels.find((item) => item.id === channelId);
            if (channel) {
              renderer.audition(channel, command.pitch);
            }
          } else {
            renderer.release(command.pitch);
          }
          break;
        }
        case "release": {
          renderer.release(command.pitch);
          break;
        }
        case "releaseAll": {
          renderer.releaseAll();
          break;
        }
      }
    }
  }

  public render(
    frames: number,
    plan?: RenderPlan,
    outputs?: ReadonlyMap<string, StereoBlock>,
  ): TrackStem[] {
    if (plan && plan.frames.length !== frames) {
      throw new Error("Audio render plan length does not match the output block.");
    }
    const stems: TrackStem[] = [];
    const block = plan && prepareStemPlan(plan);
    for (const [channelId, renderer] of this.renderers) {
      if (block && renderer.skipSilentStem(block)) {
        continue;
      }
      let buffers = outputs?.get(channelId);
      if (!outputs) {
        buffers =
          this.silentBuffers?.left.length === frames
            ? this.silentBuffers
            : { left: new Float32Array(frames), right: new Float32Array(frames) };
      }
      if (buffers?.left.length !== frames || buffers.right.length !== frames) {
        throw new Error("Audio track output does not match the render block.");
      }
      const { left, right } = buffers;
      if (block && !renderer.processStem(left, right, block)) {
        if (!outputs) {
          this.silentBuffers = buffers;
        }
        continue;
      }
      if (!block) {
        renderer.process(left, right);
      }
      stems.push({ channelId, left, right });
      this.silentBuffers = null;
    }
    return stems;
  }

  public close(): void {
    for (const renderer of this.renderers.values()) {
      renderer.reset();
    }
    this.renderers.clear();
    this.silentBuffers = null;
  }

  private assign(trackIds: readonly string[], position: TrackPosition): void {
    const assigned = new Set(trackIds);
    for (const [id, renderer] of this.renderers) {
      if (!assigned.has(id)) {
        renderer.reset();
      }
    }
    const renderers = new Map<string, SongRenderer>();
    for (const id of trackIds) {
      const existing = this.renderers.get(id);
      if (existing) {
        renderers.set(id, existing);
        continue;
      }
      const renderer = new SongRenderer(
        this.config.song,
        this.config.sampleRate,
        position.bar,
        this.config.sequence,
        {
          channelIds: new Set([id]),
          master: false,
        },
      );
      renderer.beat = position.beat;
      if (position.clock) {
        renderer.synchronizeClock(position.clock);
      }
      renderer.playing = this.config.playing;
      renderer.recording = this.config.recording;
      renderer.muted = new Set(this.config.muted);
      renderers.set(id, renderer);
    }
    this.renderers = renderers;
  }
}

type Frame = RenderPlan["frames"][number];
type Globals = Frame["globals"];
type Transport = Pick<Frame, "bar" | "barVisit" | "playing" | "sequenceIndex">;
type Control = keyof Globals;
type NumericColumn = Float64Array | number;
type PlanGlobals = Record<Control, NumericColumn>;

export type TrackRenderPlan = {
  clock: Float64Array;
  transport: Float64Array | Transport;
  globals: PlanGlobals;
  end: RendererClock;
  playing: boolean;
};

const clockSize = 3;
const transportSize = 4;
const zeroGlobals: Globals = { tempo: 0, volume: 0, detune: 0 };
const emptyFrame = (globals: Globals): Frame => ({
  bar: 0,
  beat: 0,
  seconds: 0,
  elapsedBeat: 0,
  barVisit: 0,
  sequenceIndex: 0,
  playing: false,
  globals,
});

const sameTransport = (left: Frame, right: Frame): boolean =>
  Object.is(left.bar, right.bar) &&
  Object.is(left.barVisit, right.barVisit) &&
  Object.is(left.sequenceIndex, right.sequenceIndex) &&
  left.playing === right.playing;

const packTransport = (frames: Frame[]): Float64Array => {
  const data = new Float64Array(frames.length * transportSize);
  let offset = 0;
  for (const { bar, barVisit, sequenceIndex, playing } of frames) {
    data[offset++] = bar;
    data[offset++] = barVisit;
    data[offset++] = sequenceIndex;
    data[offset++] = Number(playing);
  }
  return data;
};

const packControl = (
  frames: Frame[],
  control: Control,
  initial: number,
  varies: boolean,
): NumericColumn => {
  if (!varies) {
    return initial;
  }
  const data = new Float64Array(frames.length);
  let offset = 0;
  for (const { globals } of frames) {
    data[offset++] = globals[control];
  }
  return data;
};

// Every sample keeps the original clock doubles. Transport and controls that
// stay constant for the block are sent once to each worker.
export const packTrackPlan = ({ frames, end, playing }: RenderPlan): TrackRenderPlan => {
  const first = frames[0] ?? emptyFrame(zeroGlobals);
  const { bar, barVisit, sequenceIndex, playing: framePlaying, globals } = first;
  const clock = new Float64Array(frames.length * clockSize);
  let variesTransport = false;
  let variesTempo = false;
  let variesVolume = false;
  let variesDetune = false;
  let offset = 0;
  for (const frame of frames) {
    clock[offset++] = frame.beat;
    clock[offset++] = frame.seconds;
    clock[offset++] = frame.elapsedBeat;
    variesTransport ||= !sameTransport(frame, first);
    const current = frame.globals;
    if (current !== globals) {
      variesTempo ||= !Object.is(current.tempo, globals.tempo);
      variesVolume ||= !Object.is(current.volume, globals.volume);
      variesDetune ||= !Object.is(current.detune, globals.detune);
    }
  }
  return {
    clock,
    transport: variesTransport
      ? packTransport(frames)
      : { bar, barVisit, sequenceIndex, playing: framePlaying },
    globals: {
      tempo: packControl(frames, "tempo", globals.tempo, variesTempo),
      volume: packControl(frames, "volume", globals.volume, variesVolume),
      detune: packControl(frames, "detune", globals.detune, variesDetune),
    },
    end,
    playing,
  };
};

const readControl = (column: NumericColumn, index: number): number =>
  typeof column === "number" ? column : (column[index] ?? 0);

export class TrackPlanDecoder {
  private readonly frames: Frame[] = [];
  private readonly spare: Frame[] = [];
  private readonly varyingGlobals: Globals[] = [];

  // A worker renders each message synchronously so its frame objects can be
  // reused after the session finishes reading them.
  public decode({ clock, transport, globals, end, playing }: TrackRenderPlan): RenderPlan {
    const count = clock.length / clockSize;
    const variesTransport = transport instanceof Float64Array;
    const { tempo, volume, detune } = globals;
    if (
      !Number.isInteger(count) ||
      (variesTransport && transport.length !== count * transportSize) ||
      (tempo instanceof Float64Array && tempo.length !== count) ||
      (volume instanceof Float64Array && volume.length !== count) ||
      (detune instanceof Float64Array && detune.length !== count)
    ) {
      throw new Error("Invalid worker render plan length.");
    }
    const fixedGlobals =
      typeof tempo === "number" && typeof volume === "number" && typeof detune === "number"
        ? { tempo, volume, detune }
        : null;
    const { frames, spare } = this;
    while (frames.length > count) {
      const frame = frames.pop();
      if (frame) {
        spare.push(frame);
      }
    }
    let clockOffset = 0;
    let transportOffset = 0;
    for (let index = 0; index < count; index++) {
      let values = fixedGlobals;
      if (!values) {
        values = this.varyingGlobals[index] ?? { ...zeroGlobals };
        this.varyingGlobals[index] ??= values;
        values.tempo = readControl(tempo, index);
        values.volume = readControl(volume, index);
        values.detune = readControl(detune, index);
      }
      const frame = frames[index] ?? spare.pop() ?? emptyFrame(values);
      frames[index] = frame;
      frame.globals = values;
      frame.beat = clock[clockOffset++] ?? 0;
      frame.seconds = clock[clockOffset++] ?? 0;
      frame.elapsedBeat = clock[clockOffset++] ?? 0;
      if (variesTransport) {
        frame.bar = transport[transportOffset++] ?? 0;
        frame.barVisit = transport[transportOffset++] ?? 0;
        frame.sequenceIndex = transport[transportOffset++] ?? 0;
        frame.playing = transport[transportOffset++] === 1;
      } else {
        frame.bar = transport.bar;
        frame.barVisit = transport.barVisit;
        frame.sequenceIndex = transport.sequenceIndex;
        frame.playing = transport.playing;
      }
    }
    return { frames, end, playing };
  }
}
