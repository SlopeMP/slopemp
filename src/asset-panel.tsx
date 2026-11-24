import { createMemo, createSignal, Index, Show } from "solid-js";
import type { JSX } from "solid-js";

import {
  assetUrlError,
  createAssetDraft,
  isSupportedAssetUrl,
  validateAssetFrameRanges,
} from "./asset-draft";
import { copyFavoriteAsset, sameAssetSettings, validateFavorites } from "./asset-favorites";
import { AssetFavoritesPanel } from "./asset-favorites-panel";
import { AssetFields } from "./asset-fields";
import { Icon } from "./icons";
import type { Resource, Song } from "./model";
import { required, uid, validateSong } from "./model";
import type { AssetLoadResult, AssetView } from "./resource-identity";
import { customAudioAssetCount, MAX_CUSTOM_AUDIO_ASSETS } from "./resource-identity";

type Props = {
  readonly song: Song;
  readonly assets: readonly AssetView[];
  readonly favorites: readonly Resource[];
  readonly showFavorites: boolean;
  readonly onViewFavorites: () => void;
  readonly onViewAssets: () => void;
  readonly onFavoritesChange: (favorites: Resource[]) => void;
  readonly onChange: (resources: Resource[], loaded: ReadonlyMap<string, AssetLoadResult>) => void;
  readonly onStatus: (message: string) => void;
};
const statusLabels = {
  error: "Error",
  loading: "Loading…",
  ready: "Ready",
  unloaded: "Unresolved",
};

const validateSongAssetCount = (assets: readonly Resource[]): void => {
  if (customAudioAssetCount(assets) > MAX_CUSTOM_AUDIO_ASSETS) {
    throw new Error(`The song can hold up to ${MAX_CUSTOM_AUDIO_ASSETS} audio samples.`);
  }
};

export const AssetPanel = (props: Props): JSX.Element => {
  const draft = createAssetDraft(props.song.resources, () => props.assets);
  const [applying, setApplying] = createSignal(false);
  const findFavorite = (asset: Resource): Resource | undefined =>
    props.favorites.find((favorite) => sameAssetSettings(favorite, asset));
  const toggleFavorite = (entry: AssetView, resource: Resource): void => {
    const saved = findFavorite(resource);
    if (saved !== undefined) {
      props.onFavoritesChange(props.favorites.filter((favorite) => favorite.id !== saved.id));
      return;
    }
    try {
      const favorite = copyFavoriteAsset(resource);
      if (!isSupportedAssetUrl(favorite.url)) {
        throw new Error(assetUrlError);
      }
      validateAssetFrameRanges([entry]);
      const next = [...props.favorites, favorite];
      validateFavorites(next);
      props.onFavoritesChange(next);
    } catch (error) {
      props.onStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const insertFavorite = (favorite: Resource): void => {
    const copy = copyFavoriteAsset(favorite);
    try {
      validateSongAssetCount([...draft.entries().filter((entry) => entry.url.trim()), copy]);
      draft.append(copy);
      props.onViewAssets();
    } catch (error) {
      props.onStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const apply = async (): Promise<void> => {
    props.onStatus("");
    setApplying(true);
    try {
      if (!(await draft.resolve())) {
        return;
      }
      const next = draft.entries();
      validateSongAssetCount(next);
      validateAssetFrameRanges(draft.rows());
      validateSong({ ...props.song, resources: next });
      props.onChange(next, draft.installPrepared());
    } catch (error) {
      props.onStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Show
      when={props.showFavorites}
      fallback={
        <>
          <Index each={draft.rows()}>
            {(entry, index) => {
              const favorited = createMemo(() => findFavorite(entry()) !== undefined);
              return (
                <section class="resource-entry">
                  <header>
                    <strong>{entry().name}</strong>
                    <span class="hint">{statusLabels[entry().status]}</span>
                    <button
                      type="button"
                      class="control small"
                      aria-label={`Retry ${entry().name}`}
                      title="Download this asset again"
                      disabled={
                        applying() ||
                        entry().status === "loading" ||
                        !isSupportedAssetUrl(entry().url.trim())
                      }
                      onClick={() => {
                        draft.retry(entry());
                      }}
                    >
                      <Icon name="refresh" />
                    </button>
                    <button
                      type="button"
                      class="control small toggle-button"
                      aria-label={`Favorite ${entry().name}`}
                      aria-pressed={favorited()}
                      title={
                        favorited()
                          ? "Remove this asset from favorites"
                          : "Save this asset to favorites"
                      }
                      disabled={applying() || !entry().url.trim()}
                      onClick={() => {
                        toggleFavorite(entry(), required(draft.entries()[index]));
                      }}
                    >
                      <Icon name={favorited() ? "star-filled" : "star"} />
                    </button>
                    <button
                      type="button"
                      class="control small"
                      aria-label={`Move ${entry().name} up`}
                      title="Move this asset up"
                      disabled={applying() || index === 0}
                      onClick={() => {
                        draft.move(index, -1);
                      }}
                    >
                      <Icon name="arrow-up" />
                    </button>
                    <button
                      type="button"
                      class="control small"
                      aria-label={`Move ${entry().name} down`}
                      title="Move this asset down"
                      disabled={applying() || index === draft.entries().length - 1}
                      onClick={() => {
                        draft.move(index, 1);
                      }}
                    >
                      <Icon name="arrow-down" />
                    </button>
                    <button
                      type="button"
                      class="control small danger"
                      aria-label={`Remove ${entry().name}`}
                      title="Remove this asset from the song"
                      disabled={applying()}
                      onClick={() => {
                        draft.remove(entry().id);
                      }}
                    >
                      <Icon name="x" />
                    </button>
                  </header>
                  <AssetFields entry={entry} index={index} draft={draft} disabled={applying()} />
                </section>
              );
            }}
          </Index>
          <div class="dialog-actions asset-dialog-actions">
            <button
              type="button"
              class="control"
              disabled={applying()}
              onClick={props.onViewFavorites}
            >
              <Icon name="star" leading />
              View Favorites
            </button>
            <button
              type="button"
              class="control"
              disabled={applying()}
              onClick={() => {
                draft.append({ id: uid(), url: "" });
              }}
            >
              <Icon name="plus" leading />
              Add Asset
            </button>
            <button
              type="button"
              class="control accent"
              disabled={applying()}
              onClick={() => void apply()}
            >
              <Icon name="check" leading />
              Okay
            </button>
          </div>
        </>
      }
    >
      <AssetFavoritesPanel
        favorites={props.favorites}
        inSong={(favorite) => draft.entries().some((entry) => sameAssetSettings(entry, favorite))}
        onInsert={insertFavorite}
        onChange={props.onFavoritesChange}
        onBack={props.onViewAssets}
        onStatus={props.onStatus}
      />
    </Show>
  );
};
