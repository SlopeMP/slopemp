import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import { createEffect, createEnvelope, createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";

const fixture = (): ReturnType<typeof createSong> => {
  const song = createSong();
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  channel.instruments = [createInstrument("FM (n-op)")];
  channel.cells.fill(1);
  required(channel.patterns[1]).notes = [createNote(0, 0.25, 48), createNote(1, 1.5, 55)];
  return song;
};
const render = (renderer: SongRenderer, frames: number): Float32Array => {
  const left = new Float32Array(frames);
  renderer.process(left, new Float32Array(frames));
  expect(left.every(Number.isFinite)).toBe(true);
  return left;
};

test("loop edits preserve playing notes and effect tails sample for sample", () => {
  const song = fixture();
  const instrument = required(required(song.channels[0]).instruments[0]);
  const echo = createEffect("Echo");
  echo.parameters["time"] = 0.05;
  instrument.effects.push(echo);
  const control = new SongRenderer(song);
  const edited = new SongRenderer(song);
  render(control, 1337);
  render(edited, 1337);
  for (let iteration = 0; iteration < 8; iteration++) {
    edited.song = structuredClone(song);
    edited.song.loopStart = iteration % 2;
    edited.song.loopEnd = song.barCount - 1;
    expect(render(edited, 512)).toEqual(render(control, 512));
  }
});

test("instrument edits between ticks preserve the onset of future notes", () => {
  const song = fixture();
  const instrument = required(required(song.channels[0]).instruments[0]);
  instrument.release = 0;
  const control = new SongRenderer(song);
  const edited = new SongRenderer(song);
  const changedAt = 137;
  render(control, changedAt);
  render(edited, changedAt);
  edited.song = structuredClone(song);
  required(required(edited.song.channels[0]).instruments[0]).volume *= 0.75;
  const expected = render(control, 22_000);
  const actual = render(edited, 22_000);
  const windowStart = 17_000 - changedAt;
  const onset = (samples: Float32Array): number =>
    samples.findIndex((value, index) => index >= windowStart && Math.abs(value) > 1e-6);
  expect(onset(expected)).toBeGreaterThan(windowStart);
  expect(Math.abs(onset(actual) - onset(expected))).toBeLessThanOrEqual(1);
});

for (const type of ["chip wave", "FM (n-op)", "Custom chip wave"]) {
  test(`${type} instrument and channel detune share processing and respect bypass`, () => {
    const song = fixture();
    const instrument = createInstrument(type);
    const channel = required(song.channels[0]);
    channel.instruments = [instrument];
    song.detune = 25;
    const baseline = render(new SongRenderer(song), 4096);
    const first = createEffect("Detune");
    first.parameters["cents"] = 40;
    const second = createEffect("Detune");
    second.parameters["cents"] = -10;
    instrument.effects = [first, second];
    const reference = structuredClone(song);
    const referenceChannel = required(reference.channels[0]);
    referenceChannel.effects = required(referenceChannel.instruments[0]).effects;
    required(referenceChannel.instruments[0]).effects = [];
    const actual = render(new SongRenderer(song), 4096);
    expect(actual).not.toEqual(baseline);
    expect(actual).toEqual(render(new SongRenderer(reference), 4096));
    first.enabled = false;
    required(referenceChannel.effects[0]).enabled = false;
    expect(render(new SongRenderer(song), 4096)).toEqual(render(new SongRenderer(reference), 4096));
  });

  test(`${type} shared detune uses enabled cents envelopes`, () => {
    const song = fixture();
    const instrument = createInstrument(type);
    required(song.channels[0]).instruments = [instrument];
    song.detune = 25;
    const effect = createEffect("Detune");
    effect.parameters["cents"] = 40;
    instrument.effects = [effect];
    instrument.envelopes = [
      { ...createEnvelope(), target: `effect:${effect.id}:cents`, a: 0.5, b: 0.5 },
      { ...createEnvelope(), target: `effect:${effect.id}:cents`, a: -1, b: -1 },
    ];
    const reference = structuredClone(song);
    const referenceInstrument = required(required(reference.channels[0]).instruments[0]);
    referenceInstrument.envelopes = [];
    required(referenceInstrument.effects[0]).parameters["cents"] = -20;
    expect(render(new SongRenderer(song), 4096)).toEqual(render(new SongRenderer(reference), 4096));
    required(instrument.envelopes[1]).enabled = false;
    required(referenceInstrument.effects[0]).parameters["cents"] = 20;
    expect(render(new SongRenderer(song), 4096)).toEqual(render(new SongRenderer(reference), 4096));
  });
}

test("99 unused native channels leave the audible mix unchanged", () => {
  const song = fixture();
  const control = new SongRenderer(song);
  const sparse = structuredClone(song);
  for (let index = 1; index < 100; index++) {
    const channel = createChannel("track", song.barCount, song.patternCount);
    channel.instruments = [createInstrument("FM (n-op)")];
    channel.cells.fill(0);
    sparse.channels.push(channel);
  }
  expect(render(new SongRenderer(sparse), 4096)).toEqual(render(control, 4096));
});

test("effect envelope bindings follow replaced targets and enabled flags", () => {
  const song = fixture();
  const instrument = createInstrument("Custom chip wave");
  instrument.volume = 0.02;
  required(song.channels[0]).instruments = [instrument];
  const first = createEffect("Gain");
  const second = createEffect("Gain");
  first.parameters["gain"] = 6;
  second.parameters["gain"] = 12;
  instrument.effects = [first, second];
  instrument.envelopes = [
    { ...createEnvelope(), type: "None", target: `effect:${first.id}:gain`, a: 0.5 },
    { ...createEnvelope(), type: "None", target: `effect:${second.id}:gain`, a: 0.25 },
  ];
  const edited = new SongRenderer(song);
  render(edited, 137);
  const changed = structuredClone(song);
  const patch = required(required(changed.channels[0]).instruments[0]);
  required(patch.envelopes[0]).target = `effect:${second.id}:gain`;
  required(patch.envelopes[1]).enabled = false;
  edited.song = changed;
  const reference = new SongRenderer(changed);
  render(reference, 137);
  expect(render(edited, 512)).toEqual(render(reference, 512));
  required(patch.envelopes[1]).enabled = true;
  expect(render(edited, 512)).toEqual(render(reference, 512));
});

test("live pitch grouping follows reassignment, release and restart while paused", () => {
  const song = fixture();
  const first = required(song.channels[0]);
  const second = structuredClone(first);
  second.id = "second-live-track";
  second.instruments = [createInstrument("FM (n-op)")];
  song.channels.push(second);
  const renderer = new SongRenderer(song, 8000);
  renderer.playing = false;
  renderer.audition(first, 48);
  expect(render(renderer, 128).some((value) => Math.abs(value) > 1e-6)).toBe(true);
  renderer.audition(second, 48);
  renderer.muted = new Set([first.id]);
  expect(render(renderer, 128).some((value) => Math.abs(value) > 1e-6)).toBe(true);
  renderer.release(48);
  render(renderer, 8000);
  expect(render(renderer, 128).every((value) => value === 0)).toBe(true);
  renderer.releaseAll();
  renderer.reset();
  renderer.audition(second, 55);
  expect(render(renderer, 128).some((value) => Math.abs(value) > 1e-6)).toBe(true);
  renderer.releaseAll();
  expect(render(renderer, 128).every((value) => value === 0)).toBe(true);
});

test("prepared effect chains follow in-place controls, bypass, replacement and reordering", () => {
  const song = fixture();
  const instrument = createInstrument("Custom chip wave");
  const gain = createEffect("Gain");
  const delay = createEffect("Echo");
  delay.parameters["time"] = 0.01;
  instrument.effects = [gain, delay];
  required(song.channels[0]).instruments = [instrument];
  const edited = new SongRenderer(song, 8000);
  const reference = new SongRenderer(structuredClone(song), 8000);
  for (let frame = 0; frame < 1024; frame++) {
    if (frame === 128) {
      gain.parameters["gain"] = -3;
    } else if (frame === 256) {
      delay.enabled = false;
    } else if (frame === 384) {
      delay.enabled = true;
    } else if (frame === 512) {
      instrument.effects[1] = {
        ...delay,
        type: "Comb Filter",
        parameters: { time: 0.02, feedback: 20 },
      };
    } else if (frame === 640) {
      instrument.effects.reverse();
    } else if (frame === 768) {
      instrument.effects.splice(0, 1);
    } else if (frame === 896) {
      instrument.effects.push(createEffect("Bitcrusher"));
    }
    // Replacing the reference song invalidates its prepared chains while
    // retaining effect histories by ID, as an ordinary editor Change does.
    if (frame > 0 && frame % 128 === 0) {
      reference.song = structuredClone(song);
    }
    expect(edited.sample()).toEqual(reference.sample());
  }
});

test("restoring a previous effect chain respects bypass and renderer resets", () => {
  const song = fixture();
  const instrument = createInstrument("Custom chip wave");
  required(song.channels[0]).instruments = [instrument];
  const echo = createEffect("Echo");
  echo.parameters["time"] = 0.01;
  const originalEffects = [echo];
  instrument.effects = originalEffects;
  const edited = new SongRenderer(song, 8000);
  const reference = new SongRenderer(structuredClone(song), 8000);
  for (let frame = 0; frame < 768; frame++) {
    if (frame === 128) {
      instrument.effects = [{ ...echo, enabled: false }];
    } else if (frame === 256) {
      instrument.effects = originalEffects;
    } else if (frame === 384) {
      edited.reset();
      reference.reset();
    }
    if (frame === 128 || frame === 256) {
      reference.song = structuredClone(song);
    }
    expect(edited.sample()).toEqual(reference.sample());
  }
});

test("block rendering matches individual samples through loop boundaries and live controls", () => {
  const song = fixture();
  song.tempo = 300;
  song.beatsPerBar = 2;
  song.barCount = 2;
  song.loopEnd = 2;
  const channel = required(song.channels[0]);
  channel.cells = [1, 1];
  required(channel.patterns[1]).notes = [createNote(0, 1.8, [48, 52])];
  const instrument = createInstrument("Custom chip wave");
  const filter = createEffect("Low Pass");
  const phaser = createEffect("Phaser");
  const detune = createEffect("Detune");
  phaser.parameters["sync"] = "Cycles per beat";
  instrument.effects = [filter, phaser, createEffect("Echo"), detune];
  instrument.envelopes = [
    {
      ...createEnvelope(),
      type: "Twang",
      target: `effect:${filter.id}:frequency`,
      speed: 2,
    },
  ];
  channel.instruments = [instrument];
  const blocked = new SongRenderer(song, 8000);
  const reference = new SongRenderer(structuredClone(song), 8000);
  for (const [index, frames] of [1, 127, 1024, 8192, 32_768].entries()) {
    filter.parameters["frequency"] = 500 + index * 200;
    phaser.enabled = index !== 2;
    phaser.parameters["rate"] = 0.5 + index;
    detune.parameters["cents"] = 15 + index * 20;
    detune.enabled = index % 2 === 1;
    song.detune = index * 5;
    reference.song = structuredClone(song);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    blocked.process(left, right);
    const expectedLeft = new Float32Array(frames);
    const expectedRight = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      [expectedLeft[frame], expectedRight[frame]] = reference.sample();
    }
    expect(left).toEqual(expectedLeft);
    expect(right).toEqual(expectedRight);
    expect(blocked.bar).toBe(reference.bar);
    expect(blocked.beat).toBe(reference.beat);
  }
});

for (const type of ["chip wave", "harmonics", "pulse width"]) {
  test(`${type} edits to future notes preserve the current sound and effect tails`, () => {
    const song = fixture();
    const channel = required(song.channels[0]);
    const instrument = createInstrument(type);
    const echo = createEffect("Echo");
    echo.parameters["time"] = 0.05;
    instrument.effects = [echo, createEffect("Reverb")];
    channel.instruments = [instrument];
    required(channel.patterns[1]).notes = [createNote(0, 0.25, 48), createNote(2, 2.5, 55)];
    const control = new SongRenderer(song, 8000);
    const edited = new SongRenderer(song, 8000);
    render(control, 137);
    render(edited, 137);
    for (let iteration = 0; iteration < 6; iteration++) {
      edited.song = structuredClone(song);
      const patch = required(required(edited.song.channels[0]).instruments[0]);
      patch.name = `Renamed ${iteration}`;
      const { notes } = required(required(edited.song.channels[0]).patterns[1]);
      required(notes[1]).pitches = [60 + iteration];
      const actual = render(edited, 512);
      expect(actual).toEqual(render(control, 512));
      expect(actual.some((value) => Math.abs(value) > 1e-9)).toBe(true);
    }
    const future = render(edited, 4096);
    expect(future).not.toEqual(render(control, 4096));
    expect(future.some((value) => Math.abs(value) > 0.001)).toBe(true);
  });
}

test("native volume edits keep a sustained note's attack progress", () => {
  const song = fixture();
  const channel = required(song.channels[0]);
  const instrument = createInstrument("chip wave");
  instrument.attack = 0.5;
  instrument.volume = 0.8;
  channel.instruments = [instrument];
  required(channel.patterns[1]).notes = [createNote(0, 4, 48)];
  const renderer = new SongRenderer(song, 8000);
  render(renderer, 3200);
  const before = render(renderer, 512);
  renderer.song = structuredClone(song);
  required(required(renderer.song.channels[0]).instruments[0]).volume = 0.81;
  const after = render(renderer, 512);
  const energy = (samples: Float32Array): number =>
    samples.reduce((sum, sample) => sum + sample * sample, 0);
  expect(energy(after)).toBeGreaterThan(energy(before) * 0.5);
});

for (const tempo of [60, 300]) {
  test(`native tempo edits to ${tempo} BPM preserve fractional tick timing`, () => {
    const song = fixture();
    const channel = required(song.channels[0]);
    channel.instruments = [createInstrument("chip wave")];
    required(channel.patterns[1]).notes = [createNote(1, 1.5, 48)];
    const renderer = new SongRenderer(song, 8000);
    render(renderer, 137);
    const remainingBeats = 1 - renderer.beat;
    renderer.song = structuredClone(song);
    renderer.song.tempo = tempo;
    const samples = render(renderer, 10_000);
    const onset = samples.findIndex((value) => Math.abs(value) > 1e-6);
    expect(Math.abs(onset - (remainingBeats * 60 * 8000) / tempo)).toBeLessThanOrEqual(1);
  });
}

for (const type of ["Custom chip wave", "FM (n-op)"]) {
  for (const transition of ["normal", "continue"]) {
    test(`${type} ${transition} tied notes preserve voices and envelopes through song edits`, () => {
      const song = fixture();
      song.beatsPerBar = 1;
      song.barCount = 2;
      song.loopEnd = 2;
      const channel = required(song.channels[0]);
      channel.cells = [1, 2];
      const instrument = createInstrument(type);
      instrument.attack = 0.5;
      instrument.transition = transition;
      instrument.envelopes = [
        { ...createEnvelope(), type: "Decay", target: "volume", timeBasis: "beats", speed: 0.3 },
      ];
      channel.instruments = [instrument];
      required(channel.patterns[1]).notes = [createNote(0, 1, [48, 52])];
      const continued = createNote(0, 1, [48, 52]);
      continued.continues = true;
      required(channel.patterns[2]).notes = [continued];
      const control = new SongRenderer(song, 8000);
      const edited = new SongRenderer(song, 8000);
      render(control, 4337);
      render(edited, 4337);
      expect(edited.bar).toBe(1);
      for (let iteration = 0; iteration < 3; iteration++) {
        edited.song = structuredClone(song);
        edited.song.title = `Renamed ${iteration}`;
        expect(render(edited, 512)).toEqual(render(control, 512));
      }
    });
  }
}
