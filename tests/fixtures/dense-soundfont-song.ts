import { createInstrument } from "../../src/instruments";
import { createChannel, createNote, createSong, required } from "../../src/model";
import type { Song } from "../../src/model";

// Two patches per track, three-note chords and overlapping releases exercise
// polyphony, voice startup and worker stem traffic together.
export const denseSoundFontSong = (tracks = 32): Song => {
  const song = createSong();
  song.beatsPerBar = 8;
  song.loopEnd = 1;
  song.resources = [{ id: "dense-font", url: "./test-assets/dense.sf2" }];
  song.channels = Array.from({ length: tracks }, (_unused, index) => {
    const channel = createChannel("track", song.barCount, song.patternCount);
    channel.cells.fill(1);
    channel.instruments = [19, 90].map((program) => {
      const instrument = createInstrument("SoundFont");
      instrument.resourceId = "dense-font";
      instrument.program = program;
      instrument.attack = 0;
      instrument.release = 0.3;
      instrument.volume = 0.03;
      return instrument;
    });
    const root = 48 + (index % 12);
    required(channel.patterns[1]).notes = Array.from({ length: song.beatsPerBar }, (_, beat) =>
      createNote(beat, beat + 1, [root + (beat % 2), root + 4, root + 7]),
    );
    return channel;
  });
  return song;
};
