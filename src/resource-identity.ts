import type { Resource } from "./model";
import type { SoundFontPreset } from "./synth/soundfont-file";

export type AssetLoadResult = SoundFontPreset[] | number;
export type AssetLoadState =
  | { status: "error"; error: string }
  | { status: "loading" }
  | { status: "ready"; result: AssetLoadResult };
export type AssetView = Resource & {
  name: string;
  type: "audio" | "soundfont";
  status: AssetLoadState["status"] | "unloaded";
  frames?: number;
  presets?: SoundFontPreset[];
  error?: string;
};

const assetFilename = (url: string): string => {
  const pathname = URL.parse(url)?.pathname ?? url.split(/[?#]/u, 1)[0] ?? "";
  const segment = pathname.split("/").at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export const assetName = (url: string): string => {
  const filename = assetFilename(url);
  const extension = filename.lastIndexOf(".");
  return (extension > 0 ? filename.slice(0, extension) : filename) || "Untitled asset";
};

export const assetType = (url: string): AssetView["type"] =>
  /\.sf[23]$/iu.test(assetFilename(url)) ? "soundfont" : "audio";

export const MAX_CUSTOM_AUDIO_ASSETS = 64;
export const customAudioAssetCount = (resources: readonly Resource[]): number =>
  resources.filter(
    (resource) => assetType(resource.url) === "audio" && resource.metadata?.bundled !== true,
  ).length;

export const resourceCacheKey = (resource: Resource): string =>
  `resource-cache:${JSON.stringify([resource.id, resource.url, resource.metadata?.revision ?? ""])}`;

export const assetView = (resource: Resource, state?: AssetLoadState): AssetView => {
  const view: AssetView = {
    ...resource,
    name: assetName(resource.url),
    type: assetType(resource.url),
    status: state?.status ?? "unloaded",
  };
  if (state?.status === "ready") {
    if (typeof state.result === "number") {
      view.frames = state.result;
    } else {
      view.presets = state.result;
    }
  } else if (state?.status === "error") {
    view.error = state.error;
  }
  return view;
};
