import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import { createEffect, createEnvelope, createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";
import type { Song } from "../../src/model";

const sampleRate = 8000;
const fixture = (type: string): Song => {
  const song = createSong();
  song.tempo = 300;
  song.beatsPerBar = 1;
  song.barCount = 1;
  song.loopStart = 0;
  song.loopEnd = 1;
  const channel = required(song.channels[0]);
  song.channels = [channel];
  channel.cells = [0];
  const instrument = createInstrument(type);
  instrument.attack = 0;
  instrument.release = 0;
  const gain = createEffect("Gain");
  gain.parameters["gain"] = -12;
  instrument.effects = [gain];
  instrument.envelopes = [
    {
      ...createEnvelope(),
      target: `effect:${gain.id}:gain`,
      type: "Decay",
      timeBasis: "seconds",
      speed: 1,
      a: 1,
      b: 0,
    },
  ];
  channel.instruments = [instrument];
  return song;
};

type LivePair = {
  actual: SongRenderer;
  dry: SongRenderer;
  press: (pitch: number) => void;
  release: (pitch: number) => void;
  verify: (startFrame: number, frames: number) => void;
};

const livePair = (type: string): LivePair => {
  const song = fixture(type);
  const drySong = structuredClone(song);
  const dryInstrument = required(required(drySong.channels[0]).instruments[0]);
  dryInstrument.effects = [];
  dryInstrument.envelopes = [];
  const actual = new SongRenderer(song, sampleRate);
  const dry = new SongRenderer(drySong, sampleRate);
  const press = (pitch: number): void => {
    actual.audition(required(song.channels[0]), pitch);
    dry.audition(required(drySong.channels[0]), pitch);
  };
  const release = (pitch: number): void => {
    actual.release(pitch);
    dry.release(pitch);
  };
  const verify = (startFrame: number, frames: number): void => {
    let difference = 0;
    let energy = 0;
    for (let frame = 0; frame < frames; frame++) {
      const reference = dry.sample();
      const output = actual.sample();
      const age = (startFrame + frame) / sampleRate;
      const multiplier = 10 ** ((-12 * Math.exp(-4 * age)) / 20);
      difference = Math.max(
        difference,
        Math.abs(output[0] - reference[0] * multiplier),
        Math.abs(output[1] - reference[1] * multiplier),
      );
      energy += output[0] ** 2 + output[1] ** 2;
    }
    expect(difference).toBeLessThan(1e-6);
    expect(energy).toBeGreaterThan(0);
  };
  return { actual, dry, press, release, verify };
};

for (const type of ["chip wave", "FM (n-op)", "Custom chip wave"]) {
  test(`${type} held live effect envelopes continue through transport loop wraps`, () => {
    const { press, verify } = livePair(type);
    press(48);
    verify(0, 7000);
  });

  test(`${type} live effect envelopes retain age through overlapping chord changes`, () => {
    const { actual, dry, press, release, verify } = livePair(type);
    actual.playing = false;
    dry.playing = false;
    press(48);
    verify(0, 800);
    press(52);
    verify(800, 800);
    release(52);
    verify(1600, 800);
    press(55);
    verify(2400, 800);
    release(48);
    verify(3200, 800);
    release(55);
    press(67);
    verify(0, 800);
  });

  test(`${type} live effect envelopes restart on an off/on pair between render calls`, () => {
    const { actual, dry, press, release, verify } = livePair(type);
    actual.playing = false;
    dry.playing = false;
    press(48);
    verify(0, 800);
    release(48);
    press(48);
    verify(0, 800);
  });

  test(`${type} live effect envelopes continue through handoffs between render calls`, () => {
    const { actual, dry, press, release, verify } = livePair(type);
    actual.playing = false;
    dry.playing = false;
    press(48);
    verify(0, 800);
    press(52);
    release(48);
    verify(800, 800);
    press(55);
    release(52);
    press(60);
    release(55);
    verify(1600, 800);
  });

  test(`${type} live effect envelopes restart after a note leaves its track between render calls`, () => {
    const { actual, dry, press, verify } = livePair(type);
    actual.playing = false;
    dry.playing = false;
    actual.song.channels.push(createChannel());
    dry.song.channels.push(createChannel());
    press(48);
    verify(0, 800);
    actual.audition(required(actual.song.channels[1]), 48);
    dry.audition(required(dry.song.channels[1]), 48);
    press(48);
    verify(0, 800);
  });

  test(`${type} recorded ties preserve the shared effect envelope`, () => {
    const song = fixture(type);
    song.barCount = 2;
    song.loopEnd = 2;
    const channel = required(song.channels[0]);
    channel.cells = [1, 2];
    required(channel.patterns[1]).notes = [createNote(0, 1, 48)];
    const continued = createNote(0, 1, 48);
    continued.continues = true;
    required(channel.patterns[2]).notes = [continued];
    const longSong = structuredClone(song);
    longSong.beatsPerBar = 2;
    longSong.barCount = 1;
    longSong.loopEnd = 1;
    const longChannel = required(longSong.channels[0]);
    longChannel.cells = [1];
    required(longChannel.patterns[1]).notes = [createNote(0, 2, 48)];
    const tied = new SongRenderer(song, sampleRate);
    const long = new SongRenderer(longSong, sampleRate);
    let difference = 0;
    for (let frame = 0; frame < 3000; frame++) {
      const output = tied.sample();
      const reference = long.sample();
      difference = Math.max(
        difference,
        Math.abs(output[0] - reference[0]),
        Math.abs(output[1] - reference[1]),
      );
    }
    expect(difference).toBeLessThan(1e-6);
  });
}
