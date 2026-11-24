// Seed song identities before loading storage, which constructs a default song.
const createProfilePlaybackSong = async (): Promise<string> => {
  const { now } = Date;
  const { random } = Math;
  let seed = 602_319;
  try {
    Object.assign(Date, { now: (): number => 1_763_510_000_000 });
    Object.assign(Math, {
      random: (): number => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 4_294_967_296;
      },
    });
    const { createEffect, createEnvelope, createInstrument, presetInstrument } =
      await import("../src/instruments");
    const { createChannel, createNote, createSong, required } = await import("../src/model");
    const { encodeSong } = await import("../src/storage");
    const song = createSong();
    song.title = "Polyphonic playback profile";
    song.tempo = 144;
    song.beatsPerBar = 4;
    song.barCount = 4;
    song.patternCount = 4;
    song.loopEnd = 4;
    song.volume = 75;
    const nativePatches = [
      "square lead",
      "electric piano 1",
      "harpsichord",
      "warm pad",
      "PWM overdrive",
    ];
    const roots = [0, 5, 3, 7];
    song.channels = Array.from({ length: 30 }, (_, track) => {
      const channel = createChannel("track", song.barCount, song.patternCount);
      channel.name = `Profile Track ${track + 1}`;
      const family = (track + Math.floor(track / 15)) % 3;
      const instrumentType = family === 0 ? "Custom chip wave" : "FM (n-op)";
      const instrument =
        family === 1
          ? presetInstrument(required(nativePatches[track % nativePatches.length]))
          : createInstrument(instrumentType);
      instrument.volume = 0.035 + (track % 5) * 0.004;
      instrument.chords = "simultaneous";
      if (family === 2) {
        instrument.release = 0.18;
        instrument.operators.forEach((operator, index) => {
          operator.stereoDetune = index * 3 + (track % 5);
          operator.offset = index * 2 + (track % 3);
        });
        instrument.envelopes.push({
          ...createEnvelope(),
          target: `operator:${required(instrument.operators[1]).id}:offset`,
          type: "Flare",
          a: 0.2,
          b: 0.8,
        });
      }
      if (track % 7 === 0) {
        instrument.effects.push(createEffect("Chorus"));
      }
      channel.instruments = [instrument];
      channel.cells = [1, 2, 3, 4];
      const offset = (track % 5) / 24;
      for (const [bar, root] of roots.entries()) {
        const pitch = 29 + ((track * 7) % 22) + root;
        const chords = bar % 2 === 0 ? [0, 3, 7, 12] : [0, 4, 7, 12];
        required(channel.patterns[bar + 1]).notes = [
          createNote(
            offset,
            2 + offset - 1 / 24,
            chords.map((interval) => pitch + interval),
          ),
          createNote(
            2 + offset,
            4,
            chords.map((interval) => pitch + interval + 2),
          ),
        ];
      }
      return channel;
    });
    return encodeSong(song);
  } finally {
    Object.assign(Date, { now });
    Object.assign(Math, { random });
  }
};

// Generate once so the fixture can be reused for both browser builds.
let songHash: Promise<string> | null = null;

export const profilePlaybackSong = async (): Promise<string> => {
  songHash ??= createProfilePlaybackSong();
  return await songHash;
};
