import type { AutomationLane, AutomationPoint } from "./model";

type LaneReader = (at: number) => number | undefined;
const interpolateLane = (
  lane: AutomationLane,
  at: number,
  left: AutomationPoint | null | undefined,
  right: AutomationPoint | null | undefined,
): number | undefined => {
  if (!left || (!right && at > left.time)) {
    return undefined;
  }
  return !right || lane.interpolation === "hold"
    ? left.value
    : left.value +
        ((right.value - left.value) * (at - left.time)) / Math.max(1e-9, right.time - left.time);
};

// Scan neighboring points without sorting or copying on every audio sample.
// Equal-time points retain insertion order: the last point at the cursor wins.
export const evaluateLane = (lane: AutomationLane, at: number): number | undefined => {
  if (!lane.enabled) {
    return undefined;
  }
  let left: AutomationPoint | null = null;
  let right: AutomationPoint | null = null;
  for (const point of lane.points) {
    if (point.time <= at) {
      if (!left || point.time >= left.time) {
        left = point;
      }
    } else if (!right || point.time < right.time) {
      right = point;
    }
  }
  return interpolateLane(lane, at, left, right);
};

// Synchronous rendering can reuse a sorted view until the next editing boundary.
// The upper bound picks the last duplicate at or before the cursor, and the
// first duplicate after it, as the scanner does.
export const prepareLane = (lane: AutomationLane): LaneReader => {
  if (lane.points.length < 3 || lane.points.some((point) => !Number.isFinite(point.time))) {
    return (at): number | undefined => evaluateLane(lane, at);
  }
  const points = lane.points.toSorted((a, b) => a.time - b.time);
  let upper = 0;
  return (at): number | undefined => {
    if (!lane.enabled) {
      return undefined;
    }
    if (!(at >= (points[upper - 1]?.time ?? -Infinity) && at < (points[upper]?.time ?? Infinity))) {
      let low = 0;
      let high = points.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if ((points[mid]?.time ?? Infinity) <= at) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      upper = low;
    }
    return interpolateLane(lane, at, points[upper - 1], points[upper]);
  };
};
