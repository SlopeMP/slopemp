import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import { AudioThreadPool } from "../../src/audio-thread-pool";
import { createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";

for (const planned of [false, true]) {
  for (const type of ["FM (n-op)", "chip wave", "pulse width", "harmonics"]) {
    test(`${type} follows next-bar note timing after an instrument switch (${planned ? "planned" : "scalar"})`, async () => {
      const song = createSong();
      song.tempo = 120;
      song.beatsPerBar = 4;
      song.barCount = 2;
      song.loopEnd = 2;
      const track = required(song.channels[0]);
      song.channels = [track];
      track.cells = [1, 2];
      track.instruments = [createInstrument("Custom chip wave")];
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
      const pool = new AudioThreadPool({
        song,
        sampleRate: 8000,
        bar: 0,
        beat: 0,
        playing: true,
        recording: false,
        muted: [],
        threadCount: 1,
      });
      const render = async (frames: number): Promise<Float32Array> => {
        if (planned) {
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
        pool.update({ type: "song", song: changed }, renderer.transportClock);
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
        pool.close();
        renderer.reset();
      }
    });
  }
}
