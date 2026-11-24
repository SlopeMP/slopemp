import {
  copyFavoriteAsset,
  createDefaultAssetFavorite,
  loadAssetFavorites,
  sameAssetSettings,
} from "./asset-favorites";
import { createSong, History, uid } from "./model";
import type { Resource, Song } from "./model";
import { readPreferences } from "./preferences";
import type { Preferences } from "./preferences";
import type { HistoryCollaboration } from "./song-history";
import { decodeSong, encodeSong, readStoredSession } from "./storage";

type Position = {
  session: string;
  index: number;
  first: number;
  last: number;
};
type Entry = Position & { version: 1; url: string; data: string };
const newPosition = (): Position => ({ session: uid(), index: 0, first: 0, last: 0 });

const readBrowserEntry = (): { position: Position; song: Song; data: string } | null => {
  const state: unknown = globalThis.history.state;
  if (state === null || typeof state !== "object" || !("slopemp" in state)) {
    return null;
  }
  const entry: unknown = state.slopemp;
  if (
    entry === null ||
    typeof entry !== "object" ||
    !("version" in entry && entry.version === 1) ||
    !("session" in entry && typeof entry.session === "string") ||
    !("index" in entry && typeof entry.index === "number" && Number.isSafeInteger(entry.index)) ||
    !("first" in entry && typeof entry.first === "number" && Number.isSafeInteger(entry.first)) ||
    !("last" in entry && typeof entry.last === "number" && Number.isSafeInteger(entry.last)) ||
    entry.first < 0 ||
    entry.index < entry.first ||
    entry.last < entry.index ||
    !("url" in entry && entry.url === location.href) ||
    !("data" in entry && typeof entry.data === "string")
  ) {
    return null;
  }
  try {
    const { session, index, first, last, data } = entry;
    return {
      position: { session, index, first, last },
      data,
      song: decodeSong(data),
    };
  } catch {
    return null;
  }
};

// Each browser entry owns one committed song, never the whole undo stack. Undo/redo
// traverse those entries, including after reload and when song URLs are disabled.
class BrowserHistory extends History {
  private position: Position;
  private songInURL: boolean;
  private available = true;
  private navigating = false;
  private onError: ((message: string) => void) | null = null;
  private onRestore: (() => void) | null = null;

  public constructor(song: Song, songInURL: boolean, position = newPosition()) {
    super(song);
    this.position = position;
    this.songInURL = songInURL;
  }

  public override get canUndo(): boolean {
    return this.available && !this.collaborative
      ? this.position.index > this.position.first
      : super.canUndo;
  }
  public override get canRedo(): boolean {
    return this.available && !this.collaborative
      ? this.position.index < this.position.last
      : super.canRedo;
  }

  public connect(onRestore: () => void, onError: (message: string) => void): () => void {
    this.onRestore = onRestore;
    this.onError = onError;
    globalThis.addEventListener("popstate", this.pop);
    this.save(false);
    return () => {
      globalThis.removeEventListener("popstate", this.pop);
    };
  }

  public setSongInURL(enabled: boolean): void {
    if (this.songInURL !== enabled) {
      this.songInURL = enabled;
      this.save(false);
    }
  }

  public override beginCollaboration(song: Song, collaboration: HistoryCollaboration): void {
    this.position = newPosition();
    super.beginCollaboration(song, collaboration);
    this.save(true);
  }

  public override endCollaboration(song: Song): void {
    this.position = newPosition();
    super.endCollaboration(song);
    this.save(false);
  }

  public saveCollaborativeSong(): void {
    if (this.collaborative) {
      this.save(false);
    }
  }

  public override undo(): boolean {
    if (!this.available || this.collaborative) {
      return super.undo();
    }
    return this.navigate(-1);
  }
  public override redo(): boolean {
    if (!this.available || this.collaborative) {
      return super.redo();
    }
    return this.navigate(1);
  }

  protected override onCommit(): void {
    if (!this.collaborative) {
      this.position.index++;
      this.position.last = this.position.index;
    }
    this.save(!this.collaborative);
  }

  private navigate(direction: number): boolean {
    this.cancelPreview();
    if (this.navigating || (direction < 0 ? !this.canUndo : !this.canRedo)) {
      return false;
    }
    this.navigating = true;
    try {
      globalThis.history.go(direction);
      return true;
    } catch {
      this.navigating = false;
      this.available = false;
      return direction < 0 ? super.undo() : super.redo();
    }
  }

  private save(push: boolean): void {
    if (!this.available) {
      return;
    }
    try {
      const url = new URL(location.href);
      const data = encodeSong(this.committedSong);
      url.hash = this.songInURL ? data : "";
      const { position } = this;
      const entry: Entry = { ...position, version: 1, url: url.href, data };
      if (push) {
        globalThis.history.pushState({ slopemp: entry }, "", url);
      }
      // Browsers evict their oldest entries once the tab reaches its history limit.
      position.first = Math.max(position.first, position.last - globalThis.history.length + 1);
      if (!push || entry.first !== position.first) {
        entry.first = position.first;
        globalThis.history.replaceState({ slopemp: entry }, "", url);
      }
    } catch {
      this.available = false;
      this.onError?.(
        "The browser could not save editing history. Export a file to keep your work.",
      );
    }
  }

  private readonly pop = (): void => {
    this.navigating = false;
    if (this.collaborative) {
      const entry = readBrowserEntry();
      if (entry?.position.session === this.position.session) {
        this.save(false);
      } else {
        globalThis.history.forward();
      }
      return;
    }
    try {
      const entry = readBrowserEntry();
      if (entry?.position.session === this.position.session) {
        const distance = entry.position.index - this.position.index;
        this.position.index = entry.position.index;
        for (let step = 0; step < Math.abs(distance); step++) {
          if (!(distance < 0 ? super.undo() : super.redo())) {
            break;
          }
        }
        if (encodeSong(this.song) !== entry.data) {
          this.restore(entry.song);
          this.onRestore?.();
        }
      } else {
        const song = entry?.song ?? decodeSong(location.hash.slice(1));
        this.position = entry?.position ?? newPosition();
        this.restore(song);
        this.onRestore?.();
      }
      this.save(false);
    } catch (error) {
      this.available = false;
      this.onError?.(
        `Unable to restore browser history. The current edit is preserved. ${String(error)}`,
      );
    }
  };
}

export type EditorStartup = {
  preferences: Preferences;
  history: BrowserHistory;
  favorites: Resource[];
  favoritesError: string;
  error: string;
};

export const createBlankSong = (preferences: Preferences, favorites: readonly Resource[]): Song => {
  const song = createSong(preferences.defaultScale, preferences.defaultCustomScale);
  song.resources = song.resources.filter((resource) =>
    favorites.some((favorite) => sameAssetSettings(resource, favorite)),
  );
  const additions = favorites.filter(
    (favorite) => !song.resources.some((resource) => sameAssetSettings(resource, favorite)),
  );
  song.resources.push(...additions.map((favorite) => copyFavoriteAsset(favorite)));
  return song;
};

export const loadEditor = async (): Promise<EditorStartup> => {
  const preferences = await readPreferences();
  let entry: ReturnType<typeof readBrowserEntry> = null;
  let song: Song | null = null;
  let message = "";
  try {
    entry = readBrowserEntry();
    song = entry?.song ?? (location.hash.length > 1 ? decodeSong(location.hash) : null);
  } catch (error) {
    message = `Could not load song: ${String(error)}`;
  }
  if (song === null) {
    try {
      song = await readStoredSession();
    } catch (error) {
      if (message === "") {
        message = `Could not load song: ${String(error)}`;
      }
    }
  }
  let favoritesError = "";
  const favorites = await loadAssetFavorites().catch((error: unknown) => {
    favoritesError = `Could not load asset favorites: ${String(error)}`;
    return [createDefaultAssetFavorite()];
  });
  song ??= createBlankSong(preferences, favorites);
  return {
    preferences,
    history: new BrowserHistory(song, preferences.songInUrl, entry?.position),
    favorites,
    favoritesError,
    error: message,
  };
};
