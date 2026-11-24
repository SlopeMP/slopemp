import { createSampleBuffer } from "../shared-samples";
import { mergeSFModulators, SF2_DEFAULT_GENERATORS, SF2_DEFAULT_MODULATORS } from "./soundfont";
import type { SFModulator } from "./soundfont";

type SFZone = Readonly<{
  generators: ReadonlyMap<number, number>;
  sampleIndex: number;
  modulators: ReadonlyArray<Readonly<SFModulator>>;
}>;
export type SoundFontPreset = {
  name: string;
  bank: number;
  program: number;
};
export type SFPreset = Readonly<SoundFontPreset & { zones: readonly SFZone[] }>;
export type SFSample = {
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  sampleRate: number;
  root: number;
  correction: number;
  link: number;
  type: number;
};
export type SoundFont = {
  samples: Float32Array;
  headers: SFSample[];
  presets: readonly SFPreset[];
};
export type SoundFontFile = Omit<SoundFont, "samples"> & {
  sampleData: DataView;
  sampleLowBytes: Uint8Array | undefined;
};

export const compressedSampleFlag = 0x10;
export const isCompressed = (header: SFSample): boolean =>
  (header.type & compressedSampleFlag) !== 0;

const ascii = (view: DataView, start: number, length: number): string =>
  Array.from({ length }, (_, i): string => String.fromCodePoint(view.getUint8(start + i)))
    .join("")
    .replace(/\0.*$/u, "");
export const parseSoundFont = (data: ArrayBuffer): SoundFontFile => {
  const view = new DataView(data);
  const chunks = new Map<
    string,
    {
      offset: number;
      length: number;
    }
  >();
  if (view.byteLength < 12 || ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "sfbk") {
    throw new Error("The file is not a valid SF2 or SF3 SoundFont.");
  }
  const scan = (start: number, end: number, inList: boolean): void => {
    for (let offset = start; offset + 8 <= end;) {
      const name = ascii(view, offset, 4);
      const length = view.getUint32(offset + 4, true);
      const begin = offset + 8;
      const chunkEnd = begin + length;
      if (chunkEnd > end) {
        throw new Error("Truncated SoundFont.");
      }
      let sampleChunk = name === "smpl";
      if (name === "LIST") {
        if (inList || length < 4) {
          throw new Error("Invalid SoundFont chunk list.");
        }
        sampleChunk = ascii(view, begin, 4) === "sdta";
        scan(begin + 4, chunkEnd, true);
      } else {
        chunks.set(name, { offset: begin, length });
      }
      // SF3 permits odd smpl and sdta chunks without a zero padding byte.
      const padded = !sampleChunk || (chunkEnd < end && view.getUint8(chunkEnd) === 0);
      offset = chunkEnd + (padded ? length % 2 : 0);
    }
  };
  scan(12, view.byteLength, false);
  const chunk = (
    name: string,
  ): {
    offset: number;
    length: number;
  } => {
    const item = chunks.get(name);
    if (!item) {
      throw new Error(`SoundFont is missing ${name}.`);
    }
    return item;
  };
  const smpl = chunk("smpl");
  const sm24 = chunks.get("sm24");
  const shdr = chunk("shdr");
  const headers: SFSample[] = [];
  for (let { offset } = shdr; offset + 46 < shdr.offset + shdr.length; offset += 46) {
    headers.push({
      start: view.getUint32(offset + 20, true),
      end: view.getUint32(offset + 24, true),
      loopStart: view.getUint32(offset + 28, true),
      loopEnd: view.getUint32(offset + 32, true),
      sampleRate: view.getUint32(offset + 36, true),
      root: view.getUint8(offset + 40),
      correction: view.getInt8(offset + 41),
      link: view.getUint16(offset + 42, true),
      type: view.getUint16(offset + 44, true),
    });
  }
  const generators = (name: string): Array<Map<number, number>> => {
    const item = chunk(name);
    const output: Array<Map<number, number>> = [];
    for (let { offset } = item; offset + 4 <= item.offset + item.length; offset += 4) {
      const operator = view.getUint16(offset, true);
      const amount =
        operator === 43 || operator === 44
          ? view.getUint16(offset + 2, true)
          : view.getInt16(offset + 2, true);
      output.push(new Map([[operator, amount]]));
    }
    return output;
  };
  const pgen = generators("pgen");
  const igen = generators("igen");
  const modulators = (name: string): SFModulator[] => {
    const item = chunks.get(name);
    const output: SFModulator[] = [];
    if (!item) {
      return output;
    }
    if (item.length % 10 !== 0) {
      throw new Error("Invalid SoundFont modulator data.");
    }
    for (let { offset } = item; offset + 10 <= item.offset + item.length; offset += 10) {
      output.push({
        source: view.getUint16(offset, true),
        destination: view.getUint16(offset + 2, true),
        amount: view.getInt16(offset + 4, true),
        amountSource: view.getUint16(offset + 6, true),
        transform: view.getUint16(offset + 8, true),
      });
    }
    return output;
  };
  const pmod = modulators("pmod");
  const imod = modulators("imod");
  const modBags = (name: string): number[] => {
    const item = chunk(name);
    const output: number[] = [];
    for (let { offset } = item; offset + 4 <= item.offset + item.length; offset += 4) {
      output.push(view.getUint16(offset + 2, true));
    }
    return output;
  };
  const pmodBags = modBags("pbag");
  const imodBags = modBags("ibag");
  const modZone = (bags: number[], mods: SFModulator[], index: number): SFModulator[] =>
    mods.slice(bags[index] ?? 0, bags[index + 1] ?? mods.length);
  const bag = (name: string): number[] => {
    const item = chunk(name);
    const output: number[] = [];
    for (let { offset } = item; offset + 4 <= item.offset + item.length; offset += 4) {
      output.push(view.getUint16(offset, true));
    }
    return output;
  };
  const pbag = bag("pbag");
  const ibag = bag("ibag");
  const zone = (
    bags: number[],
    gens: Array<Map<number, number>>,
    index: number,
  ): Map<number, number> => {
    const result = new Map<number, number>();
    for (let i = bags[index] ?? 0; i < (bags[index + 1] ?? gens.length); i++) {
      for (const [key, value] of gens[i] ?? []) {
        result.set(key, value);
      }
    }
    return result;
  };
  const inst = chunk("inst");
  const instrumentBags: number[] = [];
  for (let { offset } = inst; offset + 22 <= inst.offset + inst.length; offset += 22) {
    instrumentBags.push(view.getUint16(offset + 20, true));
  }
  const phdr = chunk("phdr");
  const presets: SFPreset[] = [];
  for (let { offset } = phdr; offset + 38 < phdr.offset + phdr.length; offset += 38) {
    const zones: SFZone[] = [];
    const first = view.getUint16(offset + 24, true);
    const end = view.getUint16(offset + 62, true);
    let global = new Map<number, number>();
    let globalModulators: SFModulator[] = [];
    for (let pi = first; pi < end; pi++) {
      const pg = zone(pbag, pgen, pi);
      const instrumentIndex = pg.get(41);
      if (instrumentIndex === undefined) {
        global = pg;
        globalModulators = modZone(pmodBags, pmod, pi);
        continue;
      }
      let instrumentGlobal = new Map<number, number>();
      let instrumentGlobalModulators: SFModulator[] = [];
      for (
        let ii = instrumentBags[instrumentIndex] ?? 0;
        ii < (instrumentBags[instrumentIndex + 1] ?? 0);
        ii++
      ) {
        const ig = zone(ibag, igen, ii);
        const sampleIndex = ig.get(53);
        if (sampleIndex === undefined) {
          instrumentGlobal = ig;
          instrumentGlobalModulators = modZone(imodBags, imod, ii);
          continue;
        }
        const instrumentValues = new Map([...instrumentGlobal, ...ig]);
        const presetValues = new Map([...global, ...pg]);
        const merged = new Map(SF2_DEFAULT_GENERATORS);
        for (const [key, value] of instrumentValues) {
          merged.set(key, value);
        }
        for (const [key, value] of presetValues) {
          if (![41, 43, 44, 53].includes(key)) {
            merged.set(key, (merged.get(key) ?? 0) + value);
          }
        }
        for (const key of [43, 44]) {
          const ir = instrumentValues.get(key) ?? 32_512;
          const pr = presetValues.get(key) ?? 32_512;
          const lo = Math.max(ir & 255, pr & 255);
          const hi = Math.min(ir >>> 8, pr >>> 8);
          merged.set(key, (hi << 8) | lo);
        }
        const resolvedModulators = mergeSFModulators(
          mergeSFModulators(
            SF2_DEFAULT_MODULATORS,
            mergeSFModulators(instrumentGlobalModulators, modZone(imodBags, imod, ii)),
          ),
          mergeSFModulators(globalModulators, modZone(pmodBags, pmod, pi)),
        );
        if (!headers[sampleIndex]) {
          throw new Error("Invalid SoundFont sample reference.");
        }
        zones.push({ generators: merged, sampleIndex, modulators: resolvedModulators });
      }
    }
    presets.push({
      name: ascii(view, offset, 20),
      program: view.getUint16(offset + 20, true),
      bank: view.getUint16(offset + 22, true),
      zones,
    });
  }
  if (presets.length === 0) {
    throw new Error("The SoundFont has no playable presets.");
  }
  return {
    sampleData: new DataView(data, smpl.offset, smpl.length),
    sampleLowBytes: sm24 ? new Uint8Array(data, sm24.offset, sm24.length) : undefined,
    headers,
    presets,
  };
};

export const readPCM = (file: SoundFontFile, output: Float32Array, frames: number): void => {
  for (let index = 0; index < frames; index++) {
    const high = file.sampleData.getInt16(index * 2, true);
    output[index] = (high * 256 + (file.sampleLowBytes?.[index] ?? 0)) / 8_388_608;
  }
};

export const decodePCMSoundFont = (file: SoundFontFile): SoundFont => {
  if (file.headers.some(isCompressed)) {
    throw new Error("Compressed SoundFonts must be loaded asynchronously.");
  }
  const samples = createSampleBuffer(file.sampleData.byteLength / 2);
  readPCM(file, samples, samples.length);
  return { samples, headers: file.headers, presets: file.presets };
};
