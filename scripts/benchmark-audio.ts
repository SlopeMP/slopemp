import { registerSoundFont, SongRenderer } from "../src/audio";
import { createEnvelope, createInstrument } from "../src/instruments";
import { createChannel, createNote, createSong, required } from "../src/model";

// Repeated chords leave many overlapping voices when fade-out is long.
// Report elapsed time rather than asserting machine-dependent timing in tests.
const sampleRate = 44_100;
const seconds = Number(process.env["SLOPEMP_BENCH_SECONDS"] ?? 2);
registerSoundFont(
  "benchmark-font",
  await Bun.file(new URL("../tests/assets/florestan-subset.sf2", import.meta.url)).arrayBuffer(),
);
for (const channels of [1, 3]) {
  const song = createSong();
  song.channels = song.channels.slice(0, channels);
  for (const channel of song.channels) {
    const instrument = createInstrument("SoundFont");
    instrument.resourceId = "benchmark-font";
    instrument.program = 2;
    instrument.attack = 0;
    instrument.release = 8;
    channel.instruments = [instrument];
    channel.cells.fill(1, 0, 4);
    required(channel.patterns[1]).notes = Array.from({ length: 16 }, (_, index) =>
      createNote(index / 4, index / 4 + 1 / 8, [
        48 + (index % 4),
        52 + (index % 4),
        55 + (index % 4),
      ]),
    );
  }
  const renderer = new SongRenderer(song, sampleRate);
  const started = performance.now();
  let peak = 0;
  for (let frame = 0; frame < sampleRate * seconds; frame++) {
    const pair = renderer.sample();
    peak = Math.max(peak, Math.abs(pair[0]), Math.abs(pair[1]));
  }
  const result = { channels, seconds, elapsedMs: Math.round(performance.now() - started), peak };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// FM control evaluation grows with every overlapping tail. Keep envelopes and
// different stereo waveforms active so this covers more than a bare sine patch.
for (const release of [0, 2, 8]) {
  const song = createSong();
  song.channels = song.channels.slice(0, 1);
  const channel = required(song.channels[0]);
  const instrument = createInstrument("FM (n-op)");
  instrument.attack = 0;
  instrument.release = release;
  instrument.operators.forEach((operator, index) => {
    operator.wave = ["sawtooth", "white noise", "quasi-sine", "pulse width"][index] ?? "sine";
    operator.offset = index * 7;
    operator.stereoDetune = (index - 1) * 9;
    operator.stereoPhase = index * 25;
    instrument.envelopes.push({
      ...createEnvelope(),
      target: `operator:${operator.id}:offset`,
      type: "Flare",
      speed: 2 + index,
      a: 0.2,
      b: 0.8,
    });
  });
  channel.instruments = [instrument];
  channel.cells.fill(1, 0, 4);
  required(channel.patterns[1]).notes = Array.from({ length: song.beatsPerBar * 4 }, (_, index) =>
    createNote(index / 4, index / 4 + 1 / 8, [48 + (index % 5), 55 + (index % 5)]),
  );
  const renderer = new SongRenderer(song, sampleRate);
  const started = performance.now();
  let peak = 0;
  for (let frame = 0; frame < sampleRate * seconds; frame++) {
    const [left, right] = renderer.sample();
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
  }
  process.stdout.write(
    `${JSON.stringify({ type: "FM (n-op)", release, seconds, elapsedMs: Math.round(performance.now() - started), peak })}\n`,
  );
}

// Sparse sessions should scale with channels that produce sound, not blank rows.
for (const { channels, automations } of [
  { channels: 1, automations: 0 },
  { channels: 100, automations: 0 },
  { channels: 100, automations: 99 },
]) {
  const song = createSong();
  song.channels = Array.from({ length: channels }, (_, index) => {
    const channel = createChannel(index > 0 && index <= automations ? "automation" : "track");
    if (channel.kind === "automation") {
      channel.cells.fill(1, 0, 4);
      required(channel.patterns[1]).lanes = [
        {
          id: `volume-${index}`,
          target: "volume",
          enabled: true,
          interpolation: "linear",
          points: Array.from({ length: 16 }, (_unused, point) => ({
            time: (15 - point) / 2,
            value: 80,
          })),
        },
      ];
    } else {
      channel.instruments = [createInstrument("FM (n-op)")];
    }
    return channel;
  });
  const active = required(song.channels[0]);
  active.cells.fill(1);
  required(active.patterns[1]).notes = [createNote(0, song.beatsPerBar, [48, 52, 55])];
  const renderer = new SongRenderer(song, sampleRate);
  const started = performance.now();
  let peak = 0;
  for (let frame = 0; frame < sampleRate * seconds; frame++) {
    const [left, right] = renderer.sample();
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
  }
  process.stdout.write(
    `${JSON.stringify({ channels, active: 1, automations, seconds, elapsedMs: Math.round(performance.now() - started), peak })}\n`,
  );
}
