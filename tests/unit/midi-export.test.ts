import { describe, expect, test } from "bun:test";

import { createEffect, createInstrument } from "../../src/instruments";
import { exportMidi, importMidi } from "../../src/midi";
import { createChannel, createNote, createSong, required, validateSong } from "../../src/model";
import type { AutomationLane, Song } from "../../src/model";

type MidiEvent = { tick: number; status: number; data: number[]; meta: number | null };
const parseMidi = (bytes: Uint8Array): MidiEvent[][] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("MThd");
  expect(view.getUint16(8)).toBe(1);
  expect(view.getUint16(12)).toBe(480);
  let offset = 14;
  const variable = (): number => {
    let value = 0;
    for (let count = 0; count < 4; count++) {
      const byte = required(bytes[offset++]);
      value = value * 128 + (byte & 127);
      if (byte < 128) {
        return value;
      }
    }
    throw new Error("Invalid MIDI test output.");
  };
  const tracks: MidiEvent[][] = [];
  for (let track = 0; track < view.getUint16(10); track++) {
    expect(new TextDecoder().decode(bytes.slice(offset, offset + 4))).toBe("MTrk");
    const end = offset + 8 + view.getUint32(offset + 4);
    offset += 8;
    let tick = 0;
    const events: MidiEvent[] = [];
    while (offset < end) {
      tick += variable();
      const status = required(bytes[offset++]);
      if (status === 255) {
        const meta = required(bytes[offset++]);
        const length = variable();
        const data = Array.from(bytes.slice(offset, offset + length));
        events.push({ tick, status, data, meta });
        offset += length;
      } else {
        expect(status).toBeGreaterThanOrEqual(128);
        const length = (status & 240) === 192 || (status & 240) === 208 ? 1 : 2;
        const data = Array.from(bytes.slice(offset, offset + length));
        expect(data.every((value) => value >= 0 && value < 128)).toBe(true);
        events.push({ tick, status, data, meta: null });
        offset += length;
      }
    }
    expect(offset).toBe(end);
    tracks.push(events);
  }
  expect(offset).toBe(bytes.byteLength);
  return tracks;
};
const fixture = (): Song => {
  const song = createSong();
  song.channels = song.channels.slice(0, 1);
  song.barCount = 3;
  song.beatsPerBar = 2;
  song.loopEnd = 3;
  song.tempo = 150;
  const track = required(song.channels[0]);
  track.cells = [1, 1, 1];
  track.instruments = [createInstrument()];
  required(track.instruments[0]).volume = 1;
  required(track.patterns[1]).notes = [createNote(0, 2, 48)];
  return song;
};
const auto = (song: Song, lanes: AutomationLane[], cells = [1, 0, 0]): void => {
  const track = createChannel("automation", song.barCount, song.patternCount);
  track.cells = cells;
  required(track.patterns[1]).lanes = lanes;
  song.channels.push(track);
};
const lane = (target: string, points: AutomationLane["points"]): AutomationLane => ({
  id: target,
  target,
  enabled: true,
  interpolation: "linear",
  points,
});
const tempoAt = (events: MidiEvent[], beat: number): number => {
  const event = required(
    events.findLast((value) => value.meta === 81 && value.tick <= Math.round(beat * 480)),
  );
  const microseconds =
    required(event.data[0]) * 65_536 + required(event.data[1]) * 256 + required(event.data[2]);
  return 60_000_000 / microseconds;
};
const ccAt = (events: MidiEvent[], controller: number, beat: number): number =>
  required(
    required(
      events.findLast(
        (value) =>
          (value.status & 240) === 176 &&
          value.data[0] === controller &&
          value.tick <= Math.round(beat * 480),
      ),
    ).data[1],
  );
const bendAt = (events: MidiEvent[], beat: number): number => {
  const event = required(
    events.findLast(
      (value) => (value.status & 240) === 224 && value.tick <= Math.round(beat * 480),
    ),
  );
  return required(event.data[0]) + required(event.data[1]) * 128;
};

describe("MIDI exports flatten effective song automation", () => {
  test("linear tempo ramps are sampled, lower active Song rows win, and zero bars restore saved tempo", () => {
    const song = fixture();
    auto(song, [
      lane("tempo", [
        { time: 0, value: 100 },
        { time: 2, value: 200 },
      ]),
    ]);
    auto(song, [
      lane("tempo", [
        { time: 0.5, value: 250 },
        { time: 1, value: 250 },
      ]),
    ]);
    validateSong(song);
    const events = required(parseMidi(exportMidi(song))[0]);
    expect(events.filter((event) => event.meta === 81).length).toBeGreaterThan(30);
    expect(tempoAt(events, 0)).toBeCloseTo(100, 3);
    expect(tempoAt(events, 0.25)).toBeCloseTo(112.5, 3);
    expect(tempoAt(events, 0.5)).toBeCloseTo(250, 3);
    expect(tempoAt(events, 1)).toBeCloseTo(250, 3);
    expect(tempoAt(events, 1.25)).toBeCloseTo(162.5, 3);
    expect(tempoAt(events, 2)).toBeCloseTo(150, 3);
    expect(tempoAt(events, 4)).toBeCloseTo(150, 3);
  });
  test("song volume and note expression use separate MIDI controllers without doubling onset expression", () => {
    const song = fixture();
    song.volume = 80;
    const note = required(required(required(song.channels[0]).patterns[1]).notes[0]);
    note.pins = [
      { time: 0, interval: 0, volume: 1.5 },
      { time: 2, interval: 0, volume: 3 },
    ];
    auto(song, [
      lane("volume", [
        { time: 0, value: 100 },
        { time: 2, value: 0 },
      ]),
    ]);
    const events = required(parseMidi(exportMidi(song))[1]);
    expect(ccAt(events, 7, 0)).toBe(127);
    expect(ccAt(events, 7, 1)).toBe(64);
    expect(ccAt(events, 7, 2)).toBe(102);
    expect(ccAt(events, 11, 0)).toBe(64);
    expect(ccAt(events, 11, 1)).toBe(95);
    const onset = required(events.find((event) => (event.status & 240) === 144));
    expect(onset.data[1]).toBe(100);
    const onsetIndex = events.indexOf(onset);
    expect(
      events
        .slice(0, onsetIndex)
        .some((event) => (event.status & 240) === 176 && event.data[0] === 11),
    ).toBe(true);
  });
  test("global detune and interpolated note bends share an explicit pitch-wheel range and reset at zero cells", () => {
    const song = fixture();
    song.detune = -50;
    const note = required(required(required(song.channels[0]).patterns[1]).notes[0]);
    note.pins = [
      { time: 0, interval: 0, volume: 3 },
      { time: 1, interval: 1, volume: 3 },
      { time: 2, interval: 0, volume: 3 },
    ];
    auto(song, [
      lane("detune", [
        { time: 0, value: 0 },
        { time: 2, value: 200 },
      ]),
    ]);
    const events = required(parseMidi(exportMidi(song))[1]);
    const sensitivity = ccAt(events, 6, 0);
    expect(sensitivity).toBe(3);
    expect(bendAt(events, 0)).toBe(8192);
    expect(bendAt(events, 0.5)).toBe(8192 + Math.round(8191 / sensitivity));
    expect(bendAt(events, 1)).toBe(8192 + Math.round((2 * 8191) / sensitivity));
    expect(bendAt(events, 2)).toBe(8192 - Math.round((0.5 * 8192) / sensitivity));
    expect(events.filter((event) => (event.status & 240) === 224).length).toBeGreaterThan(48);
  });
  test("tempo lane returns to the saved tempo after its last point", () => {
    const song = fixture();
    auto(song, [
      lane("tempo", [
        { time: 0.5, value: 240 },
        { time: 1.5, value: 240 },
      ]),
    ]);
    const events = required(parseMidi(exportMidi(song))[0]);
    expect(tempoAt(events, 0)).toBeCloseTo(150);
    expect(tempoAt(events, 0.5)).toBeCloseTo(240);
    expect(tempoAt(events, 1.5)).toBeCloseTo(240);
    expect(tempoAt(events, 1.5 + 1 / 480)).toBeCloseTo(150);
  });
  test("Next Bar events shorten the finite export and no controller or note events exceed that sequence", () => {
    const song = fixture();
    auto(song, [
      lane("tempo", [
        { time: 0, value: 90 },
        { time: 2, value: 210 },
      ]),
      { ...lane("nextBar", [{ time: 0.5, value: 1 }]), interpolation: "hold" },
    ]);
    const tracks = parseMidi(exportMidi(song));
    expect(tempoAt(required(tracks[0]), 0.5)).toBeCloseTo(150);
    for (const events of tracks) {
      expect(required(events.at(-1)).meta).toBe(47);
      expect(required(events.at(-1)).tick).toBe(Math.round(4.5 * 480));
      expect(events.every((event) => event.tick <= Math.round(4.5 * 480))).toBe(true);
    }
    const note = required(required(tracks[1]).find((event) => (event.status & 240) === 128));
    expect(note.tick).toBe(240);
  });
  test("key signatures encode every major and minor tonic with valid sharp or flat counts", () => {
    for (const scale of ["Major", "Minor"]) {
      for (let key = 0; key < 12; key++) {
        const song = fixture();
        song.key = key;
        song.scale = scale;
        const signature = required(
          required(parseMidi(exportMidi(song))[0]).find((event) => event.meta === 89),
        );
        const raw = required(signature.data[0]);
        const accidentals = raw > 127 ? raw - 256 : raw;
        const minor = required(signature.data[1]);
        expect(accidentals).toBeGreaterThanOrEqual(-7);
        expect(accidentals).toBeLessThanOrEqual(7);
        expect(minor).toBe(scale === "Minor" ? 1 : 0);
        expect((((accidentals * 7 + (minor ? 9 : 0)) % 12) + 12) % 12).toBe(key);
      }
    }
  });
});

describe("MIDI expression import", () => {
  test("exported mix and expression controllers reimport as note contours without a second mix attenuation", () => {
    const song = fixture();
    song.volume = 80;
    const original = required(song.channels[0]);
    required(original.instruments[0]).volume = 0.6;
    const note = required(required(original.patterns[1]).notes[0]);
    note.pins = [
      { time: 0, interval: 0, volume: 1.5 },
      { time: 2, interval: 0, volume: 3 },
    ];
    const midi = exportMidi(song);
    const events = required(parseMidi(midi)[1]);
    const imported = importMidi(midi);
    validateSong(imported);
    const track = required(imported.channels[0]);
    expect(required(track.instruments[0]).volume).toBe(1);
    const recorded = required(required(track.patterns[1]).notes[0]);
    expect(recorded.pitches).toEqual([48]);
    const before = required(recorded.pins.find((pin) => pin.time === 0));
    const middle = required(recorded.pins.find((pin) => pin.time === 1));
    const expected = (beat: number): number =>
      (((((100 / 127) * ccAt(events, 7, beat)) / 127) * ccAt(events, 11, beat)) / 127) * 3;
    expect(before.volume).toBeCloseTo(expected(0), 10);
    expect(middle.volume).toBeCloseTo(expected(1), 10);
    expect(middle.volume).toBeGreaterThan(before.volume);
    expect(before.volume / 3).toBeCloseTo(0.6 * 0.8 * 0.5 * (100 / 127), 2);
  });
  test("RPN pitch-wheel sensitivity restores exported combined global detune and bends", () => {
    const song = fixture();
    song.detune = -50;
    const note = required(required(required(song.channels[0]).patterns[1]).notes[0]);
    note.pins = [
      { time: 0, interval: 0, volume: 0 },
      { time: 1, interval: 1, volume: 3 },
      { time: 2, interval: 0, volume: 3 },
    ];
    auto(song, [
      lane("detune", [
        { time: 0, value: 0 },
        { time: 2, value: 200 },
      ]),
    ]);
    const imported = importMidi(exportMidi(song));
    validateSong(imported);
    const track = required(imported.channels[0]);
    const recorded = required(required(track.patterns[1]).notes[0]);
    expect(required(recorded.pins[0]).volume).toBe(0);
    expect(required(recorded.pins.find((pin) => pin.time === 1)).interval).toBeCloseTo(2, 3);
    const secondBar = required(required(track.patterns[2]).notes[0]);
    expect(required(secondBar.pins[0]).interval).toBeCloseTo(-0.5, 3);
  });
});

test("tied chords export as sustained MIDI notes and import their continuations", () => {
  const song = fixture();
  const track = required(song.channels[0]);
  const note = required(required(track.patterns[1]).notes[0]);
  note.continues = true;
  const bytes = exportMidi(song);
  const events = parseMidi(bytes).flat();
  expect(events.filter((event) => (event.status & 240) === 144)).toHaveLength(1);
  expect(events.filter((event) => (event.status & 240) === 128)).toHaveLength(1);
  const imported = importMidi(bytes);
  const importedChannel = required(imported.channels.find((value) => value.kind === "track"));
  expect(importedChannel.patterns[importedChannel.cells[1] ?? 0]?.notes[0]?.continues).toBe(true);
});

test("MIDI tie chains retain their original keys and accumulate bends", () => {
  const song = fixture();
  const track = required(song.channels[0]);
  track.cells = [1, 2, 3];
  for (let index = 0; index < 3; index++) {
    const note = createNote(0, 2, 48 + index * 2);
    note.continues = true;
    required(note.pins.at(-1)).interval = index < 2 ? 2 : 0;
    required(track.patterns[index + 1]).notes = [note];
  }
  const events = parseMidi(exportMidi(song)).flat();
  const ons = events.filter((event) => (event.status & 240) === 144);
  const offs = events.filter((event) => (event.status & 240) === 128);
  expect(ons).toHaveLength(1);
  expect(offs).toHaveLength(1);
  expect(ons[0]?.data[0]).toBe(60);
  expect(offs[0]?.data[0]).toBe(60);
  expect(events.find((event) => (event.status & 240) === 176 && event.data[0] === 6)?.data[1]).toBe(
    4,
  );
});

test("MIDI pan imports into an editable effect and exports from that effect", () => {
  const song = fixture();
  const instrument = required(required(song.channels[0]).instruments[0]);
  const pan = createEffect("Pan");
  pan.parameters["position"] = -50;
  instrument.effects.push(pan);
  const bytes = exportMidi(song);
  expect(ccAt(required(parseMidi(bytes)[1]), 10, 0)).toBe(32);
  const imported = importMidi(bytes);
  const importedInstrument = required(required(imported.channels[0]).instruments[0]);
  expect(importedInstrument).not.toHaveProperty("pan");
  const importedPan = required(
    importedInstrument.effects.findLast((effect) => effect.type === "Pan"),
  );
  expect(importedPan.parameters["position"]).toBe(-50);
  const exported = exportMidi(imported);
  expect(ccAt(required(parseMidi(exported)[1]), 10, 0)).toBe(32);
  importedPan.enabled = false;
  expect(ccAt(required(parseMidi(exportMidi(imported))[1]), 10, 0)).toBe(64);
});
