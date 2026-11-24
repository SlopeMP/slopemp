import type { Song } from "./model";

export const audioResourceIds = (song: Song, channelIds?: ReadonlySet<string>): Set<string> => {
  const ids = new Set<string>();
  for (const channel of song.channels) {
    if (channel.kind !== "track" || (channelIds && !channelIds.has(channel.id))) {
      continue;
    }
    for (const instrument of channel.instruments) {
      if (
        instrument.resourceId &&
        (instrument.type === "SoundFont" || instrument.type === "chip wave")
      ) {
        ids.add(instrument.resourceId);
      }
    }
  }
  return ids;
};
