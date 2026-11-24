import { deflateSync, inflateSync } from "fflate";

// SLP2 + decoded protobuf length + CRC32 + raw DEFLATE.
const magic = [83, 76, 80, 50];
const maxBytes = 16 * 1024 * 1024;
export const invalid = (): never => {
  throw new Error("Invalid or corrupt SlopeMP data.");
};
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? (value >>> 1) ^ 3_988_292_384 : value >>> 1;
  }
  return value >>> 0;
});
const checksum = (bytes: Uint8Array): number => {
  let value = 4_294_967_295;
  for (const byte of bytes) {
    value = (value >>> 8) ^ (crcTable[(value ^ byte) & 255] ?? 0);
  }
  return (value ^ 4_294_967_295) >>> 0;
};
export const packBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (bytes.length > maxBytes) {
    throw new Error("Song data exceeds the 16 MiB save limit.");
  }
  const compressed = deflateSync(bytes, { level: 6 });
  if (compressed.length + 12 > maxBytes) {
    throw new Error("Song data exceeds the 16 MiB save limit.");
  }
  const packed = new Uint8Array(12 + compressed.length);
  packed.set(magic);
  const header = new DataView(packed.buffer);
  header.setUint32(4, bytes.length, true);
  header.setUint32(8, checksum(bytes), true);
  packed.set(compressed, 12);
  return packed;
};
export const unpackBytes = (packed: Uint8Array): Uint8Array => {
  if (
    packed.length < 13 ||
    packed.length > maxBytes ||
    magic.some((byte, index) => packed[index] !== byte)
  ) {
    invalid();
  }
  const header = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const length = header.getUint32(4, true);
  if (length === 0 || length > maxBytes) {
    invalid();
  }
  // One extra byte detects streams that overrun their declared decoded length.
  const bytes = inflateSync(packed.subarray(12), { out: new Uint8Array(length + 1) });
  if (bytes.length !== length || checksum(bytes) !== header.getUint32(8, true)) {
    invalid();
  }
  return bytes;
};
export const encodeBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/[=]+$/u, "");
};
export const decodeBytes = (text: string): Uint8Array<ArrayBuffer> => {
  if (text.length > Math.ceil((maxBytes * 4) / 3) || !/^[\w-]+$/u.test(text)) {
    invalid();
  }
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
};
