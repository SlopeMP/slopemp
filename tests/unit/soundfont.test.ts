import { describe, expect, test } from "bun:test";

import type { Stereo } from "../../src/audio";
import {
  getAudioResourceInfo,
  hasAudioResource,
  installAudioResourceAlias,
  registerAudioResource,
  registerSoundFont,
  removeAudioResource,
  snapshotAudioResources,
  SongRenderer,
} from "../../src/audio";
import { createInstrument } from "../../src/instruments";
import type { Song } from "../../src/model";
import { createNote, createSong, required } from "../../src/model";
import { decodeSoundFont, loadSoundFont } from "../../src/soundfont-loader";
import {
  applySFModulators,
  defaultSFControllers,
  mergeSFModulators,
  preparedSFEnvelopeValue,
  prepareSFEnvelope,
  SF2_DEFAULT_GENERATORS,
  sfModulatorSource,
  timecentsToSeconds,
} from "../../src/synth/soundfont";
import { parseSoundFont } from "../../src/synth/soundfont-file";
const tinyFont = (
  stereo = true,
  presetGenerators: ReadonlyArray<readonly [number, number]> = [],
  attenuationModulator = 0,
): ArrayBuffer => {
  const le = (value: number, size = 2): number[] =>
    Array.from({ length: size }, (_, i): number => (value >>> (i * 8)) & 255);
  const ascii = (name: string, length = name.length): number[] =>
    Array.from({ length }, (_, i): number => name.codePointAt(i) ?? 0);
  const chunk = (name: string, bytes: number[]): number[] => [
    ...ascii(name),
    ...le(bytes.length, 4),
    ...bytes,
    ...(bytes.length % 2 ? [0] : []),
  ];
  const list = (name: string, chunks: number[][]): number[] =>
    chunk("LIST", [...ascii(name), ...chunks.flat()]);
  const record = (name: string, program: number, bank: number, bag: number): number[] => [
    ...ascii(name, 20),
    ...le(program),
    ...le(bank),
    ...le(bag),
    ...Array.from({ length: 12 }, (): number => 0),
  ];
  const header = (
    name: string,
    start: number,
    end: number,
    loopStart: number,
    loopEnd: number,
    rate: number,
    root: number,
    link: number,
    type: number,
  ): number[] => [
    ...ascii(name, 20),
    ...le(start, 4),
    ...le(end, 4),
    ...le(loopStart, 4),
    ...le(loopEnd, 4),
    ...le(rate, 4),
    root,
    0,
    ...le(link),
    ...le(type),
  ];
  const samples = Array.from({ length: 1024 }, (_, i): number =>
    Math.round(Math.sin((i * 2 * Math.PI) / 32) * 24_000),
  ).flatMap((value) => le(value));
  const preset = [...record("Test Stereo", 0, 0, 0), ...record("EOP", 0, 0, 1)];
  const pdta = list("pdta", [
    chunk("phdr", preset),
    chunk("pbag", [...le(0), ...le(0), ...le(presetGenerators.length + 1), ...le(1)]),
    chunk("pmod", [
      ...le(0),
      ...le(48),
      ...le(attenuationModulator),
      ...le(0),
      ...le(0),
      ...Array.from({ length: 10 }, (): number => 0),
    ]),
    chunk("pgen", [
      ...presetGenerators.flatMap(([key, value]) => [...le(key), ...le(value)]),
      ...le(41),
      ...le(0),
    ]),
    chunk("inst", [...ascii("Instrument", 20), ...le(0), ...ascii("EOI", 20), ...le(1)]),
    chunk("ibag", [...le(0), ...le(0), ...le(6), ...le(1)]),
    chunk("imod", [
      ...le(3),
      ...le(17),
      ...le(500),
      ...le(0),
      ...le(0),
      ...Array.from({ length: 10 }, (): number => 0),
    ]),
    chunk(
      "igen",
      [
        [33, -32_768],
        [34, -32_768],
        [54, 1],
        [58, 60],
        [16, 0],
        [53, 0],
      ].flatMap(([key, value]): number[] => [...le(required(key)), ...le(required(value))]),
    ),
    chunk("shdr", [
      ...header("Left", 0, 512, 0, 512, 8000, 60, 1, stereo ? 4 : 1),
      ...header("Right", 512, 1024, 512, 1024, 8000, 60, 0, 2),
      ...header("EOS", 1024, 1024, 1024, 1024, 8000, 60, 0, 1),
    ]),
  ]);
  const data = [...ascii("sfbk"), ...list("sdta", [chunk("smpl", samples)]), ...pdta];
  return Uint8Array.from(chunk("RIFF", data)).buffer;
};
describe("native SoundFont envelopes and modulators", (): void => {
  test("timecents preserve native units and zero-time sentinel", (): void => {
    expect(timecentsToSeconds(-32_768)).toBe(0);
    expect(timecentsToSeconds(0)).toBe(1);
    expect(timecentsToSeconds(1200)).toBe(2);
    expect(timecentsToSeconds(-1200)).toBe(0.5);
  });
  test("all source curve, polarity and direction combinations are bounded", (): void => {
    for (let curve = 0; curve < 4; curve++) {
      for (let direction = 0; direction < 2; direction++) {
        for (let polarity = 0; polarity < 2; polarity++) {
          for (const key of [0, 32, 64, 96, 127]) {
            const source = 3 | (curve << 10) | (direction << 8) | (polarity << 9);
            const value = sfModulatorSource(source, defaultSFControllers(key));
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(polarity ? -1 : 0);
            expect(value).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
  test("amount source and absolute transform work without flattening routes", (): void => {
    const state = defaultSFControllers(127, 127);
    const base = new Map([[48, 0]]);
    const result = applySFModulators(
      base,
      [{ source: 3, destination: 48, amount: -10, amountSource: 2, transform: 2 }],
      state,
    );
    expect(result.get(48)).toBe(10);
    expect(base.get(48)).toBe(0);
    expect(
      mergeSFModulators(
        [{ source: 3, destination: 48, amount: 10, amountSource: 0, transform: 0 }],
        [{ source: 3, destination: 48, amount: 0, amountSource: 0, transform: 0 }],
      ),
    ).toHaveLength(1);
  });
  test("volume and modulation sustain retain different native units", (): void => {
    const g = new Map(SF2_DEFAULT_GENERATORS);
    for (const id of [25, 26, 27, 28, 33, 34, 35, 36]) {
      g.set(id, -32_768);
    }
    g.set(29, 500);
    g.set(37, 60);
    expect(preparedSFEnvelopeValue(prepareSFEnvelope(g, 60, false), 2)).toBe(0.5);
    expect(preparedSFEnvelopeValue(prepareSFEnvelope(g, 60, true), 2)).toBeCloseTo(
      10 ** (-60 / 200),
    );
  });
  test("key-scaled hold timing and releases begin from their current level", (): void => {
    const g = new Map(SF2_DEFAULT_GENERATORS);
    g.set(25, -32_768);
    g.set(26, 0);
    g.set(27, 0);
    g.set(31, 1200);
    g.set(30, 0);
    expect(preparedSFEnvelopeValue(prepareSFEnvelope(g, 60, false), 0.25, 0.25)).toBeCloseTo(0.25);
    expect(preparedSFEnvelopeValue(prepareSFEnvelope(g, 60, false), 0.75, 0.25)).toBeCloseTo(0.125);
    expect(preparedSFEnvelopeValue(prepareSFEnvelope(g, 61, false), 1.5)).toBe(1);
  });
  test("prepared envelopes preserve native stages and release from an interrupted attack", (): void => {
    const g = new Map(SF2_DEFAULT_GENERATORS);
    for (const base of [25, 33]) {
      g.set(base, -2400);
      g.set(base + 1, -1200);
      g.set(base + 2, -1200);
      g.set(base + 3, 1200);
      g.set(base + 4, base === 33 ? 200 : 750);
      g.set(base + 5, 0);
    }
    const volume = prepareSFEnvelope(g, 60, true);
    const modulation = prepareSFEnvelope(g, 60, false);
    expect(volume.release).toBe(1);
    expect(preparedSFEnvelopeValue(volume, 0.125)).toBe(0);
    expect(preparedSFEnvelopeValue(volume, 0.5)).toBe(0.5);
    expect(preparedSFEnvelopeValue(volume, 1)).toBe(1);
    expect(preparedSFEnvelopeValue(volume, 2.25)).toBeCloseTo(10 ** -0.5, 12);
    expect(preparedSFEnvelopeValue(modulation, 2.25)).toBe(0.625);
    expect(preparedSFEnvelopeValue(volume, 4)).toBeCloseTo(0.1, 12);
    expect(preparedSFEnvelopeValue(modulation, 4)).toBe(0.25);
    expect(preparedSFEnvelopeValue(volume, 1, 0.5)).toBeCloseTo(0.5 * 10 ** -2.5, 12);
    expect(preparedSFEnvelopeValue(modulation, 1, 0.5)).toBe(0.25);
    expect(preparedSFEnvelopeValue(volume, 1.5, 0.5)).toBe(0);
    expect(preparedSFEnvelopeValue(modulation, 1.5, 0.5)).toBe(0);
    g.set(34, 8000);
    g.set(38, 8000);
    expect(preparedSFEnvelopeValue(volume, 0.5)).toBe(0.5);
    expect(preparedSFEnvelopeValue(volume, 1.5, 0.5)).toBe(0);
  });
});
describe("SoundFont import and rendering", (): void => {
  test("valid RIFF preserves preset identities, native values and modulator source precision", (): void => {
    const data = tinyFont();
    const presets = registerSoundFont("fixture", data);
    expect(presets).toEqual([{ name: "Test Stereo", bank: 0, program: 0 }]);
    const zone = required(required(parseSoundFont(data).presets[0]).zones[0]);
    expect(zone.generators.get(33)).toBe(-32_768);
    expect(
      zone.modulators.some(
        (item) => item.source === 3 && item.destination === 17 && item.amount === 500,
      ),
    ).toBe(true);
  });
  test("native zones render stereo and balance initial attenuation with preset effects disabled", (): void => {
    registerSoundFont("fixture", tinyFont());
    registerSoundFont("fixture-negative-attenuation", tinyFont(true, [[48, -419]]));
    registerSoundFont("fixture-positive-attenuation", tinyFont(true, [[48, 271]]));
    registerSoundFont("fixture-modulated-attenuation", tinyFont(true, [[48, 271]], 100));
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    required(song.channels[0]).cells[0] = 1;
    required(required(song.channels[0]).patterns[1]).notes = [createNote(0, 1, 48)];
    const instrument = createInstrument("SoundFont");
    instrument.attack = 0;
    instrument.presetEffects = false;
    required(song.channels[0]).instruments = [instrument];
    const render = (resourceId: string): Stereo[] => {
      instrument.resourceId = resourceId;
      const renderer = new SongRenderer(song, 8000);
      return Array.from({ length: 400 }, (): Stereo => renderer.sample());
    };
    const samples = render("fixture");
    expect(samples.some((pair) => Math.abs(pair[0]) + Math.abs(pair[1]) > 0.001)).toBe(true);
    expect(samples.some(([left, right]) => Math.abs(left - right) > 0.001)).toBe(true);
    expect(samples.every((pair) => pair.every(Number.isFinite))).toBe(true);
    expect(render("fixture-negative-attenuation")).toEqual(samples);
    const peak = (output: Stereo[]): number => Math.max(...output.flat().map(Math.abs));
    const positive = peak(render("fixture-positive-attenuation"));
    expect(positive / peak(samples)).toBeCloseTo(10 ** ((-271 * 0.4) / 200), 6);
    expect(peak(render("fixture-modulated-attenuation")) / positive).toBeCloseTo(
      10 ** (-100 / 200),
      6,
    );
  });
  test("truncated RIFF resources fail transactionally", (): void => {
    const id = "truncated-font";
    const data = tinyFont();
    registerSoundFont(id, data);
    const ids = new Set([id]);
    const before = snapshotAudioResources(ids);
    expect((): Array<{ name: string; bank: number; program: number }> =>
      registerSoundFont(id, data.slice(0, 100)),
    ).toThrow("Truncated");
    expect(snapshotAudioResources(ids)).toEqual(before);
  });
});

describe("compressed SoundFont samples", () => {
  const fixture = Bun.file(new URL("../fixtures/soundfont-vorbis.sf3", import.meta.url));

  test("decoded frames preserve stereo links and sample-relative loops", async () => {
    const file = parseSoundFont(await fixture.arrayBuffer());
    // Accept the inclusive byte end as well as the exclusive ends in the fixture.
    required(file.headers[0]).end--;
    const { headers, samples } = await decodeSoundFont(file);
    for (const [index, type] of [4, 2].entries()) {
      const header = required(headers[index]);
      expect(header.type).toBe(type);
      expect(header.link).toBe(1 - index);
      expect(header.sampleRate).toBe(16_000);
      expect(header.end - header.start).toBe(800);
      expect(header.loopStart - header.start).toBe(100);
      expect(header.loopEnd - header.start).toBe(700);
      expect(
        samples.subarray(header.start, header.end).some((sample) => Math.abs(sample) > 0.1),
      ).toBe(true);
    }
  });

  test("a corrupted compressed sample cannot replace an installed font", async () => {
    const id = "sf3-replacement";
    registerSoundFont(id, tinyFont());
    const ids = new Set([id]);
    const before = snapshotAudioResources(ids);
    const data = await fixture.arrayBuffer();
    const { sampleData } = parseSoundFont(data);
    sampleData.setUint8(0, 0);
    expect(await loadSoundFont(id, data).catch((error: unknown) => error)).toEqual(
      new Error("Invalid Ogg Vorbis sample data."),
    );
    expect(snapshotAudioResources(ids)).toEqual(before);
    removeAudioResource(id);
  });
});
describe("downloaded public-domain Florestan SoundFont", (): void => {
  test("bundled asset hash, native presets and rendered sound match the real upstream file", async (): Promise<void> => {
    const data = await Bun.file(
      new URL("../assets/florestan-subset.sf2", import.meta.url),
    ).arrayBuffer();
    expect(data.byteLength).toBe(531_786);
    expect(new Bun.CryptoHasher("sha256").update(data).digest("hex")).toBe(
      "1d890349a4bf0ae8d932000f0157633c03b81e127e479e069238ff382db44a32",
    );
    expect(new TextDecoder().decode(data).includes("Public Domain")).toBe(true);
    const presets = registerSoundFont("florestan-real", data);
    expect(presets).toHaveLength(17);
    expect(presets[0]).toEqual({ name: "Piano", bank: 0, program: 2 });
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    required(song.channels[0]).cells[0] = 1;
    required(required(song.channels[0]).patterns[1]).notes = [createNote(0, 2, [48, 52, 55])];
    const instrument = createInstrument("SoundFont");
    instrument.resourceId = "florestan-real";
    instrument.bank = 0;
    instrument.program = 2;
    required(song.channels[0]).instruments = [instrument];
    const renderer = new SongRenderer(song, 8000);
    let peak = 0;
    for (let index = 0; index < 8000; index++) {
      const output = renderer.sample();
      expect(output.every(Number.isFinite)).toBe(true);
      peak = Math.max(peak, Math.abs(output[0]), Math.abs(output[1]));
    }
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThan(1);
  });
});

describe("prepared resource installation", () => {
  test("SoundFont replacements do not alter a stable resource until installation", async () => {
    registerSoundFont("stable-font", tinyFont());
    const stableIds = new Set(["stable-font"]);
    const previous = snapshotAudioResources(stableIds);
    const source = Bun.file(new URL("../assets/florestan-subset.sf2", import.meta.url));
    const data = await source.arrayBuffer();
    registerSoundFont("prepared-font", data);
    expect(snapshotAudioResources(stableIds)).toEqual(previous);
    const prepared = required(snapshotAudioResources(new Set(["prepared-font"]))[0]);
    installAudioResourceAlias("prepared-font", "stable-font");
    removeAudioResource("prepared-font");
    expect(snapshotAudioResources(stableIds)).toEqual([{ ...prepared, id: "stable-font" }]);
    expect(hasAudioResource("prepared-font")).toBe(false);
  });
  test("PCM replacement is isolated until install and survives prepared resource cleanup", () => {
    registerAudioResource(
      "stable-pcm",
      new Float32Array([0.25, 0.25]),
      new Float32Array([0.5, 0.5]),
      8000,
    );
    const before = getAudioResourceInfo("stable-pcm");
    registerAudioResource(
      "prepared-pcm",
      new Float32Array([0.75, 0.75]),
      new Float32Array([1, 1]),
      8000,
    );
    expect(getAudioResourceInfo("stable-pcm")).toEqual(before);
    installAudioResourceAlias("prepared-pcm", "stable-pcm");
    removeAudioResource("prepared-pcm");
    expect(getAudioResourceInfo("stable-pcm")?.waveform[0]).toBe(1);
    expect(getAudioResourceInfo("prepared-pcm")).toBeUndefined();
  });
});

describe("prepared SoundFont playback", () => {
  test("negative volume sustain renders like zero attenuation through decay and release", () => {
    const song = createSong();
    const channel = required(song.channels[0]);
    song.channels = [channel];
    channel.cells[0] = 1;
    required(channel.patterns[1]).notes = [createNote(0, 2, 60)];
    const instrument = createInstrument("SoundFont");
    instrument.presetEffects = false;
    instrument.release = 1;
    channel.instruments = [instrument];
    const render = (sustain: number): Float32Array => {
      const id = `volume-sustain-${sustain}`;
      registerSoundFont(
        id,
        tinyFont(false, [
          [36, -3285],
          [37, sustain],
          [38, 0],
          [48, 260],
        ]),
      );
      try {
        instrument.resourceId = id;
        const right = new Float32Array(16_000);
        new SongRenderer(song, 8000).process(new Float32Array(right.length), right);
        return right;
      } finally {
        removeAudioResource(id);
      }
    };
    const fullSustain = render(0);
    expect(fullSustain.some((sample) => Math.abs(sample) > 0.001)).toBe(true);
    const negativeSustain = render(-900);
    expect(negativeSustain.every((sample) => Math.abs(sample) < 1)).toBe(true);
    expect(negativeSustain).toEqual(fullSustain);
  });

  test("cached preset sends remain silent before onset and reset with the renderer", () => {
    registerSoundFont(
      "preset-send-reset",
      tinyFont(true, [
        [15, 300],
        [16, 500],
      ]),
    );
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    channel.cells[0] = 1;
    required(channel.patterns[1]).notes = [createNote(0.25, 0.75, [48, 52])];
    const instrument = createInstrument("SoundFont");
    instrument.resourceId = "preset-send-reset";
    instrument.presetEffects = true;
    channel.instruments = [instrument];
    const reused = new SongRenderer(song, 8000);
    const render = (renderer: SongRenderer, frames: number): Float32Array => {
      const left = new Float32Array(frames);
      renderer.process(left, new Float32Array(frames));
      return left;
    };
    expect(render(reused, 800).every((sample) => sample === 0)).toBe(true);
    expect(render(reused, 4000).some((sample) => Math.abs(sample) > 0.001)).toBe(true);
    reused.seek(0);
    const fresh = new SongRenderer(structuredClone(song), 8000);
    // Seeking resets both delay history and the chorus modulation phase.
    const wet = render(reused, 4000);
    expect(wet).toEqual(render(fresh, 4000));
    instrument.presetEffects = false;
    const dry = render(new SongRenderer(song, 8000), 4000);
    expect(dry.some((sample) => Math.abs(sample) > 0.001)).toBe(true);
    expect(wet.some((sample, index) => Math.abs(sample - required(dry[index])) > 0.001)).toBe(true);
  });
  test("mono zones match duplicated stereo samples through bends and effect tails", () => {
    const presetGenerators = [
      [17, 200],
      [16, 500],
    ] as const;
    registerSoundFont("mono-zone", tinyFont(false, presetGenerators));
    registerSoundFont("stereo-zone", tinyFont(true, presetGenerators));
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    const note = createNote(0, 0.5, [48, 52]);
    note.pins = [
      { time: 0, interval: 0, volume: 3 },
      { time: 0.5, interval: 2, volume: 2 },
    ];
    channel.cells[0] = 1;
    required(channel.patterns[1]).notes = [note];
    const mono = createInstrument("SoundFont");
    mono.resourceId = "mono-zone";
    mono.attack = 0;
    mono.release = 1;
    mono.presetEffects = true;
    channel.instruments = [mono];
    const stereoSong = structuredClone(song);
    const stereo = required(required(stereoSong.channels[0]).instruments[0]);
    stereo.id += "-stereo";
    stereo.resourceId = "stereo-zone";
    const a = new SongRenderer(song, 8000);
    const b = new SongRenderer(stereoSong, 8000);
    for (let index = 0; index < 8000; index++) {
      expect(a.sample()).toEqual(b.sample());
    }
  });
  const longReleaseSong = (): Song => {
    registerSoundFont("runtime-font", tinyFont(true, [[38, 13_200]]));
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    channel.cells[0] = 1;
    required(channel.patterns[1]).notes = [createNote(0, 0.1, [48, 52, 55])];
    const instrument = createInstrument("SoundFont");
    instrument.resourceId = "runtime-font";
    instrument.attack = 0;
    instrument.release = 8;
    instrument.presetEffects = false;
    channel.instruments = [instrument];
    return song;
  };
  test("block rendering preserves sample and filter continuity", () => {
    const song = longReleaseSong();
    const a = new SongRenderer(song, 8000);
    const controlSong = structuredClone(song);
    required(required(controlSong.channels[0]).instruments[0]).id += "-control";
    const b = new SongRenderer(controlSong, 8000);
    const left = new Float32Array(200);
    const right = new Float32Array(200);
    a.process(left, right);
    for (let index = 0; index < left.length; index++) {
      expect([left[index], right[index]]).toEqual(b.sample());
    }
    a.process(left, right);
    for (let index = 0; index < left.length; index++) {
      const actual = b.sample();
      expect(actual[0]).toBeCloseTo(required(left[index]), 12);
      expect(actual[1]).toBeCloseTo(required(right[index]), 12);
    }
  });
  test("long native releases remain audible and finish despite an eight-second editor fade", () => {
    const song = longReleaseSong();
    const renderer = new SongRenderer(song, 8000);
    let tail = 0;
    let finished = 0;
    for (let index = 0; index < 18_000; index++) {
      const sample = renderer.sample();
      expect(sample.every(Number.isFinite)).toBe(true);
      if (index >= 800 && index < 1600) {
        tail = Math.max(tail, ...sample.map(Math.abs));
      }
      if (index >= 17_000) {
        finished = Math.max(finished, ...sample.map(Math.abs));
      }
    }
    expect(tail).toBeGreaterThan(0.001);
    expect(finished).toBe(0);
  });
});
