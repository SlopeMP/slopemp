import { expect, test } from "bun:test";

import { evaluateAutomation } from "../../src/audio";
import { exportMidi, importMidi } from "../../src/midi";
import { createChannel, createNote, createSong, required, validateSong } from "../../src/model";
import { decodeSong, encodeSong } from "../../src/storage";

test("songs accept and preserve tempos down to 1 BPM", () => {
  const song = createSong();
  song.tempo = 1;
  validateSong(song);
  expect(decodeSong(encodeSong(song)).tempo).toBe(1);
  expect(evaluateAutomation(song, 0, 0).tempo).toBe(1);
  song.tempo = 0;
  expect(() => {
    validateSong(song);
  }).toThrow("Invalid tempo");
});

test("tempo automation can reach 1 BPM", () => {
  const song = createSong();
  const channel = createChannel("automation", song.barCount);
  required(channel.patterns[1]).lanes = [
    {
      id: "tempo",
      target: "tempo",
      enabled: true,
      interpolation: "hold",
      points: [{ time: 0, value: 1 }],
    },
  ];
  channel.cells[0] = 1;
  song.channels.push(channel);
  expect(evaluateAutomation(song, 0, 0).tempo).toBe(1);
});

test("MIDI imports preserve tempos below 30 BPM", () => {
  const song = createSong();
  song.tempo = 10;
  const channel = required(song.channels[0]);
  channel.cells[0] = 1;
  required(channel.patterns[1]).notes = [createNote(0, 1, 48)];
  expect(importMidi(exportMidi(song)).tempo).toBe(10);
});
