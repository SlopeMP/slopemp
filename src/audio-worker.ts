import { applyAudioResourceUpdate, isDedicatedWorker, SongRenderer } from "./audio";
import type { AudioCommand, AudioReply, AudioResourceUpdate } from "./audio";
import {
  audioBlockFrames,
  AudioOutputBuffer,
  nextAudioBlock,
  queuedAudioBlocks,
} from "./audio-output-buffer";
import { AudioThreadPool } from "./audio-thread-pool";
import { normalizeAudioThreads } from "./preferences";

// Commands and rendering share a block boundary across all workers. In particular,
// an edit received during synthesis cannot apply a new tempo to only half the mix.
export class AudioWorkerSession {
  private renderer: SongRenderer | null = null;
  private pool: AudioThreadPool | null = null;
  private output: AudioOutputBuffer | null = null;
  private volume = 0.75;
  private threadCount = 1;
  private observedRead = 0;
  private queued = 0;
  private time = 0;
  private work: Promise<void> = Promise.resolve();
  private readonly live = new Map<number, string>();
  private readonly resources = new Map<string, AudioResourceUpdate>();
  private readonly report: (reply: AudioReply) => void;

  public constructor(report: (reply: AudioReply) => void) {
    this.report = report;
  }

  public async handle(command: AudioCommand): Promise<void> {
    await this.enqueue(async () => {
      await this.apply(command);
    });
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const previous = this.work;
    this.work = (async (): Promise<void> => {
      await previous;
      try {
        await task();
      } catch (error) {
        this.report({ type: "error", message: String(error) });
      }
    })();
    await this.work;
  }

  private async apply(command: AudioCommand): Promise<void> {
    if (command.type === "resource") {
      const { update } = command;
      if (update.type === "remove") {
        this.resources.delete(update.id);
      } else {
        this.resources.set(update.id, update);
      }
      applyAudioResourceUpdate(update);
      this.pool?.update(command);
      return;
    }
    if (command.type === "init") {
      if (this.output) {
        throw new Error("Audio synthesis is already initialized.");
      }
      const output = new AudioOutputBuffer(command.output);
      const renderer = new SongRenderer(command.song, command.sampleRate, command.bar, undefined, {
        channelIds: new Set(),
      });
      renderer.beat = command.beat;
      renderer.playing = command.playing;
      renderer.recording = command.recording;
      renderer.muted = new Set(command.muted);
      this.renderer = renderer;
      this.volume = command.volume;
      this.threadCount = normalizeAudioThreads(command.threadCount);
      this.time = command.time;
      this.output = output;
      this.createPool(renderer);
      await this.restart(output, command.generation);
      this.report({ type: "ready" });
      void this.refillOnRead(output);
      return;
    }
    const { renderer, pool, output } = this;
    if (!renderer || !pool || !output) {
      return;
    }
    if (command.type === "threads") {
      const count = normalizeAudioThreads(command.threadCount);
      if (count !== this.threadCount) {
        this.threadCount = count;
        pool.close();
        this.createPool(renderer);
      }
      return;
    }
    if (command.type === "volume") {
      this.volume = command.volume;
      return;
    }
    pool.update(command, {
      bar: renderer.bar,
      beat: renderer.beat,
      clock: renderer.transportClock,
    });
    switch (command.type) {
      case "song": {
        renderer.song = command.song;
        if (renderer.bar >= command.song.barCount) {
          renderer.seek(command.song.barCount - 1);
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
        this.live.clear();
        renderer.playing = false;
        renderer.releaseAll();
        renderer.seek(command.bar);
        break;
      }
      case "seek": {
        renderer.seek(command.bar);
        renderer.beat = Math.max(0, Math.min(command.beat, renderer.song.beatsPerBar - 1 / 24));
        break;
      }
      case "muted": {
        renderer.muted = new Set(command.muted);
        break;
      }
      case "audition": {
        this.live.set(command.pitch, command.channelId);
        break;
      }
      case "release": {
        this.live.delete(command.pitch);
        break;
      }
      case "releaseAll": {
        this.live.clear();
        break;
      }
    }
    if ("generation" in command) {
      await this.restart(output, command.generation);
    }
  }

  private createPool(renderer: SongRenderer): void {
    this.pool = new AudioThreadPool(
      {
        song: renderer.song,
        sampleRate: renderer.sampleRate,
        bar: renderer.bar,
        beat: renderer.beat,
        clock: renderer.transportClock,
        playing: renderer.playing,
        recording: renderer.recording,
        muted: [...renderer.muted],
        threadCount: this.threadCount,
      },
      [...this.resources.values()],
    );
    for (const [pitch, channelId] of this.live) {
      this.pool.update({ type: "audition", channelId, pitch });
    }
  }

  private async restart(output: AudioOutputBuffer, generation: number): Promise<void> {
    this.collectConsumed(output);
    output.generation = generation;
    this.queued = 0;
    await this.fillAudio(output);
  }

  private async refillOnRead(output: AudioOutputBuffer): Promise<void> {
    try {
      for (;;) {
        // Wait outside the command queue so transport edits can run while audio is suspended.
        await output.waitForRead(this.observedRead);
        await this.enqueue(async () => {
          await this.fillAudio(output);
        });
      }
    } catch (error) {
      this.report({ type: "error", message: String(error) });
    }
  }

  private collectConsumed(output: AudioOutputBuffer): void {
    const { readIndex: read, generation } = output;
    while (this.observedRead !== read) {
      const id = this.observedRead;
      this.observedRead = nextAudioBlock(id);
      if (output.blockGeneration(id) === generation) {
        this.queued--;
        this.time = output.consumedTime(id);
        this.report({ type: "consumed", generation, id, time: this.time });
      }
    }
  }

  private async fillAudio(output: AudioOutputBuffer): Promise<void> {
    const { renderer, pool } = this;
    if (!renderer || !pool) {
      return;
    }
    this.collectConsumed(output);
    // Reclaim a slot only after recording its playback time.
    while (this.queued < queuedAudioBlocks && output.hasSpace(this.observedRead)) {
      await this.writeAudio(output, renderer, pool);
      this.queued++;
    }
  }

  private async writeAudio(
    output: AudioOutputBuffer,
    renderer: SongRenderer,
    pool: AudioThreadPool,
  ): Promise<void> {
    const start = renderer.bar + renderer.beat / renderer.song.beatsPerBar;
    const { left, right } = await pool.renderBlock(renderer, audioBlockFrames);
    const gain = Math.max(0, Math.min(1, this.volume)) ** 2;
    for (let index = 0; index < audioBlockFrames; index++) {
      left[index] = (left[index] ?? 0) * gain;
      right[index] = (right[index] ?? 0) * gain;
    }
    this.report({
      type: "block",
      generation: output.generation,
      block: {
        id: output.writeIndex,
        start,
        end: renderer.bar + renderer.beat / renderer.song.beatsPerBar,
        duration: audioBlockFrames / renderer.sampleRate,
        loopStart: renderer.song.loopStart,
        loopEnd: renderer.song.loopEnd,
      },
      state: {
        bar: renderer.bar,
        beat: renderer.beat,
        playing: renderer.playing,
      },
      time: this.time,
    });
    output.writeBlock(left, right);
  }
}

declare const postMessage: (reply: AudioReply) => void;

if (isDedicatedWorker()) {
  const session = new AudioWorkerSession((reply) => {
    postMessage(reply);
  });
  addEventListener("message", (event: MessageEvent<AudioCommand>) => {
    void session.handle(event.data);
  });
}
