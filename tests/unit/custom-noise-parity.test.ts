import { expect, test } from "bun:test";

import { SongRenderer } from "../../src/audio";
import { createInstrument } from "../../src/instruments";
import { createNote, createSong, required } from "../../src/model";
import { resetSynthNoiseTables } from "../../src/synth/runtime";
import reference from "../fixtures/ultrabox-custom-noise.json";

// These fixtures capture UltraBox's basic noise instruments before master
// processing, with the same RNG and controls.
for (const fixture of reference.cases) {
  test(`custom ${fixture.noise} matches UltraBox: ${fixture.scenario}, ${fixture.sampleRate} Hz`, () => {
    const song = createSong();
    song.volume = 100;
    song.tempo = 150;
    song.key = fixture.key;
    song.barCount = 1;
    song.loopEnd = 1;
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    channel.cells = [1];
    const instrument = createInstrument("basic noise");
    Object.assign(instrument, {
      noise: fixture.noise,
      volume: fixture.volume,
      attack: fixture.attack,
      release: fixture.release,
    });
    expect(instrument.preset).toBe("");
    channel.instruments = [instrument];
    required(channel.patterns[1]).notes = fixture.notes.map((note) => {
      const first = required(note.points[0]);
      const last = required(note.points.at(-1));
      const result = createNote(first.tick / 24, last.tick / 24, note.pitches);
      result.pins = note.points.map((point) => ({
        time: (point.tick - first.tick) / 24,
        interval: point.pitchBend,
        volume: (point.volume / 100) * 3,
      }));
      return result;
    });
    const { random } = Math;
    try {
      resetSynthNoiseTables();
      let { seed } = fixture;
      Math.random = (): number => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 4_294_967_296;
      };
      const renderer = new SongRenderer(song, fixture.sampleRate);
      if (fixture.mode === "audition") {
        renderer.playing = false;
        renderer.audition(channel, 48);
      }
      const left = new Float32Array(Math.round(fixture.seconds * fixture.sampleRate));
      const right = new Float32Array(left.length);
      for (let frame = 0; frame < left.length; frame++) {
        if (fixture.mode === "audition" && frame === Math.round(fixture.sampleRate * 0.2)) {
          renderer.release(48);
        }
        [left[frame], right[frame]] = renderer.sample();
      }
      const rms = Math.sqrt(left.reduce((sum, sample) => sum + sample * sample, 0) / left.length);
      expect(rms, "absolute loudness must match").toBe(fixture.rms);
      const hash = new Bun.CryptoHasher("sha256")
        .update(new Uint8Array(left.buffer))
        .update(new Uint8Array(right.buffer))
        .digest("hex");
      expect(hash, "every stereo sample must match without normalization").toBe(fixture.hash);
    } finally {
      Math.random = random;
      resetSynthNoiseTables();
    }
  });
}
