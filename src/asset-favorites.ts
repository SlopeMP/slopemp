import { packMessage, unpackMessage } from "@slopemp/song/protobuf";

import { FLUID_R3_MONO } from "./bundled-resources";
import { AssetFavoritesSchema } from "./generated/asset-favorites_pb";
import { readStoredValue, writeStoredValue } from "./indexed-storage";
import type { Resource } from "./model";
import { uid, validateResources } from "./model";
import { customAudioAssetCount, MAX_CUSTOM_AUDIO_ASSETS } from "./resource-identity";

export const copyFavoriteAsset = ({ metadata, ...asset }: Resource, id = uid()): Resource => ({
  ...asset,
  id,
  url: asset.url.trim(),
  ...(metadata?.license !== undefined && { metadata: { license: metadata.license } }),
});

export const sameAssetSettings = (a: Resource, b: Resource): boolean =>
  a.url.trim() === b.url.trim() &&
  (a.rootKey ?? 60) === (b.rootKey ?? 60) &&
  (a.start ?? 0) === (b.start ?? 0) &&
  (a.loopStart ?? 0) === (b.loopStart ?? 0) &&
  a.loopEnd === b.loopEnd &&
  (a.mode ?? "Loop") === (b.mode ?? "Loop") &&
  (a.backwards ?? false) === (b.backwards ?? false);

export const createDefaultAssetFavorite = (): Resource => copyFavoriteAsset(FLUID_R3_MONO);

export const hasDefaultAssetFavorite = (favorites: readonly Resource[]): boolean =>
  favorites.some((favorite) => sameAssetSettings(favorite, FLUID_R3_MONO));

export const validateFavorites = (favorites: readonly Resource[]): void => {
  validateResources(favorites);
  if (customAudioAssetCount(favorites) > MAX_CUSTOM_AUDIO_ASSETS) {
    throw new Error(`Favorites can hold up to ${MAX_CUSTOM_AUDIO_ASSETS} audio samples.`);
  }
};

// The protobuf schema checks scalar types. Identity and URL must also be present.
const hasResourceIdentity = (value: unknown): value is Resource =>
  value !== null &&
  typeof value === "object" &&
  "id" in value &&
  typeof value.id === "string" &&
  "url" in value &&
  typeof value.url === "string";

export const loadAssetFavorites = async (): Promise<Resource[]> => {
  const value = await readStoredValue("asset-favorites");
  if (value === undefined) {
    return [createDefaultAssetFavorite()];
  }
  if (!(value instanceof Uint8Array)) {
    throw new TypeError("Invalid stored asset favorites.");
  }
  const parsed = unpackMessage(AssetFavoritesSchema, value);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("resources" in parsed) ||
    !Array.isArray(parsed.resources) ||
    !parsed.resources.every(hasResourceIdentity)
  ) {
    throw new TypeError("Invalid stored asset favorites.");
  }
  validateFavorites(parsed.resources);
  return parsed.resources;
};

export const saveAssetFavorites = async (favorites: readonly Resource[]): Promise<boolean> => {
  try {
    validateFavorites(favorites);
    const value = packMessage(AssetFavoritesSchema, { version: 1, resources: [...favorites] });
    await writeStoredValue("asset-favorites", value);
    return true;
  } catch {
    return false;
  }
};
