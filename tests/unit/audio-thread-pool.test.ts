import { expect, test } from "bun:test";

import { applyAudioResourceUpdate, SongRenderer } from "../../src/audio";
import type { AudioResourceUpdate } from "../../src/audio";
import { AudioThreadPool } from "../../src/audio-thread-pool";
import type {
  AudioTrackCommand,
  AudioTrackReply,
  TrackPoolConfig,
} from "../../src/audio-thread-pool";
import { AudioTrackSession, packTrackPlan, TrackPlanDecoder } from "../../src/audio-track-session";
import { createEffect, createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";

const fixture = (tracks: number, threadCount: number): TrackPoolConfig => {
  const song = createSong();
  song.channels = Array.from({ length: tracks }, (_unused, index) => {
    const channel = createChannel("track", song.barCount, song.patternCount);
    channel.instruments = [createInstrument("Custom chip wave")];
    channel.cells.fill(1);
    required(channel.patterns[1]).notes = [createNote(0, 4, 48 + index)];
    return channel;
  });
  return {
    song,
    sampleRate: 8000,
    bar: 0,
    beat: 0,
    playing: true,
    recording: false,
    muted: [],
    threadCount,
  };
};

type WorkerProbe = {
  workers: Array<{ commands: AudioTrackCommand[]; terminated: boolean }>;
  metrics: { inFlight: number; peakInFlight: number; completed: number[] };
  pending: Array<() => void>;
  restore: () => void;
};
const probeWorkers = (defer = false): WorkerProbe => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const workers: FakeWorker[] = [];
  const metrics = { inFlight: 0, peakInFlight: 0, completed: new Array<number>() };
  const pending: Array<() => void> = [];
  class FakeWorker extends EventTarget {
    public readonly commands: AudioTrackCommand[] = [];
    public session: AudioTrackSession | null = null;
    public terminated = false;
    public readonly index: number;
    private readonly plans = new TrackPlanDecoder();
    public constructor() {
      super();
      this.index = workers.length;
      workers.push(this);
    }
    public postMessage(input: AudioTrackCommand): void {
      const command = structuredClone(input);
      this.commands.push(command);
      if (command.type === "init") {
        this.session = new AudioTrackSession(command.config, command.trackIds, command.resources);
      } else if (command.type === "update") {
        this.session?.update(command.command, command.trackIds, command.position);
      } else {
        metrics.inFlight++;
        metrics.peakInFlight = Math.max(metrics.peakInFlight, metrics.inFlight);
        const complete = (): void => {
          metrics.inFlight--;
          metrics.completed.push(this.index);
          const stems = required(this.session ?? undefined).render(
            command.frames,
            command.plan && this.plans.decode(command.plan),
          );
          const reply: AudioTrackReply = {
            type: "rendered",
            id: command.id,
            stems,
          };
          this.dispatchEvent(new MessageEvent("message", { data: reply }));
        };
        if (defer) {
          pending.push(complete);
        } else {
          queueMicrotask(complete);
        }
      }
    }
    public terminate(): void {
      this.terminated = true;
      this.session?.close();
    }
  }
  Object.assign(globalThis, { Worker: FakeWorker });
  return {
    workers,
    metrics,
    pending,
    restore: (): void => {
      if (previous) {
        Object.defineProperty(globalThis, "Worker", previous);
      } else {
        Reflect.deleteProperty(globalThis, "Worker");
      }
    },
  };
};

const fontResource = (id: string, value = 0): AudioResourceUpdate => ({
  type: "soundfont",
  id,
  font: { samples: new Float32Array([value]), headers: [], presets: [] },
});
const sampleResource = (id: string, value = 0): AudioResourceUpdate => ({
  type: "sample",
  id,
  resource: { left: new Float32Array([value]), right: new Float32Array([value]), sampleRate: 8000 },
});
const deliveredResources = (commands: readonly AudioTrackCommand[]): AudioResourceUpdate[] =>
  commands.flatMap((command) => {
    if (command.type === "init") {
      return command.resources;
    }
    return command.type === "update" && command.command.type === "resource"
      ? [command.command.update]
      : [];
  });

test("adding a blank track leaves loaded SoundFonts out of worker startup and preserves playback", async () => {
  const probe = probeWorkers();
  const config = fixture(1, 3);
  const resources = Array.from({ length: 24 }, (_, index) => fontResource(`unused-font-${index}`));
  const pool = new AudioThreadPool(config, resources);
  const reference = new SongRenderer(config.song, config.sampleRate, 0, undefined, {
    channelIds: new Set([required(config.song.channels[0]).id]),
    master: false,
  });
  try {
    expect(deliveredResources(required(probe.workers[0]).commands)).toEqual([]);
    await pool.render(1337);
    reference.process(new Float32Array(1337), new Float32Array(1337));
    const song = structuredClone(config.song);
    song.channels.push(createChannel("track", song.barCount, song.patternCount));
    pool.update({ type: "song", song }, { bar: reference.bar, beat: reference.beat });
    expect(probe.workers).toHaveLength(2);
    expect(probe.workers.flatMap((worker) => deliveredResources(worker.commands))).toEqual([]);
    reference.song = song;
    const left = new Float32Array(512);
    const right = new Float32Array(512);
    reference.process(left, right);
    const [existing] = await pool.render(512);
    expect(existing?.left).toEqual(left);
    expect(existing?.right).toEqual(right);
    expect(left.some((sample) => sample !== 0)).toBe(true);
  } finally {
    pool.close();
    reference.reset();
    for (const { id } of resources) {
      applyAudioResourceUpdate({ type: "remove", id });
    }
    probe.restore();
  }
});

test("new workers receive only their tracks' SoundFonts and samples once", () => {
  const probe = probeWorkers();
  const config = fixture(1, 3);
  const firstFont = fontResource("assigned-first-font");
  const secondFont = fontResource("assigned-second-font");
  const sample = sampleResource("assigned-sample");
  const unused = fontResource("assigned-unused-font");
  const resources = [firstFont, secondFont, sample, unused];
  const first = createInstrument("SoundFont");
  first.resourceId = firstFont.id;
  required(config.song.channels[0]).instruments = [first];
  const pool = new AudioThreadPool(config, resources);
  try {
    expect(deliveredResources(required(probe.workers[0]).commands)).toEqual([firstFont]);
    const song = structuredClone(config.song);
    const added = createChannel("track", song.barCount, song.patternCount);
    const font = createInstrument("SoundFont");
    font.resourceId = secondFont.id;
    const chip = createInstrument("chip wave");
    chip.resourceId = sample.id;
    const custom = createInstrument("Custom chip wave");
    custom.resourceId = unused.id;
    added.instruments = [font, { ...font, id: "shared-font-instrument" }, chip, custom];
    song.channels.push(added);
    const existing = required(probe.workers[0]);
    const before = existing.commands.length;
    pool.update({ type: "song", song });
    expect(probe.workers).toHaveLength(2);
    expect(deliveredResources(required(probe.workers[1]).commands)).toEqual([secondFont, sample]);
    expect(deliveredResources(existing.commands.slice(before))).toEqual([]);
    const checkpoint = required(probe.workers[1]).commands.length;
    pool.update({ type: "song", song: structuredClone(song) });
    expect(deliveredResources(required(probe.workers[1]).commands.slice(checkpoint))).toEqual([]);
  } finally {
    pool.close();
    for (const { id } of resources) {
      applyAudioResourceUpdate({ type: "remove", id });
    }
    probe.restore();
  }
});

test("worker resource delivery follows instrument edits, replacements and removals", () => {
  const probe = probeWorkers();
  const config = fixture(2, 2);
  const font = fontResource("edited-font");
  const sample = sampleResource("edited-sample");
  for (const channel of config.song.channels) {
    const instrument = createInstrument("SoundFont");
    instrument.resourceId = font.id;
    channel.instruments = [instrument];
  }
  const pool = new AudioThreadPool(config, [font]);
  const worker = required(probe.workers[0]);
  const edit = (resource: AudioResourceUpdate): void => {
    const song = structuredClone(config.song);
    for (const channel of song.channels) {
      const instrument = createInstrument(
        resource.type === "soundfont" ? "SoundFont" : "chip wave",
      );
      instrument.resourceId = resource.id;
      channel.instruments = [instrument];
    }
    pool.update({ type: "song", song });
  };
  const update = (resource: AudioResourceUpdate): void => {
    pool.update({ type: "resource", update: resource });
  };
  const verifyEdit = (resource: AudioResourceUpdate, previous: AudioResourceUpdate): void => {
    const before = worker.commands.length;
    edit(resource);
    const commands = worker.commands.slice(before);
    expect(deliveredResources(commands)).toEqual([resource, { type: "remove", id: previous.id }]);
    expect(commands.map((command) => command.type === "update" && command.command.type)).toEqual([
      "resource",
      "song",
      "resource",
    ]);
  };
  try {
    expect(deliveredResources(worker.commands)).toEqual([font]);
    let before = worker.commands.length;
    update(sample);
    expect(worker.commands).toHaveLength(before);
    verifyEdit(sample, font);

    const replacementFont = fontResource(font.id, 0.25);
    before = worker.commands.length;
    update(replacementFont);
    expect(worker.commands).toHaveLength(before);
    verifyEdit(replacementFont, sample);

    const replacementSample = sampleResource(sample.id, -0.25);
    before = worker.commands.length;
    update(replacementSample);
    expect(worker.commands).toHaveLength(before);
    verifyEdit(replacementSample, font);

    const liveSample = sampleResource(sample.id, 0.5);
    before = worker.commands.length;
    update(liveSample);
    expect(deliveredResources(worker.commands.slice(before))).toEqual([liveSample]);

    before = worker.commands.length;
    update({ type: "remove", id: font.id });
    expect(worker.commands).toHaveLength(before);
    before = worker.commands.length;
    update(replacementFont);
    expect(worker.commands).toHaveLength(before);
    verifyEdit(replacementFont, sample);

    before = worker.commands.length;
    update({ type: "remove", id: font.id });
    update(replacementFont);
    expect(deliveredResources(worker.commands.slice(before))).toEqual([
      { type: "remove", id: font.id },
      replacementFont,
    ]);
  } finally {
    pool.close();
    for (const { id } of [font, sample]) {
      applyAudioResourceUpdate({ type: "remove", id });
    }
    probe.restore();
  }
});

test("bounded audio workers retain track ownership and return stems in song order", async () => {
  const probe = probeWorkers();
  const { workers, metrics } = probe;
  const config = fixture(7, 4);
  const pool = new AudioThreadPool(config);
  const references = config.song.channels.map(
    (channel) =>
      new SongRenderer(config.song, config.sampleRate, 0, undefined, {
        channelIds: new Set([channel.id]),
        master: false,
      }),
  );
  try {
    const assignments = (): string[][] =>
      workers.map(
        (worker) =>
          required(worker.commands.findLast((command) => command.type !== "render")).trackIds,
      );
    expect(workers).toHaveLength(3);
    expect(assignments().map((ids) => ids.length)).toEqual([3, 2, 2]);
    expect(workers.every((worker) => worker.commands[0]?.type === "init")).toBe(true);
    const verify = async (): Promise<void> => {
      const stems = await pool.render(512);
      expect(stems.map((stem) => stem.channelId)).toEqual(config.song.channels.map((c) => c.id));
      for (const [index, renderer] of references.entries()) {
        const left = new Float32Array(512);
        const right = new Float32Array(512);
        renderer.process(left, right);
        expect(required(stems[index]).left).toEqual(left);
        expect(required(stems[index]).right).toEqual(right);
      }
    };
    await verify();
    expect(metrics.peakInFlight).toBe(3);
    const ownership = assignments();
    const song = structuredClone(config.song);
    song.channels.reverse();
    // Reordering changes deterministic mix order, never which worker owns a voice.
    pool.update(
      { type: "song", song },
      { bar: references[0]?.bar ?? 0, beat: references[0]?.beat ?? 0 },
    );
    expect(assignments()).toEqual(ownership);
    expect((await pool.render(512)).map((stem) => stem.channelId)).toEqual(
      song.channels.map((channel) => channel.id),
    );
    expect(workers).toHaveLength(3);
    pool.close();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
    const closed = await pool.render(512).catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(Error);
    expect(closed).toMatchObject({ message: "Audio thread pool is closed." });
  } finally {
    pool.close();
    probe.restore();
  }
});

test("shared tempo plans cross worker messages and ignore task completion order", async () => {
  const probe = probeWorkers(true);
  const config = fixture(5, 4);
  required(config.song.channels[1]).instruments = [createInstrument("chip wave")];
  const tracks = [...config.song.channels];
  const tempo = createChannel("automation", config.song.barCount, config.song.patternCount);
  tempo.target = { kind: "song" };
  tempo.cells.fill(1);
  required(tempo.patterns[1]).lanes = [
    {
      id: "parallel-tempo",
      target: "tempo",
      enabled: true,
      interpolation: "linear",
      points: [
        { time: 0, value: 90 },
        { time: 0.03, value: 300 },
      ],
    },
  ];
  config.song.channels.push(tempo);
  const pool = new AudioThreadPool(config);
  const master = new SongRenderer(config.song, config.sampleRate, 0, undefined, {
    channelIds: new Set(),
  });
  const references = tracks.map(
    (track) =>
      new SongRenderer(config.song, config.sampleRate, 0, undefined, {
        channelIds: new Set([track.id]),
        master: false,
      }),
  );
  try {
    for (let block = 0; block < 2; block++) {
      const plan = master.preparePlan(512);
      const pending = pool.render(512, plan);
      expect(probe.pending).toHaveLength(3);
      expect(probe.metrics.inFlight).toBe(3);
      for (const complete of probe.pending.splice(0).reverse()) {
        complete();
      }
      expect(probe.metrics.completed.slice(-3)).toEqual([2, 1, 0]);
      const stems = await pending;
      expect(stems.map((stem) => stem.channelId)).toEqual(tracks.map((track) => track.id));
      for (const [index, reference] of references.entries()) {
        const left = new Float32Array(512);
        const right = new Float32Array(512);
        reference.process(left, right, plan);
        expect(required(stems[index]).left).toEqual(left);
        expect(required(stems[index]).right).toEqual(right);
      }
      for (const worker of probe.workers) {
        const command = worker.commands.at(-1);
        expect(command?.type).toBe("render");
        if (command?.type === "render") {
          expect(new TrackPlanDecoder().decode(required(command.plan))).toEqual(plan);
        }
      }
      if (block === 0) {
        expect(required(plan.frames.at(-1)).globals.tempo).toBeGreaterThan(
          required(plan.frames[0]).globals.tempo,
        );
      }
      master.processMix(new Float32Array(512), new Float32Array(512), plan);
    }
  } finally {
    pool.close();
    master.reset();
    for (const renderer of references) {
      renderer.reset();
    }
    probe.restore();
  }
});

test("worker plans keep constant controls compact and preserve changes at individual frames", () => {
  const { song } = fixture(1, 1);
  const renderer = new SongRenderer(song);
  const steady = renderer.preparePlan(1024);
  const decoder = new TrackPlanDecoder();
  const payload = packTrackPlan(steady);
  expect(payload.clock.byteLength).toBe(1024 * 3 * Float64Array.BYTES_PER_ELEMENT);
  expect(payload.transport).not.toBeInstanceOf(Float64Array);
  expect(payload.globals).toEqual(required(steady.frames[0]).globals);
  expect(decoder.decode(structuredClone(payload))).toEqual(steady);

  const ramp = {
    ...steady,
    playing: false,
    frames: steady.frames.slice(0, 3).map((frame, index) => ({
      ...frame,
      bar: index,
      barVisit: index + 1,
      sequenceIndex: index - 1,
      playing: index < 2,
      globals: {
        tempo: 120 + index / 7,
        volume: 85 + index / 7,
        detune: index === 1 ? -0 : 0,
      },
    })),
  };
  const rampPayload = packTrackPlan(ramp);
  const decoded = decoder.decode(structuredClone(rampPayload));
  expect(decoded).toEqual(ramp);
  expect(Object.is(required(decoded.frames[1]).globals.detune, -0)).toBe(true);
  expect(decoder.decode(structuredClone(payload))).toEqual(steady);
  const empty = { ...steady, frames: [] };
  expect(decoder.decode(packTrackPlan(empty))).toEqual(empty);
});

test("a single audio thread renders every track locally with no child workers", async () => {
  const config = fixture(3, 1);
  const pool = new AudioThreadPool(config);
  try {
    expect(await pool.render(512)).toHaveLength(3);
    const reordered = { ...config.song, channels: config.song.channels.toReversed() };
    pool.update({ type: "song", song: reordered });
    expect((await pool.render(512)).map((stem) => stem.channelId)).toEqual(
      reordered.channels.map((channel) => channel.id),
    );
    pool.update({ type: "pause", bar: 0, generation: 1 });
    for (const stem of await pool.render(512)) {
      expect(stem.left.every((sample) => sample === 0)).toBe(true);
      expect(stem.right.every((sample) => sample === 0)).toBe(true);
    }
  } finally {
    pool.close();
  }
});

test("removing a worker's tracks settles its pending render", async () => {
  const probe = probeWorkers(true);
  const config = fixture(1, 2);
  const pool = new AudioThreadPool(config);
  try {
    const pending = pool.render(512);
    pool.update({ type: "song", song: { ...config.song, channels: [] } });
    expect(await Promise.allSettled([pending])).toEqual([
      { status: "rejected", reason: new Error("Audio track worker no longer has tracks.") },
    ]);
    expect(probe.workers.every((worker) => worker.terminated)).toBe(true);
    expect(await pool.render(512)).toEqual([]);
  } finally {
    pool.close();
    probe.restore();
  }
});

test("new tracks inherit the current transport while existing track phases survive", () => {
  const config = fixture(1, 1);
  const first = required(config.song.channels[0]);
  const session = new AudioTrackSession(config, [first.id]);
  const reference = new SongRenderer(config.song, config.sampleRate, 0, undefined, {
    channelIds: new Set([first.id]),
    master: false,
  });
  const warmup = new Float32Array(1337);
  reference.process(warmup, new Float32Array(1337));
  session.render(1337);
  const changed = structuredClone(config.song);
  const second = createChannel("track", changed.barCount, changed.patternCount);
  second.instruments = [createInstrument("Custom chip wave")];
  second.cells.fill(1);
  required(second.patterns[1]).notes = [createNote(1, 2, 60)];
  changed.channels.push(second);
  session.update({ type: "song", song: changed }, [first.id, second.id], {
    bar: reference.bar,
    beat: reference.beat,
  });
  reference.song = changed;
  const left = new Float32Array(512);
  const right = new Float32Array(512);
  reference.process(left, right);
  const stems = session.render(512);
  expect(required(stems[0]).left).toEqual(left);
  expect(required(stems[0]).right).toEqual(right);
  // Added after beat zero, this track must not start its later note prematurely.
  expect(required(stems[1]).left.every((sample) => sample === 0)).toBe(true);
  session.close();
});

test("an added track inherits next-bar tick progress and the shared transport clock", () => {
  const config = fixture(1, 1);
  const first = required(config.song.channels[0]);
  const automation = createChannel("automation", config.song.barCount, config.song.patternCount);
  automation.target = { kind: "song" };
  automation.cells.fill(1);
  required(automation.patterns[1]).lanes = [
    {
      id: "jump-after-tick",
      target: "nextBar",
      enabled: true,
      interpolation: "hold",
      points: [{ time: 0.02, value: 1 }],
    },
  ];
  config.song.channels.push(automation);
  const added = createChannel("track", config.song.barCount, config.song.patternCount);
  added.instruments = [createInstrument("Custom chip wave")];
  added.cells.fill(1);
  added.cells[2] = 2;
  required(added.patterns[2]).notes = [createNote(0, 4, 72)];
  const changed = structuredClone(config.song);
  changed.channels.splice(1, 0, added);
  const expected = new SongRenderer(changed, config.sampleRate, 0, undefined, {
    channelIds: new Set([added.id]),
    master: false,
  });
  const master = new SongRenderer(config.song, config.sampleRate, 0, undefined, {
    channelIds: new Set(),
  });
  const session = new AudioTrackSession(config, [first.id]);
  try {
    session.render(200);
    master.process(new Float32Array(200), new Float32Array(200));
    expected.process(new Float32Array(200), new Float32Array(200));
    expect(master.bar).toBe(1);
    expect(master.transportClock.visitTicks).toBeGreaterThan(0);
    session.update({ type: "song", song: changed }, [first.id, added.id], {
      bar: master.bar,
      beat: master.beat,
      clock: master.transportClock,
    });
    const stems = session.render(256);
    const left = new Float32Array(256);
    const right = new Float32Array(256);
    expected.process(left, right);
    expect(left.some((sample) => Math.abs(sample) > 1e-6)).toBe(true);
    expect(required(stems.find((stem) => stem.channelId === added.id)).left).toEqual(left);
    expect(required(stems.find((stem) => stem.channelId === added.id)).right).toEqual(right);
  } finally {
    session.close();
    master.reset();
    expected.reset();
  }
});

test("blank tracks follow shared plans without rendering until notes are added", () => {
  const config = fixture(2, 1);
  const second = required(config.song.channels[1]);
  required(second.patterns[1]).notes = [];
  const master = new SongRenderer(config.song, config.sampleRate, 0, undefined, {
    channelIds: new Set(),
  });
  const session = new AudioTrackSession(
    config,
    config.song.channels.map((channel) => channel.id),
  );
  try {
    const plan = master.preparePlan(1337);
    const initial = session.render(1337, plan);
    expect(initial.map((stem) => stem.channelId)).toEqual([required(config.song.channels[0]).id]);
    master.processMix(new Float32Array(1337), new Float32Array(1337), plan);
    const changed = structuredClone(config.song);
    const modified = required(changed.channels[1]);
    required(modified.patterns[1]).notes = [createNote(0, 4, 60)];
    session.update(
      { type: "song", song: changed },
      changed.channels.map((channel) => channel.id),
      { bar: master.bar, beat: master.beat, clock: master.transportClock },
    );
    master.song = changed;
    const next = master.preparePlan(512);
    const stems = session.render(512, next);
    const stem = required(stems.find((item) => item.channelId === second.id));
    const reference = new SongRenderer(changed, config.sampleRate, 0, undefined, {
      channelIds: new Set([second.id]),
      master: false,
    });
    const left = new Float32Array(512);
    const right = new Float32Array(512);
    reference.process(left, right, next);
    expect(stem.left).toEqual(left);
    expect(stem.right).toEqual(right);
    expect(left.some((sample) => Math.abs(sample) > 1e-6)).toBe(true);
    reference.reset();
  } finally {
    session.close();
    master.reset();
  }
});

for (const type of ["FM (n-op)", "chip wave"]) {
  test(`${type} stems sleep after releases and wake at the next scheduled note`, () => {
    const config = fixture(1, 1);
    config.song.tempo = 150;
    config.song.beatsPerBar = 1;
    config.song.loopEnd = 3;
    config.sequence = [0, 1, 2];
    const track = required(config.song.channels[0]);
    const instrument = createInstrument(type);
    instrument.release = 0.08;
    track.instruments = [instrument];
    track.cells.fill(0);
    track.cells[0] = 1;
    track.cells[2] = 1;
    required(track.patterns[1]).notes = [createNote(0, 0.125, 52)];
    const master = new SongRenderer(config.song, config.sampleRate, 0, config.sequence, {
      channelIds: new Set(),
    });
    const reference = new SongRenderer(config.song, config.sampleRate, 0, config.sequence, {
      channelIds: new Set([track.id]),
      master: false,
    });
    const session = new AudioTrackSession(config, [track.id]);
    let releaseAudible = false;
    let asleep = false;
    let woke = false;
    try {
      while (master.playing) {
        const plan = master.preparePlan(128, true);
        const { length } = plan.frames;
        const first = required(plan.frames[0]);
        const left = new Float32Array(length);
        const right = new Float32Array(length);
        reference.process(left, right, plan);
        const [stem] = session.render(length, plan);
        expect(stem?.left ?? new Float32Array(length)).toEqual(left);
        expect(stem?.right ?? new Float32Array(length)).toEqual(right);
        const audible = left.some((value) => value !== 0);
        releaseAudible ||= first.bar === 0 && first.beat >= 0.125 && audible;
        asleep ||= first.bar === 1 && stem === undefined;
        woke ||= first.bar === 2 && stem !== undefined && audible;
      }
      expect(releaseAudible && asleep && woke).toBe(true);
    } finally {
      session.close();
      reference.reset();
      master.reset();
    }
  });
}

test("a delayed effect can ring after a whole silent stem block", () => {
  const config = fixture(1, 1);
  const track = required(config.song.channels[0]);
  const instrument = createInstrument("FM (n-op)");
  instrument.release = 0;
  track.instruments = [instrument];
  track.cells.fill(0);
  track.cells[0] = 1;
  required(track.patterns[1]).notes = [createNote(0, 0.015625, 52)];
  const echo = createEffect("Echo");
  echo.parameters["time"] = 0.25;
  track.effects.push(echo);
  const master = new SongRenderer(config.song, config.sampleRate, 0, undefined, {
    channelIds: new Set(),
  });
  const session = new AudioTrackSession(config, [track.id]);
  try {
    const first = required(session.render(512, master.preparePlan(512))[0]);
    expect(first.left.some((sample) => sample !== 0)).toBe(true);
    const silent = required(session.render(512, master.preparePlan(512))[0]);
    expect(silent.left.every((sample) => sample === 0)).toBe(true);
    const delayed = required(session.render(1536, master.preparePlan(1536))[0]);
    expect(delayed.left.some((sample) => sample !== 0)).toBe(true);
  } finally {
    session.close();
    master.reset();
  }
});
