import { expect, test } from "bun:test";

import { PRESET_DEFINITIONS } from "@slopemp/song/presets";

import { SongRenderer } from "../../src/audio";
import { PRESET_GROUPS, presetInstrument, validateInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { bendNote, moveNotePin } from "../../src/pitch-bend";
import { getDrumWave, noises } from "../../src/synth/noise";
import fixtures from "../fixtures/ultrabox-noise.json";

// Captured from UltraBox 91b4bc1988e605ba5f5009f557e52ccb33975754 with a seeded RNG.
test("all fifteen noise tables match UltraBox sample for sample", () => {
  const { random } = Math;
  try {
    for (const [index, fixture] of fixtures.entries()) {
      let seed = 12_345;
      Math.random = (): number => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 4_294_967_296;
      };
      required(noises[index]).samples = null;
      const wave = getDrumWave(index);
      const hash = new Bun.CryptoHasher("sha256").update(new Uint8Array(wave.buffer)).digest("hex");
      expect(required(noises[index]).name).toBe(fixture.name);
      expect(hash).toBe(fixture.hash);
    }
  } finally {
    Math.random = random;
    for (const noise of noises) {
      noise.samples = null;
    }
  }
});

test("every built-in preset appears in the menu and creates a valid independent instrument", () => {
  const names = Object.values(PRESET_GROUPS).flat();
  expect(names.toSorted()).toEqual(Object.keys(PRESET_DEFINITIONS).toSorted());
  for (const name of names) {
    const first = presetInstrument(name);
    const second = presetInstrument(name);
    expect(validateInstrument(first)).toBe(true);
    expect(second.id).not.toBe(first.id);
    const targets = new Set(
      first.effects
        .map((effect) => effect.id)
        .concat(first.operators.map((operator) => operator.id)),
    );
    for (const env of first.envelopes) {
      if (env.target.includes(":")) {
        expect(targets.has(env.target.split(":")[1] ?? "")).toBe(true);
      }
    }
  }
  expect(presetInstrument("grand piano").type).toBe("picked string");
  expect(presetInstrument("electric piano 1").type).toBe("harmonics");
  expect(presetInstrument("standard drumset").drums[0]?.spectrum).not.toEqual(
    presetInstrument("standard drumset").drums[1]?.spectrum,
  );
});

test("forward bends ramp from the starting cell and hold their target", () => {
  const note = createNote(0, 4, [48, 55]);
  bendNote(note, 1, 2, 60, 1);
  expect(note.pitches).toEqual([48, 55]);
  expect(note.pins).toEqual([
    { time: 0, interval: 0, volume: 3 },
    { time: 1, interval: 0, volume: 3 },
    { time: 2, interval: 5, volume: 3 },
    { time: 4, interval: 5, volume: 3 },
  ]);
});

test("backward bends extend notes and normalize chord pitches", () => {
  const note = createNote(1, 4, [48, 55]);
  bendNote(note, 2, 0, 50, 1);
  expect(note.start).toBe(0);
  expect(note.pitches).toEqual([43, 50]);
  expect(note.pins[0]).toEqual({ time: 0, interval: 0, volume: 3 });
  expect(note.pins.at(-1)).toEqual({ time: 4, interval: 5, volume: 3 });
});

test("a later pitch change interrupts bend persistence and expression survives", () => {
  const note = createNote(0, 4, 48);
  note.pins = [
    { time: 0, interval: 0, volume: 3 },
    { time: 2, interval: 0, volume: 2 },
    { time: 3, interval: -2, volume: 1 },
    { time: 4, interval: -2, volume: 0 },
  ];
  bendNote(note, 0.5, 1, 55, 0);
  expect(note.pins.find((p) => p.time === 2)).toEqual({ time: 2, interval: 7, volume: 2 });
  expect(note.pins.find((p) => p.time === 3)).toEqual({ time: 3, interval: -2, volume: 1 });
  expect(note.pins.at(-1)?.volume).toBe(0);
});

test("moving a bend pin across an endpoint extends and normalizes the note", () => {
  const note = createNote(1, 4, [48, 55]);
  note.pins.splice(1, 0, { time: 1, interval: 5, volume: 2 });
  expect(moveNotePin(note, 1, 0, false)).toBe(true);
  expect(note.start).toBe(0);
  expect(note.pitches).toEqual([53, 60]);
  expect(note.pins).toEqual([
    { time: 0, interval: 0, volume: 2 },
    { time: 4, interval: -5, volume: 3 },
  ]);
  expect(moveNotePin(note, 0, 4, false)).toBe(false);
});

test("all built-in presets render finite audible audio", () => {
  const song = createSong();
  const channel = required(song.channels[0]);
  song.channels = [channel];
  channel.cells[0] = 1;
  required(channel.patterns[1]).notes = [createNote(0, 1, 48)];
  for (const name of Object.keys(PRESET_DEFINITIONS)) {
    channel.instruments = [presetInstrument(name)];
    const renderer = new SongRenderer(song);
    let energy = 0;
    let finite = true;
    for (let frame = 0; frame < 2048; frame++) {
      const [left, right] = renderer.sample();
      finite &&= Number.isFinite(left) && Number.isFinite(right);
      energy += left * left + right * right;
    }
    expect(finite, name).toBe(true);
    expect(energy, name).toBeGreaterThan(0);
  }
});
