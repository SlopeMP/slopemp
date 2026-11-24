import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  getAudioResourceInfo,
  hasAudioResource,
  installAudioResourceAlias,
  registerAudioResource,
  removeAudioResource,
  SongRenderer,
} from "../../src/audio";
import { BUNDLED_RESOURCES } from "../../src/bundled-resources";
import { createInstrument } from "../../src/instruments";
import { clone, createNote, createSong, History, required, validateSong } from "../../src/model";
import { assetType, resourceCacheKey } from "../../src/resource-identity";
import { decodeSong, encodeSong } from "../../src/storage";
import { TEST_RESOURCES } from "../assets/resources";
import { renderWav } from "./export-worker-fixture";

type PCMClip = {
  samples: Float32Array;
  sampleRate: number;
  frames: number;
  channels: number;
  bits: number;
};
const text = (view: DataView, offset: number, length: number): string =>
  Array.from({ length }, (_, index) => String.fromCodePoint(view.getUint8(offset + index))).join(
    "",
  );
const decodePCM = (data: ArrayBuffer): PCMClip => {
  const view = new DataView(data);
  if (text(view, 0, 4) !== "RIFF" || text(view, 8, 4) !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE test asset.");
  }
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let payload: { offset: number; size: number } | null = null;
  for (let offset = 12; offset + 8 <= data.byteLength;) {
    const name = text(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > data.byteLength) {
      throw new Error("Truncated WAV test asset.");
    }
    if (name === "fmt ") {
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      bits = view.getUint16(start + 14, true);
    } else if (name === "data") {
      payload = { offset: start, size };
    }
    offset = start + size + (size % 2);
  }
  if (format !== 1 || channels !== 2 || (bits !== 16 && bits !== 24) || !payload) {
    throw new Error("Expected stereo 16-bit or 24-bit PCM test samples.");
  }
  const { offset, size } = payload;
  const frames = size / ((channels * bits) / 8);
  const samples = Float32Array.from({ length: frames }, (_, index) => {
    const pos = offset + index * channels * (bits / 8);
    return bits === 16
      ? view.getInt16(pos, true) / 32_768
      : (view.getInt8(pos + 2) * 65_536 + view.getUint16(pos, true)) / 8_388_608;
  });
  return { samples, sampleRate, frames, channels, bits };
};
const clips = [
  {
    id: "test-piano-c4",
    file: "piano-C4.wav",
    bytes: 2_613_976,
    frames: 653_483,
    hash: "69845de40a38ed6501746520f9f385ae56200a4372faed48178e64a32a75e58c",
  },
  {
    id: "test-flute-c4",
    file: "flute-C4.wav",
    bytes: 2_009_832,
    frames: 334_863,
    hash: "e88a0ff35e6b8c29fd88bc778a4c817d955b2c3a2934def97a7d093b72e2ae97",
  },
];

describe("downloaded audio assets", () => {
  for (const clip of clips) {
    test(`${clip.file} matches its upstream hash and plays through the song master path`, async () => {
      const data = await Bun.file(new URL(`../assets/${clip.file}`, import.meta.url)).arrayBuffer();
      expect(data.byteLength).toBe(clip.bytes);
      expect(createHash("sha256").update(new Uint8Array(data)).digest("hex")).toBe(clip.hash);
      const decoded = decodePCM(data);
      expect(decoded.frames).toBe(clip.frames);
      expect(decoded.sampleRate).toBe(44_100);
      const resource = required(TEST_RESOURCES.find((entry) => entry.id === clip.id));
      expect(resource.rootKey).toBe(60);
      expect(resource.metadata?.license).toBe("CC0-1.0");
      registerAudioResource(clip.id, decoded.samples, decoded.samples.slice(), decoded.sampleRate);
      expect(getAudioResourceInfo(clip.id)?.frames).toBe(decoded.frames);
      const song = createSong();
      song.channels = song.channels.slice(0, 1);
      song.barCount = 1;
      song.beatsPerBar = 1;
      song.loopStart = 0;
      song.loopEnd = 1;
      song.tempo = 300;
      const channel = required(song.channels[0]);
      channel.cells = [1];
      required(channel.patterns[1]).notes = [createNote(0, 1, 48)];
      const instrument = createInstrument("chip wave");
      instrument.resourceId = clip.id;
      instrument.rootKey = 60;
      instrument.loopMode = "Play Once";
      channel.instruments = [instrument];
      validateSong(song);
      const renderer = new SongRenderer(song, 8000);
      let peak = 0;
      let energy = 0;
      for (let index = 0; index < 1600; index++) {
        const [left, right] = renderer.sample();
        expect(Number.isFinite(left) && Number.isFinite(right)).toBe(true);
        expect(left).toBeCloseTo(right, 8);
        peak = Math.max(peak, Math.abs(left), Math.abs(right));
        energy += left * left;
      }
      expect(peak).toBeGreaterThan(0.001);
      expect(peak).toBeLessThanOrEqual(1);
      expect(energy).toBeGreaterThan(0.001);
      const wav = await renderWav(song, { sampleRate: 8000, loopCount: 1 });
      const rendered = new DataView(await wav.arrayBuffer());
      expect(rendered.getUint16(22, true)).toBe(2);
      expect(rendered.getUint32(40, true)).toBe(1600 * 4);
      const muted = await renderWav(song, { sampleRate: 8000, muted: new Set([channel.id]) });
      const silent = new DataView(await muted.arrayBuffer());
      expect(
        Array.from({ length: 1600 }, (_, index) => silent.getInt16(44 + index * 4, true)).every(
          (value) => value === 0,
        ),
      ).toBe(true);
    });
  }
  test("new songs own independent bundled asset references and preserve them in song links", () => {
    const first = createSong();
    const second = createSong();
    expect(first.resources).toEqual(BUNDLED_RESOURCES);
    expect(first.resources.filter((entry) => assetType(entry.url) === "audio")).toHaveLength(0);
    expect(first.resources.filter((entry) => assetType(entry.url) === "soundfont")).toHaveLength(1);
    required(first.resources[0]).url = "./replacement.sf2";
    expect(second.resources).toEqual(BUNDLED_RESOURCES);
    expect(decodeSong(encodeSong(first)).resources).toEqual(first.resources);
    expect(() => decodeSong(JSON.stringify(createSong()))).toThrow();
    first.resources = [];
    expect(decodeSong(encodeSong(first)).resources).toEqual([]);
  });
  test("invalid asset URLs and sample metadata cannot enter a Change or imported project", () => {
    for (const invalid of [
      { url: "" },
      { rootKey: 128 },
      { start: -1 },
      { loopStart: 10, loopEnd: 5 },
      { loopEnd: Number.NaN },
    ]) {
      const song = createSong();
      song.resources = structuredClone(TEST_RESOURCES);
      Object.assign(required(song.resources[0]), invalid);
      expect(() => {
        validateSong(song);
      }).toThrow();
    }
  });
  test("asset notices and complete license texts are present beside the recorded provenance", async () => {
    const readme = await Bun.file(new URL("../assets/README.md", import.meta.url)).text();
    for (const clip of clips) {
      expect(readme).toContain(clip.file);
      expect(readme).toContain(clip.hash);
    }
    const soundfont = await Bun.file(
      new URL("../assets/florestan-subset.txt", import.meta.url),
    ).text();
    expect(soundfont).toContain("Public Domain");
    expect(soundfont).toContain("Nando Florestan");
  });
});

describe("resource source identities and Undo", () => {
  test("revisions of the same asset URL have distinct caches and support undo and redo", () => {
    const song = createSong();
    const original = clone(
      required(TEST_RESOURCES.find((entry) => assetType(entry.url) === "audio")),
    );
    original.id = "asset-revision-fixture";
    original.loopEnd = 128;
    original.metadata = { revision: "old-bytes" };
    song.resources = [original];
    const history = new History(song);
    const before = resourceCacheKey(original);
    const oldSamples = Float32Array.from({ length: 128 }, () => 0.25);
    const newSamples = Float32Array.from({ length: 128 }, () => 0.75);
    registerAudioResource(original.id, oldSamples, oldSamples.slice(), 8000);
    installAudioResourceAlias(original.id, before);
    registerAudioResource("asset-preview", newSamples, newSamples.slice(), 8000);
    expect(required(getAudioResourceInfo(original.id)).waveform[0]).toBe(0.25);
    removeAudioResource("asset-preview");
    expect(hasAudioResource("asset-preview")).toBe(false);
    expect(required(getAudioResourceInfo(original.id)).waveform[0]).toBe(0.25);
    expect(history.canUndo).toBe(false);
    registerAudioResource("asset-preview", newSamples, newSamples.slice(), 8000);
    const replacement = clone(original);
    replacement.metadata = { revision: "new-bytes" };
    const after = resourceCacheKey(replacement);
    expect(before).not.toBe(after);
    installAudioResourceAlias("asset-preview", after);
    installAudioResourceAlias(after, original.id);
    history.execute((candidate) => {
      candidate.resources = [replacement];
    });
    removeAudioResource("asset-preview");
    expect(required(getAudioResourceInfo(original.id)).waveform[0]).toBe(0.75);
    history.undo();
    const restored = required(history.song.resources[0]);
    installAudioResourceAlias(resourceCacheKey(restored), restored.id);
    expect(restored.url).toBe(original.url);
    expect(required(getAudioResourceInfo(original.id)).waveform[0]).toBe(0.25);
    history.redo();
    const redone = required(history.song.resources[0]);
    installAudioResourceAlias(resourceCacheKey(redone), redone.id);
    expect(redone.url).toBe(original.url);
    expect(required(getAudioResourceInfo(original.id)).waveform[0]).toBe(0.75);
    for (const id of [original.id, before, after]) {
      removeAudioResource(id);
    }
  });
  test("cache identity follows sources and revisions while playback metadata remains independent", () => {
    const source = clone(required(createSong().resources[0]));
    const base = resourceCacheKey(source);
    source.loopStart = 12;
    source.loopEnd = 50;
    source.rootKey = 62;
    expect(resourceCacheKey(source)).toBe(base);
    source.url += "?new-version";
    expect(resourceCacheKey(source)).not.toBe(base);
    const remote = resourceCacheKey(source);
    source.metadata = { revision: "reloaded-url" };
    expect(resourceCacheKey(source)).not.toBe(remote);
  });
});
