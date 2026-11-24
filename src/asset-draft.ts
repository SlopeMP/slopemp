import { batch, createMemo, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

import { loadAsset } from "./asset-cache";
import { installAudioResourceAlias, removeAudioResource } from "./audio";
import type { Resource } from "./model";
import { required, uid } from "./model";
import type { AssetLoadResult, AssetLoadState, AssetView } from "./resource-identity";
import { assetType, assetView, resourceCacheKey } from "./resource-identity";

type PreparedAsset = {
  temporaryId: string;
  controller: AbortController;
  ready: Promise<void>;
};
type PreviewState = AssetLoadState | { status: "unloaded" };

export const assetUrlError = "Use an http or https URL, or start with ./ for a relative URL.";
export const isSupportedAssetUrl = (url: string): boolean => {
  const address = URL.parse(url, url.startsWith("./") ? document.baseURI : undefined);
  return address?.protocol === "http:" || address?.protocol === "https:";
};

export type AssetDraft = {
  append: (entry: Resource) => void;
  changeUrl: (entry: Resource, url: string) => void;
  entries: Accessor<Resource[]>;
  installPrepared: () => ReadonlyMap<string, AssetLoadResult>;
  loadOnBlur: (entry: Resource) => void;
  move: (index: number, offset: -1 | 1) => void;
  remove: (id: string) => void;
  resolve: () => Promise<boolean>;
  retry: (entry: Resource) => void;
  rows: Accessor<AssetView[]>;
  update: (id: string, recipe: (entry: Resource) => void) => void;
};

export const createAssetDraft = (
  initial: Resource[],
  assets: Accessor<readonly AssetView[]>,
): AssetDraft => {
  const [entries, setEntries] = createSignal(initial);
  const [previews, setPreviews] = createSignal(new Map<string, PreviewState>());
  const savedAssets = createMemo(() => new Map(assets().map((asset) => [asset.id, asset])));
  const rows = createMemo(() =>
    entries().map((entry) => {
      const preview = previews().get(entry.id);
      if (preview === undefined) {
        const saved = savedAssets().get(entry.id);
        return saved?.url === entry.url ? { ...saved, ...entry } : assetView(entry);
      }
      return assetView(entry, preview.status === "unloaded" ? undefined : preview);
    }),
  );
  const prepared = new Map<string, PreparedAsset>();
  let closed = false;

  const discardPrepared = (id: string): void => {
    const previous = prepared.get(id);
    if (previous !== undefined) {
      prepared.delete(id);
      previous.controller.abort();
      removeAudioResource(previous.temporaryId);
    }
  };
  onCleanup(() => {
    closed = true;
    for (const id of prepared.keys()) {
      discardPrepared(id);
    }
  });
  const setPreview = (id: string, state: PreviewState): void => {
    setPreviews((previous) => new Map(previous).set(id, state));
  };
  const update = (id: string, recipe: (entry: Resource) => void): void => {
    setEntries((previous) =>
      previous.map((entry) => {
        if (entry.id !== id) {
          return entry;
        }
        const copy = { ...entry };
        recipe(copy);
        return copy;
      }),
    );
  };
  const move = (index: number, offset: -1 | 1): void => {
    setEntries((previous) => {
      const next = [...previous];
      const destination = index + offset;
      [next[index], next[destination]] = [required(next[destination]), required(next[index])];
      return next;
    });
  };
  const append = (entry: Resource): void => {
    setPreview(entry.id, { status: "unloaded" });
    setEntries((previous) => [...previous, entry]);
  };
  const remove = (id: string): void => {
    discardPrepared(id);
    setPreviews((previous) => {
      const next = new Map(previous);
      next.delete(id);
      return next;
    });
    setEntries((previous) => previous.filter((entry) => entry.id !== id));
  };
  const changeUrl = (entry: Resource, url: string): void => {
    if (url === entry.url) {
      return;
    }
    discardPrepared(entry.id);
    batch(() => {
      setPreview(entry.id, { status: "unloaded" });
      update(entry.id, (draft) => {
        if (assetType(url) !== assetType(entry.url)) {
          delete draft.rootKey;
          delete draft.start;
          delete draft.loopStart;
          delete draft.mode;
          delete draft.backwards;
        }
        delete draft.loopEnd;
        delete draft.metadata;
        draft.url = url;
      });
    });
  };
  const prepare = async (
    entry: Resource,
    temporaryId: string,
    signal: AbortSignal,
    retry: boolean,
  ): Promise<void> => {
    try {
      const result = await loadAsset(temporaryId, entry.url.trim(), signal, retry);
      if (prepared.get(entry.id)?.temporaryId === temporaryId) {
        update(entry.id, (draft) => {
          draft.metadata = { ...draft.metadata, revision: uid() };
        });
        setPreview(entry.id, { status: "ready", result });
      }
    } catch (error) {
      if (prepared.get(entry.id)?.temporaryId === temporaryId) {
        prepared.delete(entry.id);
        removeAudioResource(temporaryId);
        setPreview(entry.id, { status: "error", error: String(error) });
      }
    }
  };
  const load = (entry: Resource, retry = false): void => {
    if (prepared.has(entry.id)) {
      return;
    }
    const url = entry.url.trim();
    if (!isSupportedAssetUrl(url)) {
      setPreview(entry.id, { status: "error", error: assetUrlError });
      return;
    }
    const temporaryId = `asset-preview-${uid()}`;
    const controller = new AbortController();
    prepared.set(entry.id, {
      temporaryId,
      controller,
      ready: prepare(entry, temporaryId, controller.signal, retry),
    });
    update(entry.id, (draft) => {
      draft.url = url;
    });
    setPreview(entry.id, { status: "loading" });
  };
  const loadOnBlur = (entry: Resource): void => {
    if (previews().get(entry.id)?.status === "unloaded" && entry.url.trim()) {
      load(entry);
    }
  };
  const retry = (entry: Resource): void => {
    discardPrepared(entry.id);
    load(entry, true);
  };
  const resolve = async (): Promise<boolean> => {
    await Promise.all(
      entries().map(async (entry) => {
        if (previews().get(entry.id)?.status === "unloaded") {
          load(entry);
        }
        await prepared.get(entry.id)?.ready;
      }),
    );
    return !closed && [...previews().values()].every((preview) => preview.status === "ready");
  };
  const installPrepared = (): ReadonlyMap<string, AssetLoadResult> => {
    const loaded = new Map<string, AssetLoadResult>();
    for (const entry of entries()) {
      const temporaryId = prepared.get(entry.id)?.temporaryId;
      const preview = previews().get(entry.id);
      if (temporaryId !== undefined && preview?.status === "ready") {
        const key = resourceCacheKey(entry);
        installAudioResourceAlias(temporaryId, key);
        loaded.set(key, preview.result);
      }
    }
    return loaded;
  };
  return {
    append,
    changeUrl,
    entries,
    installPrepared,
    loadOnBlur,
    move,
    remove,
    resolve,
    retry,
    rows,
    update,
  };
};

export const validateAssetFrameRanges = (entries: readonly AssetView[]): void => {
  for (const entry of entries) {
    const { frames } = entry;
    if (
      frames !== undefined &&
      ((entry.loopStart ?? 0) >= (entry.loopEnd ?? frames) ||
        (entry.loopEnd ?? frames) > frames ||
        (entry.start ?? 0) >= frames)
    ) {
      throw new Error(`Invalid loop or start position for ${entry.name}.`);
    }
  }
};
