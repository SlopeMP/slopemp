import type { Song } from "@slopemp/song";

export * from "@slopemp/song";
export { History, isSnapshot } from "./song-history";

export type Selection = {
  channelStart: number;
  channelEnd: number;
  barStart: number;
  barEnd: number;
  timeStart?: number;
  timeEnd?: number;
};
export type SongRecipe = (song: Song) => void;
