import { expect, test } from "bun:test";

import {
  AudioEngine,
  installAudioResourceAlias,
  registerAudioResource,
  registerSoundFont,
  removeAudioResource,
} from "../../src/audio";
import type { AudioCommand, AudioReply } from "../../src/audio";
import { audioBlockFrames, queuedAudioBlocks } from "../../src/audio-output-buffer";
import { createInstrument } from "../../src/instruments";
import { createSong, required } from "../../src/model";

test("the audio bridge retains only song resources, forwards replacements, and rejects stale playback", async () => {
  const workers: FakeWorker[] = [];
  const contexts: FakeAudioContext[] = [];
  const nodes: FakeAudioWorkletNode[] = [];
  let autoReady = true;
  let initSeen: (() => void) | null = null;
  class FakeWorker extends EventTarget {
    public readonly commands: AudioCommand[] = [];
    public terminated = false;
    public constructor() {
      super();
      workers.push(this);
    }
    public postMessage(command: AudioCommand): void {
      this.commands.push(command.type === "resource" ? structuredClone(command) : command);
      if (command.type === "init") {
        initSeen?.();
        if (autoReady) {
          queueMicrotask(() => {
            this.initialize();
          });
        }
      }
    }
    public initialize(): void {
      const command = required(this.commands.find((item) => item.type === "init"));
      const position = command.bar + command.beat / command.song.beatsPerBar;
      for (let id = 0; id < queuedAudioBlocks; id++) {
        this.reply({
          type: "block",
          generation: command.generation,
          block: {
            id,
            start: position,
            end: position,
            duration: audioBlockFrames / command.sampleRate,
            loopStart: command.song.loopStart,
            loopEnd: command.song.loopEnd,
          },
          state: {
            bar: command.bar,
            beat: command.beat,
            playing: command.playing,
          },
          time: command.time,
        });
      }
      this.reply({ type: "ready" });
    }
    public reply(reply: AudioReply): void {
      this.dispatchEvent(new MessageEvent("message", { data: reply }));
    }
    public terminate(): void {
      this.terminated = true;
    }
  }
  class FakeAudioContext {
    public readonly sampleRate = 8000;
    public currentTime = 10;
    public state = "running";
    public readonly destination = {};
    public readonly modules: string[] = [];
    public readonly audioWorklet = {
      addModule: async (url: string): Promise<void> => {
        this.modules.push(url);
        await Promise.resolve();
      },
    };
    public constructor() {
      contexts.push(this);
    }
    public async close(): Promise<void> {
      this.state = "closed";
      await Promise.resolve();
    }
    public async resume(): Promise<void> {
      this.state = "running";
      await Promise.resolve();
    }
  }
  class FakeAudioWorkletNode extends EventTarget {
    public connected = false;
    public readonly output: SharedArrayBuffer;
    public constructor(
      _context: FakeAudioContext,
      _name: string,
      options: { processorOptions: { output: SharedArrayBuffer } },
    ) {
      super();
      this.output = options.processorOptions.output;
      nodes.push(this);
    }
    public connect(): void {
      this.connected = true;
    }
    public disconnect(): void {
      this.connected = false;
    }
  }
  const globals = {
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    Worker: FakeWorker,
    document: { baseURI: "https://example.com/slopemp/" },
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const sampleId = "audio-bridge-snapshot-pcm";
  const fontId = "audio-bridge-snapshot-sf";
  const liveId = "audio-bridge-live-pcm";
  const aliasId = "audio-bridge-alias-pcm";
  const fontAliasId = "audio-bridge-alias-sf";
  const cacheId = "resource-cache:audio-bridge-unused-font";
  const previewId = "asset-preview-audio-bridge-unused-font";
  const lateId = "audio-bridge-late-pcm";
  const left = new Float32Array([0, 0.25, -0.5, 0]);
  const right = new Float32Array([0, -0.25, 0.5, 0]);
  const font = await Bun.file(
    new URL("../assets/florestan-subset.sf2", import.meta.url),
  ).arrayBuffer();
  const song = createSong();
  const sampleInstrument = createInstrument("chip wave");
  sampleInstrument.resourceId = sampleId;
  const fontInstrument = createInstrument("SoundFont");
  fontInstrument.resourceId = fontId;
  const nativeInstrument = createInstrument("Custom chip wave");
  nativeInstrument.resourceId = cacheId;
  song.channels = song.channels.slice(0, 1);
  required(song.channels[0]).instruments = [
    sampleInstrument,
    fontInstrument,
    nativeInstrument,
    { ...fontInstrument, id: "shared-font-instrument" },
  ];
  const engine = new AudioEngine(song);
  const positions: Array<[number, number]> = [];
  engine.onPosition = (bar, beat): void => {
    positions.push([bar, beat]);
  };
  try {
    Object.assign(globalThis, globals);
    registerAudioResource(sampleId, left, right, 8000);
    registerSoundFont(fontId, font);
    installAudioResourceAlias(fontId, cacheId);
    installAudioResourceAlias(fontId, previewId);
    await engine.play(1);
    const worker = required(workers[0]);
    const init = required(worker.commands.find((command) => command.type === "init"));
    expect(positions).toEqual([]);
    expect(init).toMatchObject({
      bar: 1,
      beat: 0,
      playing: false,
    });
    const context = required(contexts[0]);
    const node = required(nodes[0]);
    expect(context.modules).toEqual(["https://example.com/slopemp/audio-worklet.js"]);
    expect(node.connected).toBe(true);
    expect(node.output).toBeInstanceOf(SharedArrayBuffer);
    expect(init.output).toBe(node.output);
    const initIndex = worker.commands.findIndex((command) => command.type === "init");
    const snapshots = worker.commands
      .slice(0, initIndex)
      .filter((command) => command.type === "resource")
      .map((command) => command.update);
    expect(snapshots.map((update) => update.id)).toEqual([sampleId, fontId]);
    expect(snapshots.filter((update) => "id" in update && update.id === sampleId)).toEqual([
      {
        type: "sample",
        id: sampleId,
        resource: {
          left,
          right,
          sampleRate: 8000,
        },
      },
    ]);
    const fonts = snapshots
      .filter((update) => update.type === "soundfont")
      .filter((update) => update.id === fontId);
    expect(fonts).toHaveLength(1);
    const snapshot = required(fonts[0]);
    expect(snapshot.font.samples.length).toBeGreaterThan(0);
    expect(snapshot.font.presets).toHaveLength(17);
    expect(required(required(snapshot.font.presets[0]).zones[0]).generators).toBeInstanceOf(Map);
    const checkpoint = worker.commands.length;
    registerAudioResource(liveId, right, left, 16_000);
    installAudioResourceAlias(liveId, aliasId);
    removeAudioResource(liveId);
    registerSoundFont(fontId, font);
    installAudioResourceAlias(fontId, fontAliasId);
    const updates = worker.commands
      .slice(checkpoint)
      .filter((command) => command.type === "resource");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ update: { type: "soundfont", id: fontId } });
    const beforeSong = worker.commands.length;
    const edited = structuredClone(song);
    edited.loopStart = 1;
    engine.setSong(edited);
    expect(worker.commands.slice(beforeSong)).toEqual([{ type: "song", song: edited }]);

    const switched = structuredClone(edited);
    const { instruments } = required(switched.channels[0]);
    required(instruments[0]).resourceId = aliasId;
    required(instruments[1]).resourceId = fontAliasId;
    required(instruments[3]).resourceId = fontAliasId;
    const beforeSwitch = worker.commands.length;
    engine.setSong(switched);
    const switchedCommands = worker.commands.slice(beforeSwitch);
    expect(switchedCommands.map((command) => command.type)).toEqual([
      "resource",
      "resource",
      "song",
      "resource",
      "resource",
    ]);
    expect(switchedCommands[0]).toMatchObject({
      update: { type: "sample", id: aliasId, resource: { left: right, right: left } },
    });
    expect(switchedCommands[1]).toMatchObject({
      update: { type: "soundfont", id: fontAliasId },
    });
    expect(switchedCommands.slice(3)).toEqual([
      { type: "resource", update: { type: "remove", id: sampleId } },
      { type: "resource", update: { type: "remove", id: fontId } },
    ]);

    const beforeReplacement = worker.commands.length;
    registerAudioResource(sampleId, left, left, 8000);
    registerSoundFont(fontId, font);
    expect(worker.commands).toHaveLength(beforeReplacement);
    removeAudioResource(aliasId);
    registerAudioResource(aliasId, right, right, 8000);
    expect(worker.commands.slice(beforeReplacement)).toMatchObject([
      { type: "resource", update: { type: "remove", id: aliasId } },
      { type: "resource", update: { type: "sample", id: aliasId } },
    ]);

    const missing = structuredClone(switched);
    required(required(missing.channels[0]).instruments[0]).resourceId = lateId;
    const beforeMissing = worker.commands.length;
    engine.setSong(missing);
    expect(worker.commands.slice(beforeMissing)).toEqual([
      { type: "song", song: missing },
      { type: "resource", update: { type: "remove", id: aliasId } },
    ]);
    registerAudioResource(lateId, left, right, 8000);
    expect(worker.commands.at(-1)).toMatchObject({
      type: "resource",
      update: { type: "sample", id: lateId },
    });
    const beforeReselect = worker.commands.length;
    engine.setSong(edited);
    expect(worker.commands.slice(beforeReselect)).toMatchObject([
      { type: "resource", update: { type: "sample", id: sampleId, resource: { right: left } } },
      { type: "resource", update: { type: "soundfont", id: fontId } },
      { type: "song", song: edited },
      { type: "resource", update: { type: "remove", id: fontAliasId } },
      { type: "resource", update: { type: "remove", id: lateId } },
    ]);

    const play = required(worker.commands.find((command) => command.type === "play"));
    const block = (generation: number, bar: number, beat: number, playing = true): AudioReply => ({
      type: "block",
      generation,
      block: {
        id: 100,
        start: bar + beat / song.beatsPerBar,
        end: bar + (beat + 0.25) / song.beatsPerBar,
        duration: 0.05,
        loopStart: 0,
        loopEnd: song.barCount,
      },
      state: { bar, beat, playing },
      time: 10,
    });
    worker.reply(block(play.generation, 1, 0.25));
    expect(engine.beat).toBe(0.25);
    engine.seek(3, 0.5);
    const seek = required(worker.commands.findLast((command) => command.type === "seek"));
    worker.reply(block(play.generation, 7, 1));
    expect(engine.bar).toBe(3);
    expect(engine.beat).toBe(0.5);
    worker.reply(block(seek.generation, 3, 0.5));
    worker.reply({ type: "consumed", generation: play.generation, id: 100, time: 10.1 });
    context.currentTime = 10.025;
    expect(engine.playhead).toBeCloseTo(3 + 0.625 / song.beatsPerBar);
    engine.pause();
    expect(engine.playing).toBe(false);
    expect(engine.bar).toBe(3);
    expect(engine.beat).toBe(0);
    worker.reply(block(seek.generation, 8, 1));
    expect(engine.playing).toBe(false);
    expect(engine.bar).toBe(3);
    expect(engine.beat).toBe(0);
    await engine.close();
    expect(worker.terminated).toBe(true);
    expect(context.state).toBe("closed");
    expect(node.connected).toBe(false);
    const afterClose = worker.commands.length;
    registerAudioResource(liveId, left, right, 8000);
    expect(worker.commands).toHaveLength(afterClose);
    autoReady = false;
    const initializing = new Promise<void>((resolve) => {
      initSeen = resolve;
    });
    const pendingPlay = engine.play(2);
    await initializing;
    engine.pause();
    const restarted = required(workers[1]);
    expect(
      restarted.commands
        .filter((command) => command.type === "resource")
        .map((command) => command.update.id),
    ).toEqual([sampleId, fontId]);
    const channel = required(song.channels[0]);
    const cancelledNote = engine.audition(channel, 48);
    engine.release(48);
    const cancelledChord = engine.audition(channel, 52);
    engine.releaseAll();
    const replacedNote = engine.audition(channel, 55);
    engine.release(55);
    const heldNote = engine.audition(channel, 55);
    restarted.initialize();
    await Promise.all([pendingPlay, cancelledNote, cancelledChord, replacedNote, heldNote]);
    expect(restarted.commands.filter((command) => command.type === "audition")).toEqual([
      { type: "audition", channelId: channel.id, pitch: 55 },
    ]);
    expect(engine.playing).toBe(false);
    expect(engine.bar).toBe(2);
    expect(restarted.commands.some((command) => command.type === "play")).toBe(false);
    const failures: string[] = [];
    engine.onError = (error): void => {
      failures.push(error.message);
    };
    await engine.play(engine.bar);
    restarted.reply({ type: "error", message: "Synthesis failed after initialization" });
    await Promise.resolve();
    expect(failures).toEqual(["Synthesis failed after initialization"]);
    expect(restarted.terminated).toBe(true);
    expect(required(contexts[1]).state).toBe("closed");
    await engine.close();
    expect(engine.playing).toBe(false);
  } finally {
    await engine.close();
    for (const id of [sampleId, fontId, liveId, aliasId, fontAliasId, cacheId, previewId, lateId]) {
      removeAudioResource(id);
    }
    for (const [key, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
