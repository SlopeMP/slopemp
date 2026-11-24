import { expect, test } from "bun:test";

import { prepareEffectProcessor, processEffect, SongRenderer } from "../../src/audio";
import { createEffect, createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";

type Stereo = [number, number];
const delayTypes = ["Echo", "Ping Pong Delay", "Multitap Delay"];
const sampleRate = 1000;

for (const type of delayTypes) {
  for (const bound of [false, true]) {
    const mode = bound ? "prepared" : "public";
    const fixture = (): {
      effect: ReturnType<typeof createEffect>;
      sample: (frame: number, tempo: number, overrides?: Record<string, number>) => Stereo;
    } => {
      const effect = createEffect(type);
      Object.assign(effect.parameters, { feedback: 0, taps: 1, time: 0.5 });
      const render = prepareEffectProcessor(effect, sampleRate);
      return {
        effect,
        sample: (frame, tempo, overrides): Stereo => {
          const input: Stereo = frame === 0 ? [1, 0] : [0, 0];
          return bound
            ? render(input, frame / sampleRate, overrides, tempo)
            : processEffect(input, effect, sampleRate, frame / sampleRate, overrides, tempo);
        },
      };
    };
    const expectImpulse = (sample: (frame: number) => Stereo, delayedFrame: number): void => {
      const echoes: Array<{ frame: number; pair: Stereo }> = [];
      for (let frame = 0; frame <= delayedFrame + 20; frame++) {
        const pair = sample(frame);
        if (frame === 0) {
          expect(pair).toEqual([1, 0]);
        } else if (pair[0] !== 0 || pair[1] !== 0) {
          echoes.push({ frame, pair: [...pair] });
        }
      }
      expect(echoes).toEqual([
        { frame: delayedFrame, pair: type === "Ping Pong Delay" ? [0, 1] : [1, 0] },
      ]);
    };

    for (const tempo of [60, 120, 240]) {
      test(`${type} ${mode} seconds remain fixed at ${tempo} BPM`, () => {
        const { sample } = fixture();
        expectImpulse((frame) => sample(frame, tempo), 500);
      });
      test(`${type} ${mode} beats follow ${tempo} BPM`, () => {
        const { effect, sample } = fixture();
        effect.parameters["timeBasis"] = "Beats";
        expectImpulse((frame) => sample(frame, tempo), (sampleRate * 30) / tempo);
      });
    }
    test(`${type} ${mode} tempo edits retime the existing delay history`, () => {
      const { effect, sample } = fixture();
      effect.parameters["timeBasis"] = "Beats";
      expectImpulse((frame) => sample(frame, frame < 100 ? 60 : 120), 250);
    });
    test(`${type} ${mode} switching timing retimes the existing delay history`, () => {
      const { effect, sample } = fixture();
      expectImpulse((frame) => {
        if (frame === 100) {
          effect.parameters["timeBasis"] = "Beats";
        }
        return sample(frame, 120);
      }, 250);
    });
    test(`${type} ${mode} time overrides use the selected beat timing`, () => {
      const { effect, sample } = fixture();
      Object.assign(effect.parameters, { time: 1, timeBasis: "Beats" });
      expectImpulse((frame) => sample(frame, 120, { time: 0.5 }), 250);
    });
    test(`${type} ${mode} supports four beats at the slowest song tempo`, () => {
      const { effect, sample } = fixture();
      Object.assign(effect.parameters, { time: 4, timeBasis: "Beats" });
      expectImpulse((frame) => sample(frame, 30), 8000);
    });
  }

  for (const instrumentType of ["chip wave", "FM (n-op)"]) {
    for (const placement of ["instrument", "channel"] as const) {
      test(`${type} ${instrumentType} ${placement} timing follows automated song tempo`, () => {
        const song = createSong();
        song.tempo = 150;
        song.channels = song.channels.slice(0, 1);
        const channel = required(song.channels[0]);
        channel.cells.fill(1);
        const instrument = createInstrument(instrumentType);
        instrument.volume = 0.1;
        channel.instruments = [instrument];
        required(channel.patterns[1]).notes = [createNote(0, 1, 48)];
        const effect = createEffect(type);
        Object.assign(effect.parameters, { time: 0.5, timeBasis: "Beats", feedback: 0 });
        (placement === "instrument" ? instrument : channel).effects = [effect];
        const tempo = createChannel("automation", song.barCount, song.patternCount);
        tempo.target = { kind: "song" };
        tempo.cells.fill(1);
        required(tempo.patterns[1]).lanes = [
          {
            id: "delay-tempo",
            target: "tempo",
            enabled: true,
            interpolation: "hold",
            points: [
              { time: 0, value: 120 },
              { time: 4, value: 120 },
            ],
          },
        ];
        song.channels.push(tempo);
        const reference = structuredClone(song);
        const referenceChannel = required(reference.channels[0]);
        const referenceEffects =
          placement === "instrument"
            ? required(referenceChannel.instruments[0]).effects
            : referenceChannel.effects;
        Object.assign(required(referenceEffects[0]).parameters, {
          time: 0.25,
          timeBasis: "Seconds",
        });
        const actual = new SongRenderer(song, 8000);
        const expected = new SongRenderer(reference, 8000);
        const left = new Float32Array(4000);
        const right = new Float32Array(4000);
        const referenceLeft = new Float32Array(4000);
        const referenceRight = new Float32Array(4000);
        actual.process(left, right);
        expected.process(referenceLeft, referenceRight);
        expect(left.some((value) => value !== 0)).toBe(true);
        expect(left).toEqual(referenceLeft);
        expect(right).toEqual(referenceRight);
      });
    }
  }
}

for (const bound of [false, true]) {
  test(`Multitap Delay ${bound ? "prepared" : "public"} keeps all eight slow beat taps in order`, () => {
    const effect = createEffect("Multitap Delay");
    Object.assign(effect.parameters, { feedback: 0, time: 4, timeBasis: "Beats", taps: 8 });
    const rate = 100;
    const render = prepareEffectProcessor(effect, rate);
    const echoes: Array<{ frame: number; pair: Stereo }> = [];
    for (let frame = 1; frame <= 6400; frame++) {
      if (frame === 1) {
        if (bound) {
          render([1, 0], 0, undefined, 30);
        } else {
          processEffect([1, 0], effect, rate, 0, undefined, 30);
        }
      }
      const pair = bound
        ? render([0, 0], frame / rate, undefined, 30)
        : processEffect([0, 0], effect, rate, frame / rate, undefined, 30);
      if (pair[0] !== 0 || pair[1] !== 0) {
        echoes.push({ frame, pair: [...pair] });
      }
    }
    expect(echoes).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        frame: (index + 1) * 800,
        pair: [1 / (index + 1), 0],
      })),
    );
  });
}
