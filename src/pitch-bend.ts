// Adapted from UltraBox ChangePitchBend / ChangePins (MIT).
// See ../license/ultrabox-MIT.txt.
import { required } from "./model";
import type { Note } from "./model";

const normalizePins = (note: Note, pins: Note["pins"]): void => {
  // As in ChangePins, later pins win at coincident times.
  const ordered = pins.filter((pin, i) => !pins[i + 1] || pin.time < required(pins[i + 1]).time);
  for (let i = 1; i < ordered.length - 1;) {
    const prev = required(ordered[i - 1]);
    const pin = required(ordered[i]);
    const next = required(ordered[i + 1]);
    if (
      prev.interval === pin.interval &&
      pin.interval === next.interval &&
      prev.volume === pin.volume &&
      pin.volume === next.volume
    ) {
      ordered.splice(i, 1);
    } else {
      i++;
    }
  }
  const first = required(ordered[0]);
  const firstTime = first.time;
  const firstInterval = first.interval;
  note.start += firstTime;
  note.pitches = note.pitches.map((p) => p + firstInterval);
  note.pins = ordered.map((pin) => ({
    ...pin,
    time: pin.time - firstTime,
    interval: pin.interval - firstInterval,
  }));
  note.end = note.start + required(note.pins.at(-1)).time;
  if (note.start !== 0) {
    note.continues = false;
  }
};

// Bend in either direction. Keep expression, replace the crossed pins, and hold
// the destination until an existing pitch change interrupts it.
export const bendNote = (
  note: Note,
  start: number,
  end: number,
  pitch: number,
  pitchIndex: number,
): void => {
  const bendStart = start - note.start;
  const bendEnd = end - note.start;
  const bendTo = Math.max(
    -Math.min(...note.pitches),
    Math.min(108 - Math.max(...note.pitches), pitch - (note.pitches[pitchIndex] ?? 0)),
  );
  const direction = bendEnd > bendStart ? 1 : -1;
  const source = direction === 1 ? note.pins : note.pins.toReversed();
  const pins: Note["pins"] = [];
  let setStart = false;
  let setEnd = false;
  let interval = 0;
  let volume = 3;
  let persist = true;
  for (const pin of source) {
    if (!setStart) {
      if (pin.time * direction <= bendStart * direction) {
        ({ interval, volume } = pin);
      }
      if (pin.time * direction < bendStart * direction) {
        pins.push({ ...pin });
        continue;
      }
      pins.push({ time: bendStart, interval, volume });
      setStart = true;
    }
    if (!setEnd) {
      if (pin.time * direction <= bendEnd * direction) {
        ({ interval, volume } = pin);
      }
      if (pin.time * direction < bendEnd * direction) {
        continue;
      }
      pins.push({ time: bendEnd, interval: bendTo, volume });
      setEnd = true;
    }
    if (pin.time === bendEnd) {
      continue;
    }
    if (pin.interval !== interval) {
      persist = false;
    }
    pins.push({ ...pin, interval: persist ? bendTo : pin.interval });
  }
  if (!setEnd) {
    pins.push({ time: bendEnd, interval: bendTo, volume });
  }
  if (direction === -1) {
    pins.reverse();
  }
  normalizePins(note, pins);
};

// UltraBox ChangePinTime removes pins crossed by the moved pin, including endpoints.
export const moveNotePin = (
  note: Note,
  index: number,
  time: number,
  continues: boolean,
): boolean => {
  const pin = required(note.pins[index]);
  const shifted = time - note.start;
  const low = Math.min(pin.time, shifted);
  const high = Math.max(pin.time, shifted);
  const before = note.pins.filter((p) => p.time < low);
  const after = note.pins.filter((p) => p.time > high);
  const pins = [...before, { ...pin, time: shifted }, ...after];
  if (pins.length < 2) {
    return false;
  }
  note.continues = before.length === 0 && after.length > 0 ? continues : (note.continues ?? false);
  normalizePins(note, pins);
  return true;
};
