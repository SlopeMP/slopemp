import type { Song } from "./index";
import { encodeWire } from "./index";

// Detect divergence between revisions using the same canonical representation on both peers.
export const songDigest = (song: Song): string => {
  const source = encodeWire(song, true);
  let first = 3_735_928_559;
  let second = 1_103_547_991;
  for (const character of source) {
    const code = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ code, 2_654_435_761);
    second = Math.imul(second ^ code, 1_597_334_677);
  }
  const firstHex = (first >>> 0).toString(16).padStart(8, "0");
  const secondHex = (second >>> 0).toString(16).padStart(8, "0");
  return `${firstHex}${secondHex}`;
};
