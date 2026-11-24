import { clone, integer, required } from "./model";
import type { Song } from "./model";
export type ExportOptions = {
  intro?: boolean;
  loopCount?: number;
  outro?: boolean;
};
// Export the optional intro once, the loop 1-4 times, then the optional outro once.
export const exportSequence = (song: Song, options: ExportOptions = {}): number[] => {
  const result: number[] = [];
  if (options.intro ?? true) {
    for (let bar = 0; bar < song.loopStart; bar++) {
      result.push(bar);
    }
  }
  for (let loop = 0; loop < integer(options.loopCount ?? 1, 1, 4); loop++) {
    for (let bar = song.loopStart; bar < song.loopEnd; bar++) {
      result.push(bar);
    }
  }
  if (options.outro ?? true) {
    for (let bar = song.loopEnd; bar < song.barCount; bar++) {
      result.push(bar);
    }
  }
  return result;
};
export const expandSequence = (song: Song, options: ExportOptions): Song => {
  const result = clone(song);
  const sequence = exportSequence(song, options);
  for (const channel of result.channels) {
    channel.cells = sequence.map((bar) => required(channel.cells[bar]));
  }
  result.barCount = sequence.length;
  result.loopStart = (options.intro ?? true) ? song.loopStart : 0;
  result.loopEnd =
    result.loopStart + (song.loopEnd - song.loopStart) * integer(options.loopCount ?? 1, 1, 4);
  return result;
};
export const sanitizeFilename = (name: string): string =>
  Array.from(name)
    .filter((character) => (character.codePointAt(0) ?? 0) >= 32)
    .join("")
    .replaceAll(/[<>:"/\\|?*]/gu, "")
    .replace(/[. ]+$/u, "")
    .slice(0, 250) || "Song";
export const downloadFile = (
  filename: string,
  data: Blob | BlobPart,
  type = "application/octet-stream",
): void => {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
};
