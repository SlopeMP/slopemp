import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import { evaluateLane, prepareLane } from "../../src/automation";
import { createInstrument } from "../../src/instruments";
import type { AutomationLane } from "../../src/model";
import { createChannel, createNote, createSong, required } from "../../src/model";

const fixture = (): AutomationLane => ({
  id: "volume",
  target: "volume",
  enabled: true,
  interpolation: "linear",
  points: [
    { time: 2, value: 0 },
    { time: 0, value: 80 },
    { time: 1, value: 20 },
    { time: 1, value: 40 },
    { time: 2, value: 10 },
  ],
});

test("interpolation respects unsorted points, duplicate boundaries, and live mutations", () => {
  const lane = fixture();
  const order = structuredClone(lane.points);
  expect(evaluateLane(lane, -0.1)).toBeUndefined();
  expect(evaluateLane(lane, 0.5)).toBe(50);
  expect(evaluateLane(lane, 1)).toBe(40);
  expect(evaluateLane(lane, 1.5)).toBe(20);
  expect(evaluateLane(lane, 2)).toBe(10);
  expect(evaluateLane(lane, 2.1)).toBeUndefined();
  lane.interpolation = "hold";
  expect(evaluateLane(lane, 0.5)).toBe(80);
  expect(evaluateLane(lane, 1.5)).toBe(40);
  expect(lane.points).toEqual(order);
  required(lane.points[3]).value = 60;
  expect(evaluateLane(lane, 1.5)).toBe(60);
  required(lane.points[3]).time = 0.25;
  expect(evaluateLane(lane, 0.5)).toBe(60);
  lane.enabled = false;
  expect(evaluateLane(lane, 0.5)).toBeUndefined();
});

test("prepared automation matches the scanner across duplicate boundaries and seeks", () => {
  const lane = fixture();
  const prepared = prepareLane(lane);
  for (const interpolation of ["linear", "hold"] as const) {
    lane.interpolation = interpolation;
    for (const at of [-1, 0, 0.5, 1, 2, 2.001, 1.1, 0.25, Number.NaN, 1, Infinity]) {
      expect(prepared(at)).toBe(evaluateLane(lane, at));
    }
  }
});

test("planning a new block picks up in-place automation edits and mutes", () => {
  const song = createSong();
  const channel = createChannel("automation");
  channel.cells.fill(1);
  const lane = fixture();
  required(channel.patterns[1]).lanes = [lane];
  song.channels.push(channel);
  const renderer = new SongRenderer(song);
  expect(required(renderer.preparePlan(1).frames[0]).globals.volume).toBe(80);
  required(lane.points[1]).value = 10;
  const frame = required(renderer.preparePlan(1).frames[0]);
  expect(frame.globals.volume).toBe(required(evaluateLane(lane, frame.beat)));
  renderer.muted = new Set([channel.id]);
  expect(required(renderer.preparePlan(1).frames[0]).globals.volume).toBe(song.volume);
});

test("unsorted volume automation renders the same stereo samples as its explicit base value", () => {
  const song = createSong();
  song.channels = song.channels.slice(0, 1);
  const track = required(song.channels[0]);
  track.instruments = [createInstrument("FM (n-op)")];
  track.cells[0] = 1;
  required(track.patterns[1]).notes = [createNote(0, 4, 48)];
  song.volume = 80;
  const control = new SongRenderer(song);
  const automated = structuredClone(song);
  automated.volume = 20;
  const channel = createChannel("automation");
  channel.cells[0] = 1;
  const lane = fixture();
  lane.points = [
    { time: 4, value: 80 },
    { time: 0, value: 80 },
  ];
  required(channel.patterns[1]).lanes = [lane];
  automated.channels.push(channel);
  const renderer = new SongRenderer(automated);
  const render = (source: SongRenderer): Float32Array[] => {
    const left = new Float32Array(4096);
    const right = new Float32Array(4096);
    source.process(left, right);
    expect(left.some((sample) => Math.abs(sample) > 1e-5)).toBe(true);
    expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true);
    return [left, right];
  };
  expect(render(renderer)).toEqual(render(control));
});
