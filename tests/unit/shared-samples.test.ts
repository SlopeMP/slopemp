import { expect, test } from "bun:test";

import {
  installAudioResourceAlias,
  installSoundFont,
  registerAudioResource,
  removeAudioResource,
  snapshotAudioResources,
} from "../../src/audio";
import { required } from "../../src/model";
import { createSampleBuffer, shareSamples } from "../../src/shared-samples";
import { decodeSoundFont } from "../../src/soundfont-loader";
import { decodePCMSoundFont, parseSoundFont } from "../../src/synth/soundfont-file";

test("sample buffers retain one backing store across worker message clones", () => {
  const samples = createSampleBuffer(4);
  samples.set([0, 0.25, -0.5, 1]);
  expect(samples.buffer).toBeInstanceOf(SharedArrayBuffer);
  expect(shareSamples(samples)).toBe(samples);
  const clone = structuredClone(samples);
  expect(clone).toEqual(samples);
  // A write makes shared backing observable without relying on JS wrapper identity.
  clone[1] = 0.75;
  expect(samples[1]).toBe(0.75);
});

test("normal sample views copy only their visible frames into shared storage", () => {
  const source = new Float32Array([9, 0.25, -0.5, 9]);
  const samples = shareSamples(source.subarray(1, 3));
  expect(samples).toEqual(new Float32Array([0.25, -0.5]));
  expect(samples.byteOffset).toBe(0);
  expect(samples.buffer.byteLength).toBe(2 * Float32Array.BYTES_PER_ELEMENT);
  expect(samples.buffer).toBeInstanceOf(SharedArrayBuffer);
  source[1] = 1;
  expect(samples[0]).toBe(0.25);
});

test("installed fonts and PCM aliases share samples while replacements get fresh storage", () => {
  const ids = new Set(["shared-font", "shared-font-alias", "shared-pcm", "shared-pcm-alias"]);
  const source = new Float32Array([0.25, -0.5]);
  try {
    installSoundFont("shared-font", { samples: source, headers: [], presets: [] });
    installAudioResourceAlias("shared-font", "shared-font-alias");
    registerAudioResource("shared-pcm", source, source, 8000);
    installAudioResourceAlias("shared-pcm", "shared-pcm-alias");
    const snapshot = snapshotAudioResources(ids);
    const font = required(snapshot.find((update) => update.type === "soundfont"));
    const pcm = required(snapshot.find((update) => update.type === "sample"));
    expect(font.font.samples.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(pcm.resource.left.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(pcm.resource.right).toBe(pcm.resource.left);
    const alias = required(
      snapshot
        .filter((update) => update.type === "soundfont")
        .find((update) => update.id === "shared-font-alias"),
    );
    expect(alias.font.samples).toBe(font.font.samples);
    const pcmAlias = required(
      snapshot
        .filter((update) => update.type === "sample")
        .find((update) => update.id === "shared-pcm-alias"),
    );
    expect(pcmAlias.resource.left).toBe(pcm.resource.left);
    const cloned = structuredClone(snapshot);
    const clonedFont = required(cloned.find((update) => update.type === "soundfont"));
    clonedFont.font.samples[0] = 0.5;
    expect(font.font.samples[0]).toBe(0.5);
    source[0] = 1;
    registerAudioResource("shared-pcm", source, source, 8000);
    const replacement = required(
      snapshotAudioResources(ids)
        .filter((update) => update.type === "sample")
        .find((update) => update.id === "shared-pcm"),
    );
    expect(replacement.resource.left[0]).toBe(1);
    expect(pcmAlias.resource.left[0]).toBe(0.25);
    expect(replacement.resource.left.buffer).not.toBe(pcmAlias.resource.left.buffer);
  } finally {
    for (const id of ids) {
      removeAudioResource(id);
    }
  }
});

test("SF2 and SF3 decoders write final samples directly to shared storage", async () => {
  const pcm = await Bun.file(
    new URL("../assets/florestan-subset.sf2", import.meta.url),
  ).arrayBuffer();
  const compressed = await Bun.file(
    new URL("../fixtures/soundfont-vorbis.sf3", import.meta.url),
  ).arrayBuffer();
  const sf2 = decodePCMSoundFont(parseSoundFont(pcm));
  const sf3 = await decodeSoundFont(parseSoundFont(compressed));
  expect(sf2.samples.buffer).toBeInstanceOf(SharedArrayBuffer);
  expect(sf3.samples.buffer).toBeInstanceOf(SharedArrayBuffer);
  expect(sf2.samples.some((sample) => sample !== 0)).toBe(true);
  expect(sf3.samples.some((sample) => sample !== 0)).toBe(true);
});

test("sample allocation still supports environments without shared memory", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "SharedArrayBuffer");
  try {
    Reflect.set(globalThis, "SharedArrayBuffer", undefined);
    const source = new Float32Array([0.25, -0.5]);
    expect(shareSamples(source)).toBe(source);
    expect(createSampleBuffer(4).buffer).toBeInstanceOf(ArrayBuffer);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "SharedArrayBuffer", previous);
    }
  }
});
