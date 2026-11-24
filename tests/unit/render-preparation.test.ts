import { expect, test } from "bun:test";

import { prepareStemPlan, SongRenderer } from "../../src/audio";
import { createEffect, createEnvelope, createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";

// The scalar API remains a reference for sample-exact block preparation.
test("prepared FM blocks match scalar rendering through edits, mutes, envelopes and note boundaries", () => {
  const song = createSong();
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  channel.instruments = [createInstrument("FM (n-op)")];
  const instrument = required(channel.instruments[0]);
  instrument.release = 0.03;
  channel.cells.fill(1);
  required(channel.patterns[1]).notes = [
    createNote(0, 0.25, [48, 55]),
    createNote(0.5, 1, [48, 60]),
  ];
  const blocked = new SongRenderer(song, 8000);
  const scalar = new SongRenderer(song, 8000);
  for (let step = 0; step < 24; step++) {
    const patch = required(required(blocked.song.channels[0]).instruments[0]);
    if (step === 2) {
      blocked.muted = new Set([channel.id]);
    } else if (step === 4) {
      blocked.muted = new Set();
    } else if (step === 6) {
      required(patch.operators[0]).stereoDetune = 7;
      patch.volume = 0.6;
    } else if (step === 8) {
      patch.envelopes = [{ ...createEnvelope(), type: "Twang", target: "volume", a: 1, b: 0.3 }];
    } else if (step === 12) {
      patch.envelopes.push({
        ...createEnvelope(),
        type: "Decay",
        target: `operator:${required(patch.operators[0]).id}:amplitude`,
        a: 1,
        b: 0.2,
      });
    } else if (step === 16) {
      blocked.song = structuredClone(blocked.song);
    } else if (step === 20) {
      blocked.seek(0);
      scalar.seek(0);
    }
    if ([6, 8, 12].includes(step)) {
      blocked.song = structuredClone(blocked.song);
    }
    scalar.song = structuredClone(blocked.song);
    scalar.muted = blocked.muted;
    const left = new Float32Array(257);
    const right = new Float32Array(257);
    blocked.process(left, right);
    const expectedLeft = new Float32Array(left.length);
    const expectedRight = new Float32Array(right.length);
    for (let frame = 0; frame < left.length; frame++) {
      [expectedLeft[frame], expectedRight[frame]] = scalar.sample();
    }
    expect(left).toEqual(expectedLeft);
    expect(right).toEqual(expectedRight);
  }
});

for (const [type, planned] of [
  ["chip wave", false],
  ["chip wave", true],
  ["FM (n-op)", false],
] as const) {
  test(`unmuting ${type} mid-note matches uninterrupted ${planned ? "planned" : "scalar"} playback`, () => {
    const song = createSong();
    song.beatsPerBar = 3;
    song.tempo = 240;
    song.loopEnd = 2;
    const channel = required(song.channels[0]);
    channel.cells = [1, 2];
    channel.instruments = [createInstrument(type)];
    if (type === "FM (n-op)") {
      channel.effects = [createEffect("Echo")];
    }
    required(channel.patterns[1]).notes = [createNote(0, 2, 48)];
    required(channel.patterns[2]).notes = [createNote(0, 2, 55)];
    const sampleRate = 8000;
    const options = { channelIds: new Set([channel.id]), master: false };
    const reference = new SongRenderer(song, sampleRate, 0, undefined, options);
    const toggled = new SongRenderer(song, sampleRate, 0, undefined, options);
    const clock = new SongRenderer(song, sampleRate);
    // A bar lasts 6000 frames. Mute during the first note and unmute partway
    // through the second bar's note, which started while the track was muted.
    for (const [index, frames] of [512, 6200, 512].entries()) {
      const muted = index === 1;
      toggled.muted = muted ? new Set([channel.id]) : new Set();
      const block = planned ? prepareStemPlan(clock.preparePlan(frames)) : undefined;
      const render = (renderer: SongRenderer): Float32Array[] => {
        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        if (block) {
          renderer.processStem(left, right, block);
        } else {
          renderer.process(left, right);
        }
        return [left, right];
      };
      const expected = render(reference);
      for (const [side, actual] of render(toggled).entries()) {
        const control = required(expected[side]);
        expect(control.some((value) => Math.abs(value) > 0.001)).toBe(true);
        expect(actual.every((value, frame) => value === (muted ? 0 : control[frame]))).toBe(true);
      }
    }
  });
}
