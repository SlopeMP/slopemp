import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";

import { createAssetDraft, validateAssetFrameRanges } from "./asset-draft";
import {
  copyFavoriteAsset,
  createDefaultAssetFavorite,
  hasDefaultAssetFavorite,
  sameAssetSettings,
  validateFavorites,
} from "./asset-favorites";
import { AssetFields } from "./asset-fields";
import { Icon } from "./icons";
import type { Resource } from "./model";
import { required } from "./model";
import type { AssetView } from "./resource-identity";
import { assetView } from "./resource-identity";

type EditorProps = {
  readonly asset: Resource;
  readonly onSave: (asset: Resource) => void;
  readonly onCancel: () => void;
  readonly onStatus: (message: string) => void;
};
const FavoriteEditor = (props: EditorProps): JSX.Element => {
  const draft = createAssetDraft([], () => []);
  draft.append(props.asset);
  const entry = (): AssetView => required(draft.rows()[0]);
  const [saving, setSaving] = createSignal(false);
  let editor: HTMLElement | null = null;
  onMount(() => {
    draft.loadOnBlur(entry());
    editor?.querySelector("input")?.focus();
  });
  const save = async (): Promise<void> => {
    props.onStatus("");
    setSaving(true);
    try {
      if (await draft.resolve()) {
        validateAssetFrameRanges(draft.rows());
        props.onSave(copyFavoriteAsset(required(draft.entries()[0]), props.asset.id));
      }
    } catch (error) {
      props.onStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <section
        class="resource-entry"
        ref={(element) => {
          editor = element;
        }}
      >
        <header>
          <strong>{entry().name}</strong>
          {entry().status === "loading" && <span class="hint">Loading…</span>}
        </header>
        <AssetFields
          entry={entry}
          index={0}
          draft={draft}
          disabled={saving()}
          urlDisabled={saving()}
        />
      </section>
      <div class="dialog-actions asset-dialog-actions">
        <button type="button" class="control" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="button"
          class="control accent"
          disabled={saving()}
          onClick={() => void save()}
        >
          <Icon name="check" leading />
          Save Favorite
        </button>
      </div>
    </>
  );
};

type Props = {
  readonly favorites: readonly Resource[];
  readonly inSong: (asset: Resource) => boolean;
  readonly onInsert: (asset: Resource) => void;
  readonly onChange: (favorites: Resource[]) => void;
  readonly onBack: () => void;
  readonly onStatus: (message: string) => void;
};
export const AssetFavoritesPanel = (props: Props): JSX.Element => {
  const [editing, setEditing] = createSignal<Resource>();
  const finishEditing = (): void => {
    props.onStatus("");
    setEditing(undefined);
  };
  const save = (asset: Resource): void => {
    if (
      props.favorites.some(
        (favorite) => favorite.id !== asset.id && sameAssetSettings(favorite, asset),
      )
    ) {
      throw new Error("These asset settings are already saved in Favorites.");
    }
    const next = props.favorites.map((favorite) => (favorite.id === asset.id ? asset : favorite));
    validateFavorites(next);
    props.onChange(next);
    finishEditing();
  };
  return (
    <Show
      when={editing()}
      keyed
      fallback={
        <>
          <For each={props.favorites} fallback={<p>No favorite assets yet.</p>}>
            {(favorite, index) => {
              const entry = assetView(favorite);
              const inSong = createMemo(() => props.inSong(favorite));
              return (
                <section class="resource-entry">
                  <header>
                    <strong>{entry.name}</strong>
                    {inSong() && <span class="hint">In Song</span>}
                    <button
                      type="button"
                      class="control small"
                      aria-label="Add to Song"
                      title={inSong() ? "Already in the song" : "Add to Song"}
                      disabled={inSong()}
                      onClick={() => {
                        props.onInsert(favorite);
                      }}
                    >
                      <Icon name={inSong() ? "check" : "plus"} />
                    </button>
                    <button
                      type="button"
                      class="control small"
                      aria-label={`Edit ${entry.name}`}
                      title="Edit this favorite"
                      onClick={() => {
                        props.onStatus("");
                        setEditing(favorite);
                      }}
                    >
                      <Icon name="pencil" />
                    </button>
                    <button
                      type="button"
                      class="control small danger"
                      aria-label={`Remove ${entry.name} from favorites`}
                      title="Remove this favorite"
                      onClick={() => {
                        props.onChange(props.favorites.filter((asset) => asset.id !== favorite.id));
                      }}
                    >
                      <Icon name="x" />
                    </button>
                  </header>
                  <AssetFields entry={() => entry} index={index()} />
                </section>
              );
            }}
          </For>
          <div class="dialog-actions asset-dialog-actions">
            <button
              type="button"
              class="control"
              disabled={hasDefaultAssetFavorite(props.favorites)}
              onClick={() => {
                props.onChange([...props.favorites, createDefaultAssetFavorite()]);
              }}
            >
              <Icon name="restore" leading />
              Restore Defaults
            </button>
            <button type="button" class="control" onClick={props.onBack}>
              Back to Add Assets
            </button>
          </div>
        </>
      }
    >
      {(favorite) => (
        <FavoriteEditor
          asset={favorite}
          onSave={save}
          onCancel={finishEditing}
          onStatus={props.onStatus}
        />
      )}
    </Show>
  );
};
