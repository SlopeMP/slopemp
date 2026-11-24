import { loadAudioResource } from "./audio";
import { createIndexedStore } from "./indexed-storage";
import type { AssetLoadResult } from "./resource-identity";
import { assetType } from "./resource-identity";
import { loadSoundFont } from "./soundfont-loader";

const cache = createIndexedStore("slopemp-assets", "assets");
const incomplete = "Asset download did not finish. Use Retry to download it again.";
const pending = new Map<string, Promise<ArrayBuffer>>();

const accessCache = async <Result>(access: () => Promise<Result>): Promise<Result> => {
  try {
    return await access();
  } catch (error) {
    throw new Error(`Asset cache error: ${String(error)}`, { cause: error });
  }
};

const download = async (url: string, retry: boolean, signal: AbortSignal): Promise<Blob> => {
  const response = await fetch(url, { signal, cache: retry ? "reload" : "default" });
  if (!response.ok) {
    throw new Error(`Could not download asset (${response.status}).`);
  }
  return await response.blob();
};

const loadAssetData = async (
  source: string,
  retry: boolean,
  signal: AbortSignal,
): Promise<ArrayBuffer> => {
  const address = new URL(source, document.baseURI);
  address.hash = "";
  const url = address.href;
  const readOrDownload = async (): Promise<ArrayBuffer> => {
    signal.throwIfAborted();
    if (!retry) {
      const cached = await accessCache(async () => await cache.read(url));
      signal.throwIfAborted();
      if (cached instanceof Blob) {
        return await cached.arrayBuffer();
      }
      if (cached !== undefined) {
        throw new Error(cached === incomplete ? incomplete : "Invalid cached asset data.");
      }
      // Reserve the miss before fetching. If saving the bytes fails, another load
      // will require a manual retry instead of downloading them again.
      await accessCache(async () => {
        await cache.write(url, incomplete);
      });
    }
    const blob = await download(url, retry, signal).catch(async (error: unknown) => {
      if (signal.aborted && !retry) {
        await accessCache(async () => {
          await cache.remove(url);
        });
      }
      throw error;
    });
    // Store every download as a Blob so large assets avoid inline serialization in IndexedDB.
    await accessCache(async () => {
      await cache.write(url, blob);
    });
    return await blob.arrayBuffer();
  };

  // Keep the lookup and the download together so simultaneous loads of the same
  // URL share a single cache fill, even across tabs when Web Locks are available.
  if (globalThis.isSecureContext && "locks" in navigator) {
    return await navigator.locks.request(`slopemp-asset:${url}`, { signal }, readOrDownload);
  }
  const previous = pending.get(url);
  const loading = (async (): Promise<ArrayBuffer> => {
    if (previous !== undefined) {
      await Promise.allSettled([previous]);
    }
    return await readOrDownload();
  })();
  pending.set(url, loading);
  try {
    return await loading;
  } finally {
    if (pending.get(url) === loading) {
      pending.delete(url);
    }
  }
};

export const loadAsset = async (
  id: string,
  url: string,
  signal: AbortSignal,
  retry = false,
): Promise<AssetLoadResult> => {
  const read = async (): Promise<ArrayBuffer> => await loadAssetData(url, retry, signal);
  return assetType(url) === "soundfont"
    ? await loadSoundFont(id, read, signal)
    : await loadAudioResource(id, await read(), signal);
};
