import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import { AudioThreadPool } from "../../src/audio-thread-pool";
import { createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";

for (const planned of [false, true]) {
  for (const [before, type] of [
    ["Custom chip wave", "FM (n-op)"],
    ["Custom chip wave", "chip wave"],
    ["chip wave", "pulse width"],
    ["pulse width", "harmonics"],
  ] as const) {
    test(`switching ${before} to ${type} preserves next-bar note timing (${planned ? "planned" : "scalar"})`, async () => {
      const song = createSong();
      song.tempo = 120;
      song.beatsPerBar = 4;
      song.barCount = 2;
      song.loopEnd = 2;
      const track = required(song.channels[0]);
      song.channels = [track];
      track.cells = [1, 2];
      track.instruments = [createInstrument(before)];
      required(track.patterns[1]).notes = [createNote(0, 0.25, 48)];
      required(track.patterns[2]).notes = [createNote(0.25, 0.5, 72)];
      const automation = createChannel("automation", 2, song.patternCount);
      automation.cells = [1, 0];
      required(automation.patterns[1]).lanes = [
        {
          id: "jump",
          target: "nextBar",
          enabled: true,
          interpolation: "hold",
          points: [{ time: 0.5, value: 1 }],
        },
      ];
      song.channels.push(automation);
      const renderer = new SongRenderer(
        song,
        8000,
        0,
        undefined,
        planned ? { channelIds: new Set() } : {},
      );
      const pool = planned
        ? new AudioThreadPool({
            song,
            sampleRate: 8000,
            bar: 0,
            beat: 0,
            playing: true,
            recording: false,
            muted: [],
            threadCount: 1,
          })
        : null;
      const render = async (frames: number): Promise<Float32Array> => {
        if (pool) {
          return (await pool.renderBlock(renderer, frames)).left;
        }
        const left = new Float32Array(frames);
        renderer.process(left, new Float32Array(frames));
        return left;
      };
      try {
        await render(400);
        const changed = structuredClone(song);
        const instrument = required(track.instruments[0]);
        required(changed.channels[0]).instruments = [
          { ...createInstrument(type), id: instrument.id, release: 0 },
        ];
        pool?.update({ type: "song", song: changed }, renderer.transportClock);
        renderer.song = changed;
        await render(2100);
        expect(renderer.bar).toBe(1);
        expect(renderer.beat).toBeCloseTo(0.125, 2);
        const samples = await render(1600);
        const onset = samples.findIndex((sample) => Math.abs(sample) > 1e-6);
        expect(onset).toBeGreaterThanOrEqual(495);
        expect(onset).toBeLessThan(510);
        expect(samples.subarray(1000, 1400).some((sample) => Math.abs(sample) > 0.001)).toBe(true);
      } finally {
        pool?.close();
        renderer.reset();
      }
    });
  }

  for (const sequence of [undefined, [1, 0, 1]]) {
    test(`native next-bar jumps follow ${sequence ? "finite reordered sequences" : "repeated single-bar loops"} (${planned ? "planned" : "scalar"})`, () => {
      const song = createSong();
      song.tempo = 120;
      song.beatsPerBar = 4;
      song.barCount = 2;
      song.loopEnd = 1;
      const track = required(song.channels[0]);
      song.channels = [track];
      track.cells = [1, 2];
      track.instruments = [{ ...createInstrument("chip wave"), release: 0 }];
      required(track.patterns[1]).notes = [createNote(0, 0.125, 48)];
      required(track.patterns[2]).notes = [createNote(0.25, 0.375, 72)];
      const automation = createChannel("automation", 2, song.patternCount);
      automation.cells = [1, 1];
      required(automation.patterns[1]).lanes = [
        {
          id: "jump",
          target: "nextBar",
          enabled: true,
          interpolation: "hold",
          points: [{ time: 0.5, value: 1 }],
        },
      ];
      song.channels.push(automation);
      const clock = new SongRenderer(song, 8000, 0, sequence, { channelIds: new Set() });
      const renderer = new SongRenderer(song, 8000, 0, sequence, { master: false });
      const visits = new Map<number, { peak: number; rest: number }>();
      try {
        for (const frames of [2002, 4096, 1024]) {
          const plan = clock.preparePlan(frames, true);
          const left = new Float32Array(plan.frames.length);
          renderer.process(left, new Float32Array(left.length), planned ? plan : undefined);
          for (const [index, frame] of plan.frames.entries()) {
            const visit = visits.get(frame.barVisit) ?? { peak: 0, rest: 0 };
            visits.set(frame.barVisit, visit);
            const noteStart = frame.bar === 0 ? 0 : 0.25;
            const level = Math.abs(required(left[index]));
            if (frame.beat >= noteStart + 0.025 && frame.beat < noteStart + 0.075) {
              visit.peak = Math.max(visit.peak, level);
            }
            if (frame.beat >= 0.425 && frame.beat < 0.475) {
              visit.rest = Math.max(visit.rest, level);
            }
          }
          expect(renderer.bar).toBe(clock.bar);
          expect(renderer.beat).toBe(clock.beat);
          expect(renderer.playing).toBe(clock.playing);
        }
        expect(visits.size).toBe(sequence?.length ?? 4);
        for (const visit of visits.values()) {
          expect(visit.peak).toBeGreaterThan(0.001);
          expect(visit.rest).toBeLessThan(1e-6);
        }
      } finally {
        renderer.reset();
        clock.reset();
      }
    });
  }
}
