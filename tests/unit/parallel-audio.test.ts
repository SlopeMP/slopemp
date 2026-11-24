import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import { createEffect, createEnvelope, createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";
import type { AutomationLane, Song } from "../../src/model";

const sampleRate = 8000;
const lane = (target: string, from: number, to = from, effectId?: string): AutomationLane => ({
  id: `${target}-${effectId ?? "global"}`,
  target,
  enabled: true,
  interpolation: "linear",
  points: [
    { time: 0, value: from },
    { time: 2, value: to },
  ],
  ...(effectId === undefined ? undefined : { effectId }),
});
const fixture = (): Song => {
  const song = createSong();
  song.beatsPerBar = 2;
  song.barCount = 3;
  song.loopEnd = 3;
  song.tempo = 240;
  song.volume = 73;
  song.channels = ["Custom chip wave", "FM (n-op)", "chip wave"].map((type, index) => {
    const channel = createChannel("track", song.barCount, song.patternCount);
    channel.cells = [1, 2, 1];
    const instrument = createInstrument(type);
    instrument.volume = 0.4 + index * 0.1;
    instrument.attack = 0.03;
    instrument.release = 0.15;
    const echo = createEffect("Echo");
    echo.parameters["time"] = 0.025;
    channel.effects = [echo];
    channel.instruments = [instrument];
    required(channel.patterns[1]).notes = [createNote(0, 2, [48 + index * 3, 55 + index * 3])];
    const tied = createNote(0, 2, [48 + index * 3, 55 + index * 3]);
    tied.continues = true;
    required(channel.patterns[2]).notes = [tied];
    return channel;
  });
  const target = required(song.channels[0]);
  const panning = createEffect("Pan");
  const channelAutomation = createChannel("automation", song.barCount, song.patternCount);
  channelAutomation.target = { kind: "channel", channelId: target.id };
  channelAutomation.effects = [panning];
  channelAutomation.cells.fill(1);
  required(channelAutomation.patterns[1]).lanes = [lane("position", -80, 80, panning.id)];
  const instrumentAutomation = createChannel("automation", song.barCount, song.patternCount);
  instrumentAutomation.target = {
    kind: "instrument",
    instrumentId: required(target.instruments[0]).id,
  };
  const filter = createEffect("Low Pass");
  instrumentAutomation.effects = [filter];
  instrumentAutomation.cells.fill(1);
  required(instrumentAutomation.patterns[1]).lanes = [lane("frequency", 300, 4000, filter.id)];
  const global = createChannel("automation", song.barCount, song.patternCount);
  global.cells.fill(1);
  const gain = createEffect("Gain");
  global.effects = [gain];
  required(global.patterns[1]).lanes = [
    lane("tempo", 180, 300),
    lane("volume", 50, 90),
    lane("detune", -20, 20),
    lane("gain", 3, 6, gain.id),
  ];
  song.channels.push(channelAutomation, instrumentAutomation, global);
  return song;
};
const partitions = (song: Song): { stems: SongRenderer[]; master: SongRenderer } => ({
  stems: song.channels
    .filter((channel) => channel.kind === "track")
    .map(
      (channel) =>
        new SongRenderer(song, sampleRate, 0, undefined, {
          channelIds: new Set([channel.id]),
          master: false,
        }),
    ),
  master: new SongRenderer(song, sampleRate, 0, undefined, { channelIds: new Set() }),
});
const compareBlock = (
  reference: SongRenderer,
  stems: SongRenderer[],
  master: SongRenderer,
  frames: number,
): void => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const plan = master.preparePlan(frames);
  for (const stem of stems) {
    const stemLeft = new Float32Array(frames);
    const stemRight = new Float32Array(frames);
    stem.process(stemLeft, stemRight, plan);
    for (let index = 0; index < frames; index++) {
      left[index] = (left[index] ?? 0) + (stemLeft[index] ?? 0);
      right[index] = (right[index] ?? 0) + (stemRight[index] ?? 0);
    }
  }
  master.processMix(left, right, plan);
  const expectedLeft = new Float32Array(frames);
  const expectedRight = new Float32Array(frames);
  reference.process(expectedLeft, expectedRight);
  let difference = 0;
  for (let frame = 0; frame < frames; frame++) {
    difference = Math.max(
      difference,
      Math.abs((left[frame] ?? 0) - (expectedLeft[frame] ?? 0)),
      Math.abs((right[frame] ?? 0) - (expectedRight[frame] ?? 0)),
    );
  }
  expect(difference).toBeLessThan(1e-6);
  expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true);
  expect(left.some((value) => Math.abs(value) > 0.001)).toBe(true);
  for (const source of [...stems, master]) {
    expect(source.bar).toBe(reference.bar);
    expect(source.beat).toBe(reference.beat);
    expect(source.seconds).toBe(reference.seconds);
  }
};

test("parallel track stems preserve target automation, ties, song effects and one shared master", () => {
  const song = fixture();
  const reference = new SongRenderer(song, sampleRate);
  const { stems, master } = partitions(song);
  for (let block = 0; block < 12; block++) {
    if (block === 3 || block === 7) {
      const edited = structuredClone(reference.song);
      edited.volume = block === 3 ? 45 : 80;
      required(required(edited.channels[1]).instruments[0]).volume = block === 3 ? 0.3 : 0.7;
      const automation = required(edited.channels.at(-1));
      required(required(automation.patterns[1]).lanes[0]).points = [
        { time: 0, value: 220 },
        { time: 2, value: 280 },
      ];
      for (const source of [reference, master, ...stems]) {
        source.song = structuredClone(edited);
      }
    }
    if (block === 5 || block === 9) {
      const muted =
        block === 5
          ? new Set([required(song.channels[2]).id, required(song.channels[3]).id])
          : new Set<string>();
      for (const source of [reference, master, ...stems]) {
        source.muted = muted;
      }
    }
    compareBlock(reference, stems, master, 1024);
  }
});

test("parallel transport remains frame-aligned through next-bar automation, seeking and audition", () => {
  const song = fixture();
  const global = required(song.channels.at(-1));
  required(global.patterns[1]).lanes.push(lane("nextBar", 1));
  const nextBar = required(required(global.patterns[1]).lanes.at(-1));
  nextBar.points = [{ time: 0.75, value: 1 }];
  const reference = new SongRenderer(song, sampleRate);
  const { stems, master } = partitions(song);
  compareBlock(reference, stems, master, 4096);
  for (const source of [reference, master, ...stems]) {
    source.seek(1);
    source.beat = 0.25;
  }
  compareBlock(reference, stems, master, 1024);
  for (const source of [reference, master, ...stems]) {
    source.playing = false;
    source.releaseAll();
    source.reset();
  }
  const channel = required(song.channels[0]);
  reference.audition(channel, 60);
  required(stems[0]).audition(channel, 60);
  compareBlock(reference, stems, master, 512);
});

test("new track clocks inherit elapsed phase and next-bar timing without resetting existing voices", () => {
  const song = createSong();
  song.channels = song.channels.slice(0, 1);
  song.beatsPerBar = 2;
  song.tempo = 220;
  const channel = required(song.channels[0]);
  channel.cells.fill(1);
  const instrument = createInstrument("Custom chip wave");
  instrument.attack = 0;
  instrument.envelopes = [
    { ...createEnvelope(), type: "Sine", target: "volume", a: 0.25, b: 1, speed: 0.7 },
  ];
  channel.instruments = [instrument];
  channel.effects = [createEffect("Tremolo")];
  const global = createChannel("automation");
  global.cells.fill(1);
  required(global.patterns[1]).lanes = [lane("tempo", 200, 260)];
  song.channels.push(global);
  const existing = new SongRenderer(song, sampleRate, 0, undefined, { master: false });
  existing.process(new Float32Array(9137), new Float32Array(9137));
  const clock = existing.transportClock;
  expect(clock.seconds).toBeGreaterThan(1);
  expect(clock.elapsedBeat).toBeGreaterThan(2);
  expect(clock.visitTicks).toBeGreaterThan(30);
  const edited = structuredClone(song);
  required(required(edited.channels[0]).patterns[1]).notes = [createNote(0, 2, 48)];
  const automation = required(edited.channels[1]);
  const jump = lane("nextBar", 1);
  jump.points = [{ time: Math.max(0, clock.beat - 0.01), value: 1 }];
  required(automation.patterns[1]).lanes.push(jump);
  existing.song = edited;
  const added = new SongRenderer(edited, sampleRate, clock.bar, undefined, { master: false });
  added.synchronizeClock(clock);
  expect(added.transportClock).toEqual(clock);
  expect(added.sample()).toEqual(existing.sample());
  expect(added.bar).not.toBe(clock.bar);
  expect(added.transportClock).toEqual(existing.transportClock);
  for (let frame = 0; frame < 512; frame++) {
    expect(added.sample()).toEqual(existing.sample());
  }
  const control = new SongRenderer(edited, sampleRate, clock.bar, undefined, { master: false });
  control.synchronizeClock(clock);
  for (let frame = 0; frame < 513; frame++) {
    control.sample();
  }
  // synchronizeClock changes transport alone, preserving established phases,
  // envelope ages, active note IDs and effect buffers on an existing renderer.
  added.synchronizeClock(added.transportClock);
  expect(added.sample()).toEqual(control.sample());
});

test("a shared render plan supplies global automation without per-track reevaluation", () => {
  const song = fixture();
  const reference = new SongRenderer(song, sampleRate);
  const { stems, master } = partitions(song);
  const plan = master.preparePlan(512);
  // Deliberately make each stem's local global settings disagree with the plan.
  // With a shared plan, no track may re-read these globals or nextBar events.
  for (const stem of stems) {
    stem.song = structuredClone(song);
    stem.song.tempo = 30;
    const global = required(stem.song.channels.at(-1));
    const globals = required(global.patterns[1]);
    globals.lanes = [lane("tempo", 30), lane("detune", 250), lane("nextBar", 1)];
  }
  const left = new Float32Array(512);
  const right = new Float32Array(512);
  for (const stem of stems) {
    const stemLeft = new Float32Array(512);
    const stemRight = new Float32Array(512);
    stem.process(stemLeft, stemRight, plan);
    for (let frame = 0; frame < left.length; frame++) {
      left[frame] = (left[frame] ?? 0) + (stemLeft[frame] ?? 0);
      right[frame] = (right[frame] ?? 0) + (stemRight[frame] ?? 0);
    }
    expect(stem.bar).toBe(plan.end.bar);
    expect(stem.beat).toBe(plan.end.beat);
  }
  master.processMix(left, right, plan);
  const expectedLeft = new Float32Array(512);
  const expectedRight = new Float32Array(512);
  reference.process(expectedLeft, expectedRight);
  let difference = 0;
  for (let frame = 0; frame < left.length; frame++) {
    difference = Math.max(
      difference,
      Math.abs((left[frame] ?? 0) - (expectedLeft[frame] ?? 0)),
      Math.abs((right[frame] ?? 0) - (expectedRight[frame] ?? 0)),
    );
  }
  expect(difference).toBeLessThan(1e-6);
});

test("song automation is evaluated once for a shared plan regardless of track count", () => {
  const song = fixture();
  const global = required(song.channels.at(-1));
  const point = required(required(required(global.patterns[1]).lanes[0]).points[0]);
  const { value } = point;
  let reads = 0;
  Object.defineProperty(point, "value", {
    configurable: true,
    get: (): number => {
      reads++;
      return value;
    },
  });
  const { stems, master } = partitions(song);
  const plan = master.preparePlan(128);
  const preparedReads = reads;
  expect(preparedReads).toBeGreaterThanOrEqual(128);
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  for (const stem of stems) {
    stem.process(left, right, plan);
  }
  master.processMix(left, right, plan);
  expect(reads).toBe(preparedReads);
});
