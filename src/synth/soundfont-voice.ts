import { required } from "../model";
import {
  absoluteCentsToHz,
  applySFModulators,
  createSFEnvelopeState,
  defaultSFControllers,
  prepareSFEnvelope,
  timecentsToSeconds,
} from "./soundfont";
import type { PreparedSFEnvelope, SFEnvelopeState } from "./soundfont";
import type { SFPreset, SFSample, SoundFont } from "./soundfont-file";

const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Number.isNaN(value) ? 0 : value));

// These values depend on the font, preset and original key, never on voice age.
type SFZoneConfig = Readonly<{
  header: SFSample;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  mode: number;
  linkedOffset: number;
  fixedKey: number;
  root: number;
  scale: number;
  tuning: number;
  gain: number;
  modEnvelope: PreparedSFEnvelope;
  volEnvelope: PreparedSFEnvelope;
  modPitch: number;
  vibPitch: number;
  envPitch: number;
  modDelay: number;
  vibDelay: number;
  modRate: number;
  vibRate: number;
  cutoff: number;
  modFilter: number;
  envFilter: number;
  q: number;
  mono: boolean;
  modVolume: number;
  panL: number;
  panR: number;
  reverb: number;
  chorus: number;
}>;
type SFVoiceZone = SFZoneConfig & {
  position: number;
  rateCents: number;
  playbackRate: number;
  filterCents: number;
  b0: number;
  a1: number;
  a2: number;
  history: [number, number, number, number, number, number, number, number];
  modEnvelopeState: SFEnvelopeState;
  volEnvelopeState: SFEnvelopeState;
};
export type SFVoiceState = {
  block: number;
  font: SoundFont;
  bank: number;
  program: number;
  originalKey: number;
  frequency: number;
  midi: number;
  zones: SFVoiceZone[];
  finished: boolean;
};
const prepareZones = (
  font: SoundFont,
  preset: SFPreset,
  originalKey: number,
): readonly SFZoneConfig[] => {
  const state = defaultSFControllers(originalKey);
  const zones: SFZoneConfig[] = [];
  for (const zone of preset.zones) {
    const keyRange = zone.generators.get(43) ?? 32_512;
    const velocityRange = zone.generators.get(44) ?? 32_512;
    const fixedKey = zone.generators.get(46) ?? -1;
    const fixedVelocity = zone.generators.get(47) ?? -1;
    const key = fixedKey >= 0 ? fixedKey : originalKey;
    const velocity = fixedVelocity >= 0 ? fixedVelocity : state.velocity;
    if (
      key < (keyRange & 255) ||
      key > keyRange >>> 8 ||
      velocity < (velocityRange & 255) ||
      velocity > velocityRange >>> 8
    ) {
      continue;
    }
    const g = applySFModulators(zone.generators, zone.modulators, {
      ...state,
      key,
      velocity,
    });
    // EMU hardware scales the written attenuation, while modulators add full centibels.
    const initialAttenuation = zone.generators.get(48) ?? 0;
    const modulatedAttenuation = (g.get(48) ?? 0) - initialAttenuation;
    const attenuation = clamp(initialAttenuation * 0.4 + modulatedAttenuation, 0, 1440);
    const header = required(font.headers[zone.sampleIndex]);
    const rootOverride = g.get(58) ?? -1;
    const pan = clamp((g.get(17) ?? 0) / 500, -1, 1);
    const linked = font.headers[header.link];
    // Some banks use a placeholder link on separately panned left and right zones.
    const stereoPair =
      linked?.link === zone.sampleIndex &&
      ((header.type === 2 && linked.type === 4) || (header.type === 4 && linked.type === 2));
    const linkedOffset = stereoPair ? linked.start - header.start : 0;
    zones.push({
      header,
      start: header.start + (g.get(0) ?? 0) + (g.get(4) ?? 0) * 32_768,
      end: header.end + (g.get(1) ?? 0) + (g.get(12) ?? 0) * 32_768,
      loopStart: header.loopStart + (g.get(2) ?? 0) + (g.get(45) ?? 0) * 32_768,
      loopEnd: header.loopEnd + (g.get(3) ?? 0) + (g.get(50) ?? 0) * 32_768,
      mode: (g.get(54) ?? 0) & 3,
      linkedOffset,
      fixedKey,
      root: rootOverride >= 0 ? rootOverride : header.root,
      scale: g.get(56) ?? 100,
      tuning: (g.get(51) ?? 0) * 100 + (g.get(52) ?? 0) + header.correction,
      gain: 0.5 * 10 ** (-attenuation / 200),
      modEnvelope: prepareSFEnvelope(g, key, false),
      volEnvelope: prepareSFEnvelope(g, key, true),
      modPitch: g.get(5) ?? 0,
      vibPitch: g.get(6) ?? 0,
      envPitch: g.get(7) ?? 0,
      modDelay: timecentsToSeconds(g.get(21) ?? -12_000),
      vibDelay: timecentsToSeconds(g.get(23) ?? -12_000),
      modRate: absoluteCentsToHz(g.get(22) ?? 0) * TAU,
      vibRate: absoluteCentsToHz(g.get(24) ?? 0) * TAU,
      cutoff: g.get(8) ?? 13_500,
      modFilter: g.get(10) ?? 0,
      envFilter: g.get(11) ?? 0,
      q: 10 ** (clamp(g.get(9) ?? 0, 0, 960) / 200),
      mono: linkedOffset === 0,
      modVolume: (g.get(13) ?? 0) / 10,
      panL: Math.cos((Math.max(0, pan) * Math.PI) / 2),
      panR: Math.cos((Math.max(0, -pan) * Math.PI) / 2),
      reverb: clamp((g.get(16) ?? 0) / 1000, 0, 1),
      chorus: clamp((g.get(15) ?? 0) / 1000, 0, 1),
    });
  }
  return zones;
};

// Weak ownership releases prepared metadata when a font is removed or replaced.
const preparedZones = new WeakMap<
  SoundFont,
  WeakMap<SFPreset, Map<number, readonly SFZoneConfig[]>>
>();
const cachedZones = (
  font: SoundFont,
  preset: SFPreset,
  originalKey: number,
): readonly SFZoneConfig[] => {
  // Bound metadata to the MIDI key space while retaining out-of-range playback.
  if (!Number.isInteger(originalKey) || originalKey < 0 || originalKey > 127) {
    return prepareZones(font, preset, originalKey);
  }
  let presets = preparedZones.get(font);
  if (!presets) {
    presets = new WeakMap();
    preparedZones.set(font, presets);
  }
  let keys = presets.get(preset);
  if (!keys) {
    keys = new Map();
    presets.set(preset, keys);
  }
  let zones = keys.get(originalKey);
  if (!zones) {
    zones = prepareZones(font, preset, originalKey);
    keys.set(originalKey, zones);
  }
  return zones;
};

export const prepareSoundFontVoice = (
  font: SoundFont,
  preset: SFPreset,
  originalKey: number,
): SFVoiceState => ({
  block: 0,
  font,
  bank: preset.bank,
  program: preset.program,
  originalKey,
  frequency: Number.NaN,
  midi: 0,
  zones: cachedZones(font, preset, originalKey).map((zone): SFVoiceZone => ({
    ...zone,
    position: zone.start,
    rateCents: Number.NaN,
    playbackRate: 0,
    filterCents: Number.NaN,
    b0: 0,
    a1: 0,
    a2: 0,
    history: [0, 0, 0, 0, 0, 0, 0, 0],
    modEnvelopeState: createSFEnvelopeState(),
    volEnvelopeState: createSFEnvelopeState(),
  })),
  finished: false,
});
