// Copyright (c) John Nesky and contributing authors.
// SPDX-License-Identifier: MIT
// See ../license/README.md for the source and license.
import { required } from "./model";
import type { Note } from "./model";
export const barWidth = 32;
export const patternHeight = 28;
const loopHeight = 20;
// SlopeMP's lavender, cyan, amber and rose, with matching muted shades.
const channelColors = [
  { channel: "#b9a0ff", dim: "#756488", note: "#b99bec", secondary: "#8560ce" },
  { channel: "#67d9d3", dim: "#4b7b7e", note: "#a4e5df", secondary: "#579f9f" },
  { channel: "#edbf74", dim: "#8c704b", note: "#f1d19c", secondary: "#bc935e" },
  { channel: "#ed8ca7", dim: "#8c566f", note: "#f0b3c6", secondary: "#b76b89" },
];
export const colorsForChannel = (index: number): (typeof channelColors)[number] =>
  required(channelColors[index % channelColors.length]);
const prettyNumber = (value: number): string => value.toFixed(2).replace(/\.?0*$/u, "");
export const notePath = (
  note: Note,
  pitch: number,
  pixelsPerBeat: number,
  pitchToY: (pitch: number) => number,
  radius: number,
  showSize: boolean,
): string => {
  const { start } = note;
  const { pins } = note;
  if (pins.length === 0) {
    return "";
  }
  const totalWidth: number = pixelsPerBeat * (required(pins.at(-1)).time + required(pins[0]).time);
  const endOffset: number = 0.5 * Math.min(2, totalWidth - 1);

  let nextPin: Note["pins"][number] = required(pins[0]);

  let pathString: string = `M ${prettyNumber(pixelsPerBeat * (start + nextPin.time) + endOffset)} ${prettyNumber(pitchToY(pitch) + radius * (showSize ? nextPin.volume / 3 : 1))} `;
  for (let i: number = 1; i < pins.length; i++) {
    const prevPin: Note["pins"][number] = nextPin;
    nextPin = required(pins[i]);
    const prevSide: number = pixelsPerBeat * (start + prevPin.time) + (i === 1 ? endOffset : 0);
    const nextSide: number =
      pixelsPerBeat * (start + nextPin.time) - (i === pins.length - 1 ? endOffset : 0);
    const prevHeight: number = pitchToY(pitch + prevPin.interval);
    const nextHeight: number = pitchToY(pitch + nextPin.interval);
    const prevSize: number = showSize ? prevPin.volume / 3 : 1;
    const nextSize: number = showSize ? nextPin.volume / 3 : 1;
    pathString += `L ${prettyNumber(prevSide)} ${prettyNumber(prevHeight - radius * prevSize)} `;
    if (prevPin.interval > nextPin.interval) {
      pathString += `L ${prettyNumber(prevSide + 1)} ${prettyNumber(prevHeight - radius * prevSize)} `;
    }
    if (prevPin.interval < nextPin.interval) {
      pathString += `L ${prettyNumber(nextSide - 1)} ${prettyNumber(nextHeight - radius * nextSize)} `;
    }
    pathString += `L ${prettyNumber(nextSide)} ${prettyNumber(nextHeight - radius * nextSize)} `;
  }
  for (let i: number = pins.length - 2; i >= 0; i--) {
    const prevPin: Note["pins"][number] = nextPin;
    nextPin = required(pins[i]);
    const prevSide: number =
      pixelsPerBeat * (start + prevPin.time) - (i === pins.length - 2 ? endOffset : 0);
    const nextSide: number = pixelsPerBeat * (start + nextPin.time) + (i === 0 ? endOffset : 0);
    const prevHeight: number = pitchToY(pitch + prevPin.interval);
    const nextHeight: number = pitchToY(pitch + nextPin.interval);
    const prevSize: number = showSize ? prevPin.volume / 3 : 1;
    const nextSize: number = showSize ? nextPin.volume / 3 : 1;
    pathString += `L ${prettyNumber(prevSide)} ${prettyNumber(prevHeight + radius * prevSize)} `;
    if (prevPin.interval < nextPin.interval) {
      pathString += `L ${prettyNumber(prevSide - 1)} ${prettyNumber(prevHeight + radius * prevSize)} `;
    }
    if (prevPin.interval > nextPin.interval) {
      pathString += `L ${prettyNumber(nextSide + 1)} ${prettyNumber(nextHeight + radius * nextSize)} `;
    }
    pathString += `L ${prettyNumber(nextSide)} ${prettyNumber(nextHeight + radius * nextSize)} `;
  }
  pathString += "z";

  return pathString;
};

export const loopPath = (start: number, end: number, inset = 2): string => {
  const radius = loopHeight / 2;
  return `M ${start + radius} ${inset} L ${end - radius} ${inset} A ${radius - inset} ${radius - inset} 0 0 1 ${end - radius} ${loopHeight - inset} L ${start + radius} ${loopHeight - inset} A ${radius - inset} ${radius - inset} 0 0 1 ${start + radius} ${inset} z`;
};

// The insertion cursor aligns the copied length to beats and stops at neighboring notes.
export const insertionRange = (
  beat: number,
  length: number,
  rhythm: number,
  beats: number,
  notes: readonly Note[],
): { start: number; end: number } => {
  const unit = 1 / rhythm;
  const part = Math.floor(Math.max(0, Math.min(beats - unit, beat)) / unit) * unit;
  const maxDivision = rhythm % 3 === 0 && rhythm % 4 !== 0 ? 1 / 3 : 1 / 2;
  const fullBeats = Math.floor(part);
  const mod = part - fullBeats;
  let start = fullBeats;
  if (length === 1 / 24) {
    start = part;
  } else if (length === 1) {
    if (mod > maxDivision) {
      start += Math.floor(mod / maxDivision) * maxDivision;
    }
  } else if (length < 1) {
    let division = 24 % Math.round(length * 24) === 0 ? length : Math.min(length, maxDivision);
    while (division < maxDivision && 24 % Math.round(division * 24) !== 0) {
      division += 1 / 24;
    }
    start += Math.floor(mod / division) * division;
  }
  let end = start + length;
  const previous = notes.findLast((n) => n.end <= beat)?.end ?? 0;
  const next = notes.find((n) => n.start > beat)?.start ?? beats;
  if (start < previous) {
    start = previous;
    end = Math.min(next, start + length);
  } else if (end > next) {
    end = next;
    start = Math.max(previous, end - length);
  }
  return { start, end };
};
