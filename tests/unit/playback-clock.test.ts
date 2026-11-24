import { describe, expect, test } from "bun:test";

import { PlaybackClock } from "../../src/playback-clock";

const block = (
  id: number,
  start: number,
  end: number,
): Parameters<PlaybackClock["enqueue"]>[0] => ({
  id,
  start,
  end,
  duration: 0.1,
  loopStart: 1,
  loopEnd: 4,
});
describe("audible playback clock", () => {
  test("interpolates queued audio and stops advancing during an underrun", () => {
    const clock = new PlaybackClock();
    clock.enqueue(block(0, 0, 0.1), 10);
    clock.enqueue(block(1, 0.1, 0.2), 10);
    expect(clock.position(10.05)).toBeCloseTo(0.05);
    expect(clock.position(10.15)).toBeCloseTo(0.15);
    expect(clock.position(11)).toBe(0.2);
  });
  test("consumption timestamps correct scheduling jitter without restarting the next block", () => {
    const clock = new PlaybackClock();
    clock.enqueue(block(0, 0, 0.1), 0);
    clock.enqueue(block(1, 0.1, 0.2), 0);
    clock.consumed(0, 0.12);
    expect(clock.position(0.17)).toBeCloseTo(0.15);
    clock.consumed(1, 0.22);
    expect(clock.position(1)).toBe(0.2);
  });
  test("loop boundaries wrap in musical time and reset ignores stale acknowledgments", () => {
    const clock = new PlaybackClock();
    clock.enqueue(block(0, 3.9, 1.1), 0);
    expect(clock.position(0.025)).toBeCloseTo(3.95);
    expect(clock.position(0.075)).toBeCloseTo(1.05);
    clock.reset(2);
    clock.consumed(0, 1);
    expect(clock.position(2)).toBe(2);
  });
});
