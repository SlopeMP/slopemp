import { createTransaction } from "@slopemp/song";
import type { EditPath } from "@slopemp/song";
import type { EditorLockScope } from "@slopemp/song/protocol";
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

import { loadAsset } from "./asset-cache";
import { saveAssetFavorites } from "./asset-favorites";
import { AssetLoads } from "./asset-loads";
import { AssetPanel } from "./asset-panel";
import { AudioEngine, installAudioResourceAlias, removeAudioResource } from "./audio";
import { renderMp3, renderWav } from "./audio-export";
import { createBlankSong } from "./browser-history";
import type { EditorStartup } from "./browser-history";
import { ChannelEditor } from "./channel-editor";
import { DeferredTask } from "./deferred-task";
import { colorsForChannel } from "./editor-geometry";
import { DrawingLock, NumericInput, SelectWrap, Setting } from "./editors";
import * as formats from "./formats";
import { HelpDialogContent } from "./help-dialog";
import { Icon } from "./icons";
import { AutomationPanel, InstrumentPanel } from "./instrument-panel";
import type { Effect, Instrument } from "./instruments";
import { keyActionForEvent } from "./keybindings";
import { createMetronome, exportMidi, importMidi, MidiInput, PerformanceRecorder } from "./midi";
import type { Metronome } from "./midi";
import { clamp, clone, required, scalePitches, scales, trackOctave } from "./model";
import type { Resource, Selection, Song, SongRecipe } from "./model";
import { MultiplayerClient } from "./multiplayer";
import type { MultiplayerEvent, MultiplayerState } from "./multiplayer";
import { connectionLabel, MultiplayerDialog } from "./multiplayer-dialog";
import * as ops from "./operations";
import { PatternEditor } from "./pattern-editor";
import type { TimeSelection } from "./pattern-editor";
import { keyboardPitch, savePreferences } from "./preferences";
import type { Preferences } from "./preferences";
import { PreferencesDialogContent } from "./preferences-dialog";
import { randomInstrument, randomPreset } from "./random-instruments";
import { assetView, resourceCacheKey } from "./resource-identity";
import type { AssetLoadState } from "./resource-identity";
import * as storage from "./storage";
type Dialog =
  | "assets"
  | "channel-settings"
  | "copy-url"
  | "custom-scale"
  | "export"
  | "favorites"
  | "help"
  | "import"
  | "layout"
  | "multiplayer"
  | "preferences"
  | "sideways"
  | null;
const noteNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const pitchNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const emptySelection = (channel: number, bar: number): Selection => ({
  channelStart: channel,
  channelEnd: channel,
  barStart: bar,
  barEnd: bar,
});
const editorColors = (
  index: number,
): JSX.CSSProperties & {
  "--note-color": string;
} => ({
  "--note-color": colorsForChannel(index).note,
});
const editableTarget = (event: KeyboardEvent): boolean => {
  const { target } = event;
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  if (!(target instanceof HTMLInputElement)) {
    return false;
  }
  if (target.type === "range") {
    return [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ].includes(event.key);
  }
  if (target.type === "checkbox") {
    return false;
  }
  if (target.type === "number") {
    if (
      (event.ctrlKey || event.metaKey) &&
      ["a", "c", "v", "x"].includes(event.key.toLowerCase())
    ) {
      return true;
    }
    return (
      /^[0-9]$/u.test(event.key) ||
      [
        "Backspace",
        "Delete",
        "Enter",
        "Home",
        "End",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        ".",
        ",",
        "-",
        "+",
      ].includes(event.key)
    );
  }
  return true;
};
const Actions = ({
  onOkay,
  onCancel,
}: {
  readonly onOkay: () => void;
  readonly onCancel: () => void;
}): JSX.Element => {
  return (
    <div class="dialog-actions">
      <button
        type="button"
        data-confirm
        class="control accent"
        title="Apply these changes"
        onClick={onOkay}
      >
        <Icon name="check" leading />
        Okay
      </button>
      <button type="button" class="control" title="Discard these changes" onClick={onCancel}>
        <Icon name="x" leading />
        Cancel
      </button>
    </div>
  );
};
// Fill the viewport with pattern, channel and settings areas; narrow layouts stack them.
// Ordinary dialogs pause/resume playback and return focus to the editor when closed.
// Preferences and Help allow playback; recording disables every control except Stop Recording.
export const App = (initial: EditorStartup): JSX.Element => {
  const [prefs, setPrefs] = createSignal(initial.preferences);
  const { history } = initial;
  const [song, setSong] = createSignal(history.song);
  const [favorites, setFavorites] = createSignal(initial.favorites);
  const resources = createMemo(() => song().resources);
  const [assetStates, setAssetStates] = createSignal(new Map<string, AssetLoadState>());
  const assets = createMemo(() =>
    resources().map((resource) =>
      assetView(resource, assetStates().get(resourceCacheKey(resource))),
    ),
  );
  const [current, setCurrent] = createSignal({
    channel: 0,
    bar: 0,
  });
  const [rectangle, setRectangle] = createSignal<Selection>(emptySelection(0, 0));
  const [time, setTime] = createSignal<TimeSelection | null>(null);
  const [instrument, setInstrument] = createSignal(0);
  const [copiedEffect, setCopiedEffect] = createSignal<Effect | null>(null);
  const copyEffect = (effect: Effect): void => {
    setCopiedEffect(structuredClone(effect));
  };
  const [muted, setMuted] = createSignal<Set<string>>(new Set<string>());
  const [playing, setPlaying] = createSignal(false);
  const [position, setPosition] = createSignal({
    bar: 0,
    beat: 0,
  });
  const [dialog, setDialog] = createSignal<Dialog>(null);
  const assetDialogOpen = createMemo(() => dialog() === "assets" || dialog() === "favorites");
  const [assetDialogMessage, setAssetDialogMessage] = createSignal("");
  const [status, setStatus] = createSignal(initial.error || initial.favoritesError);
  const [control, setControl] = createSignal(false);
  const [recording, setRecording] = createSignal<"count-in" | "off" | "recording">("off");
  const [layoutDraft, setLayoutDraft] = createSignal(prefs().layout);
  const [customMask, setCustomMask] = createSignal<number[]>(song().customScale);
  const [offset, setOffset] = createSignal(0);
  const [strategy, setStrategy] = createSignal(prefs().sidewaysStrategy);
  const [fileName, setFileName] = createSignal("Song");
  const [format, setFormat] = createSignal(prefs().exportFormat);
  const [intro, setIntro] = createSignal(false);
  const [outro, setOutro] = createSignal(false);
  const [loopCount, setLoopCount] = createSignal(1);
  const [rendering, setRendering] = createSignal(false);
  const [rendered, setRendered] = createSignal<Blob | null>(null);
  const [copyUrl, setCopyUrl] = createSignal("");
  let engine: AudioEngine | null = null;
  let editor: HTMLElement | null = null;
  let dialogElement: HTMLDialogElement | null = null;
  let stopButton: HTMLButtonElement | null = null;
  let resumeOnClose = false;
  let pointer: {
    bar: number;
    beat: number;
  } | null = null;
  let digitEntry = {
    value: 0,
    cell: "",
  };
  const held = new Map<string, number>();
  let metronomeClock: {
    source: Metronome;
    lastBeat: number;
  } | null = null;
  let recordData: {
    recorder: PerformanceRecorder;
    timer: ReturnType<typeof setTimeout> | null;
    source: Song;
    lock: EditorLockScope | undefined;
  } | null = null;
  const [waitingForRecordingLock, setWaitingForRecordingLock] = createSignal(false);
  let joined = false;
  let interruptRecording: (() => void) | null = null;
  const readPlayhead = (): number => engine?.playhead ?? 0;
  let renderToken = 0;
  let exportAbort: AbortController | null = null;
  const [progress, setProgress] = createSignal(0);
  const resourceLoads = new AssetLoads();
  let wantedResources = new Map<string, string>();
  const activeResources = new Map<string, string>();
  let selectionEnd = {
    channel: current().channel,
    bar: current().bar,
  };
  const channelIndex = createMemo(() => Math.min(current().channel, song().channels.length - 1));
  const bar = createMemo(() => Math.min(current().bar, song().barCount - 1));
  const channel = createMemo(() => required(song().channels[channelIndex()]));
  const selectedInstrumentIndex = createMemo(() =>
    Math.min(instrument(), Math.max(0, channel().instruments.length - 1)),
  );
  const octave = createMemo(() => trackOctave(channel()));
  const selection = createMemo<Selection>(() => {
    const selectedTime = time();
    return {
      channelStart: Math.min(rectangle().channelStart, song().channels.length - 1),
      channelEnd: Math.min(rectangle().channelEnd, song().channels.length - 1),
      barStart: Math.min(rectangle().barStart, song().barCount - 1),
      barEnd: Math.min(rectangle().barEnd, song().barCount - 1),
      ...(selectedTime
        ? {
            timeStart: selectedTime.start,
            timeEnd: selectedTime.end,
          }
        : null),
    };
  });
  const editorState = createMemo(() => ({
    song: song(),
    prefs: prefs(),
    channelIndex: channelIndex(),
    bar: bar(),
    selection: selection(),
    dialog: dialog(),
    recording: recording(),
    playing: playing(),
    position: position(),
    channel: channel(),
  }));
  const notify = (message: string): void => {
    setStatus(message);
  };
  let receiveMultiplayer: ((state: MultiplayerState, event: MultiplayerEvent) => void) | null =
    null;
  const multiplayerClient = new MultiplayerClient((state, event) => {
    receiveMultiplayer?.(state, event);
  });
  const [multiplayer, setMultiplayer] = createSignal(multiplayerClient.state);
  receiveMultiplayer = (state, event): void => {
    setMultiplayer(state);
    if (state.status === "reconnecting" || state.recovering) {
      history.suspendPreview();
      interruptRecording?.();
    }
    if (event.type === "accepted" || event.type === "snapshot") {
      for (const id of event.rejected) {
        history.settle(id, false);
      }
    }
    if (state.song && state.editorId !== null && !joined) {
      joined = true;
      history.beginCollaboration(state.song, {
        editable: () => multiplayer().status === "connected" && !multiplayer().recovering,
        submit: (transaction, lock) => multiplayerClient.submit(transaction, lock),
        onError: notify,
      });
      setTime(null);
      setInstrument(0);
    } else if (joined && state.status === "offline") {
      joined = false;
      history.endCollaboration(state.song ?? history.committedSong);
    } else if (joined && state.song) {
      if (event.type === "accepted") {
        const local = event.editorId === state.editorId;
        if (local) {
          history.settle(event.id, true);
        }
        history.reconcile(state.song, local ? [] : [event.transaction]);
      } else if (event.type === "snapshot") {
        for (const receipt of event.receipts) {
          history.settle(receipt.id, true);
        }
        history.reconcile(
          state.song,
          event.changes
            .filter(({ editorId }) => editorId !== state.editorId)
            .map(({ transaction }) => transaction),
        );
      } else {
        return;
      }
      history.saveCollaborativeSong();
    }
  };
  const editorLocked = createMemo(() => {
    const state = multiplayer();
    return state.status === "reconnecting" || state.status === "connecting" || state.recovering;
  });
  const trackLocked = createMemo(() =>
    multiplayer().locks.some(
      ({ editorId, scope }) =>
        editorId !== multiplayer().editorId &&
        scope.channelId === channel().id &&
        scope.editor === undefined,
    ),
  );
  const [drawingScope, setDrawingScope] = createSignal<EditorLockScope>();
  const [requestingDrawingLock, setRequestingDrawingLock] = createSignal(false);
  const acquireDrawingLock = async (): Promise<(() => void) | null> => {
    if (multiplayer().status === "offline") {
      return () => {
        // Offline drawings have no server lock to release.
      };
    }
    const target = channel().instruments[selectedInstrumentIndex()];
    if (!target || drawingScope() || requestingDrawingLock() || editorLocked()) {
      return null;
    }
    const scope = { channelId: channel().id, editor: `instrument:${target.id}` };
    setRequestingDrawingLock(true);
    const granted = await multiplayerClient.acquireLock(scope);
    setRequestingDrawingLock(false);
    if (!granted) {
      notify("This instrument is locked by another editor.");
      return null;
    }
    if (
      editorLocked() ||
      channel().id !== scope.channelId ||
      channel().instruments[selectedInstrumentIndex()]?.id !== target.id
    ) {
      multiplayerClient.releaseLock(scope);
      return null;
    }
    setDrawingScope(scope);
    return () => {
      setDrawingScope(undefined);
      multiplayerClient.releaseLock(scope);
    };
  };
  const startMultiplayer = (address: string, password: string): void => {
    multiplayerClient.connect(address, password);
  };
  onCleanup(() => {
    multiplayerClient.disconnect();
  });
  const notifyAssets = (message: string): void => {
    if (assetDialogOpen()) {
      setAssetDialogMessage(message);
    } else {
      notify(message);
    }
  };
  const changeFavorites = async (next: Resource[]): Promise<void> => {
    setFavorites(next);
    setAssetDialogMessage("");
    const saved = await saveAssetFavorites(next);
    if (!saved && favorites() === next) {
      notifyAssets("Could not save asset favorites to browser storage.");
    }
  };
  const [revision, setRevision] = createSignal(0);
  const committedPattern = createMemo(() => {
    revision();
    const track = history.committedSong.channels[channelIndex()];
    return track?.patterns[track.cells[bar()] ?? 0] ?? null;
  });
  const canUndo = createMemo(() => {
    revision();
    return history.canUndo;
  });
  const canRedo = createMemo(() => {
    revision();
    return history.canRedo;
  });
  const captureContext = (): {
    current: {
      channel: number;
      bar: number;
    };
    rectangle: Selection;
    time: TimeSelection | null;
    instrument: number;
  } => ({
    current: current(),
    rectangle: rectangle(),
    time: time(),
    instrument: instrument(),
  });
  // Preserve a corrupt stored song until the user makes an edit.
  let submittedSave = initial.error ? { song: history.song } : null;
  const persistence = new DeferredTask();
  const persistSession = async (snapshot: Song): Promise<void> => {
    if (submittedSave?.song === snapshot) {
      return;
    }
    const attempt = { song: snapshot };
    submittedSave = attempt;
    const saved = await storage.saveStoredSession(snapshot);
    if (!saved && submittedSave === attempt) {
      submittedSave = null;
      setStatus(
        "Browser storage is unavailable; export a file or copy a song URL to keep your work.",
      );
    }
  };
  const fileItems = [
    "New Blank Song",
    "Import Song",
    "Export Song",
    "Copy Song URL",
    "Multiplayer…",
    ...(typeof navigator.share === "function" ? ["Share Song URL"] : []),
  ];
  const editItems = [
    "Undo",
    "Redo",
    "Cut",
    "Copy",
    "Paste",
    "Insert Bar",
    "Delete Selected Bars",
    "Delete Selected Channels",
    "Select All",
    "Select Channel",
    "Duplicate Reused Patterns",
    "Move Notes Up",
    "Move Notes Down",
    "Move All Notes Sideways",
    "Add Assets",
  ];
  const disabled = createMemo(() => recording() !== "off");
  const playControl = createMemo(() => {
    if (playing()) {
      return { label: "Pause", title: "Pause the song", icon: "player-pause" } as const;
    }
    if (control()) {
      return {
        label: "Record",
        title: "Record notes into the song",
        icon: "player-record",
      } as const;
    }
    return { label: "Play", title: "Play the song", icon: "player-play" } as const;
  });
  const dialogTitle: Record<Exclude<Dialog, null>, string> = {
    "channel-settings": "Channel Settings",
    preferences: "Preferences",
    help: "Help",
    layout: "Choose Layout",
    multiplayer: "Multiplayer",
    "custom-scale": "Edit Custom Scale",
    sideways: "Move All Notes Sideways",
    import: "Import Song",
    export: "Export Options",
    assets: "Add Assets",
    favorites: "View Favorites",
    "copy-url": "Copy Song URL",
  };
  const updatePosition = (nextBar: number, beat: number): void => {
    if (!playing()) {
      return;
    }
    // Update the beat display and follow bars only when the clock advances.
    // The playheads read the audio clock at the display refresh rate.
    const previousPosition = position();
    if (
      nextBar !== previousPosition.bar ||
      Math.floor(beat) !== Math.floor(previousPosition.beat)
    ) {
      setPosition({
        bar: nextBar,
        beat,
      });
    }
    const clock = metronomeClock;
    const absolute = Math.floor(nextBar * song().beatsPerBar + beat);
    if (recording() === "recording" && prefs().metronome && clock && absolute !== clock.lastBeat) {
      clock.lastBeat = absolute;
      clock.source.click(Math.floor(beat) === 0);
    }
    // Follow bar transitions, allowing edits elsewhere until the next bar starts.
    if (prefs().autoFollow && recording() === "off" && nextBar !== previousPosition.bar) {
      setCurrent((c) => ({
        ...c,
        bar: nextBar,
      }));
      setRectangle((r) =>
        r.channelStart === r.channelEnd && r.barStart === r.barEnd
          ? emptySelection(channelIndex(), nextBar)
          : r,
      );
    }
  };
  const launch = (action: () => Promise<unknown>, onFailure?: () => void): void => {
    const run = async (): Promise<void> => {
      try {
        await action();
      } catch (error) {
        onFailure?.();
        setStatus(String(error));
      }
    };
    void run();
  };
  createEffect(
    on([bar, createMemo(() => prefs().autoFollow), playing, recording], () => {
      if (prefs().autoFollow && !playing() && recording() === "off") {
        engine?.seek(bar());
        setPosition({
          bar: bar(),
          beat: 0,
        });
      }
    }),
  );
  const audio = (): AudioEngine => {
    if (!engine) {
      const value = new AudioEngine(editorState().song);
      value.setThreadCount(prefs().audioThreads);
      value.setVolume(prefs().listeningVolume / 100);
      value.setMuted(muted());
      value.onPosition = updatePosition;
      value.onError = (error): void => {
        setPlaying(false);
        setStatus(String(error));
      };
      engine = value;
    }
    return engine;
  };
  const edit = (recipe: SongRecipe, reads?: EditPath[]): void => {
    if (editorLocked()) {
      return;
    }
    try {
      history.execute(recipe, reads);
    } catch (error) {
      setStatus(String(error));
    }
  };
  const persistPreferences = async (next: Preferences): Promise<void> => {
    const saved = await savePreferences(next);
    if (!saved && prefs() === next) {
      setStatus("Browser storage is unavailable; preferences last for this session.");
    }
  };
  const pref = <K extends keyof Preferences>(key: K, value: Preferences[K]): void => {
    const next = { ...prefs(), [key]: value };
    setPrefs(next);
    void persistPreferences(next);
  };
  const resetView = (): void => {
    setMuted(new Set<string>());
    setCurrent({
      channel: 0,
      bar: 0,
    });
    setRectangle(emptySelection(0, 0));
    setTime(null);
    setInstrument(0);
    setPosition({
      bar: 0,
      beat: 0,
    });
    engine?.pause();
    setPlaying(false);
  };
  const select = (t: number, b: number, extend = false): void => {
    if (editorState().recording !== "off") {
      return;
    }
    if (extend) {
      setRectangle({
        channelStart: Math.min(current().channel, t),
        channelEnd: Math.max(current().channel, t),
        barStart: Math.min(current().bar, b),
        barEnd: Math.max(current().bar, b),
      });
      return;
    }
    engine?.releaseAll();
    selectionEnd = {
      channel: t,
      bar: b,
    };
    setCurrent({
      channel: t,
      bar: b,
    });
    setInstrument(0);
    setRectangle(emptySelection(t, b));
    setTime(null);
  };
  const extend = (t: number, b: number): void => {
    selectionEnd = {
      channel: t,
      bar: b,
    };
    setRectangle({
      channelStart: Math.min(current().channel, t),
      channelEnd: Math.max(current().channel, t),
      barStart: Math.min(current().bar, b),
      barEnd: Math.max(current().bar, b),
    });
  };
  const stopRecording = (): void => {
    const data = recordData;
    if (!data) {
      return;
    }
    if (data.timer !== null) {
      clearTimeout(data.timer);
    }
    const result = data.recorder.finish(audio().absoluteBeat);
    recordData = null;
    audio().pause();
    audio().releaseAll();
    held.clear();
    setPlaying(false);
    setRecording("off");
    try {
      const transaction = createTransaction(data.source, result);
      if (
        transaction.changes.length > 0 &&
        (editorLocked() || !history.commit(transaction, data.lock))
      ) {
        notify("The recording could not be committed.");
      }
    } catch (error) {
      notify(`Could not apply the recording. ${String(error)}`);
    } finally {
      if (data.lock) {
        multiplayerClient.releaseLock(data.lock);
      }
    }
    editor?.focus();
  };
  interruptRecording = stopRecording;
  const togglePlay = (): void => {
    if (recording() !== "off") {
      stopRecording();
      return;
    }
    if (playing()) {
      audio().pause();
      setPlaying(false);
      setPosition((p) => ({
        ...p,
        beat: 0,
      }));
    } else {
      const a = audio();
      a.setSong(song());
      a.setVolume(prefs().listeningVolume / 100);
      a.setMuted(muted());
      launch(
        async () => {
          await a.play(position().bar);
        },
        () => {
          setPlaying(false);
        },
      );
      setPlaying(true);
    }
  };
  const seek = (value: number, beat = 0): void => {
    const next = Math.max(0, Math.min(song().barCount - 1, value));
    audio().seek(next, beat);
    setPosition({
      bar: next,
      beat,
    });
    if (prefs().autoFollow) {
      select(channelIndex(), next);
    }
  };
  const open = (next: Dialog): void => {
    if (recording() !== "off") {
      return;
    }
    if (next === "layout") {
      setLayoutDraft(prefs().layout);
    }
    if (next === "custom-scale") {
      setCustomMask(song().scale === "Custom" ? song().customScale : scalePitches(song()));
    }
    if (next === "export") {
      setFileName("Song");
      setIntro(song().loopStart > 0);
      setOutro(song().loopEnd < song().barCount);
      setRendered(null);
    }
    if (next !== "preferences" && next !== "help" && next !== "multiplayer") {
      resumeOnClose = playing();
      if (playing()) {
        audio().pause();
        setPlaying(false);
      }
    }
    setDialog(next);
  };
  const close = (): void => {
    renderToken++;
    exportAbort?.abort();
    setRendering(false);
    setRendered(null);
    setAssetDialogMessage("");
    setDialog(null);
    if (resumeOnClose) {
      resumeOnClose = false;
      launch(async () => {
        await audio().play(position().bar);
      });
      setPlaying(true);
    }
    requestAnimationFrame(() => {
      editor?.focus();
    });
  };
  const showAssetDialog = (view: "assets" | "favorites"): void => {
    setAssetDialogMessage("");
    setDialog(view);
  };
  const dismissDialog = (): void => {
    if (dialog() === "favorites") {
      showAssetDialog("assets");
    } else {
      close();
    }
  };
  const mute = (kind: "all" | "exclude" | "selected" | "solo"): void => {
    const selected = song().channels.filter(
      (_, i) => i >= selection().channelStart && i <= selection().channelEnd,
    );
    setMuted((previous) => {
      const next = new Set(previous);
      if (kind === "all") {
        return previous.size > 0 ? new Set<string>() : new Set(song().channels.map((t) => t.id));
      }
      if (kind === "selected") {
        const shouldMute = selected.some((t) => !previous.has(t.id));
        for (const t of selected) {
          if (shouldMute) {
            next.add(t.id);
          } else {
            next.delete(t.id);
          }
        }
        return next;
      }
      const desired = new Set(
        song()
          .channels.filter((t) =>
            kind === "solo" ? t.kind === "track" && !selected.includes(t) : selected.includes(t),
          )
          .map((t) => t.id),
      );
      return desired.size === previous.size && [...desired].every((id) => previous.has(id))
        ? new Set<string>()
        : desired;
    });
  };
  const shareUrl = async (share = false): Promise<void> => {
    const url = storage.songURL(song());
    if (share && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: "SlopeMP song",
          url,
        });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setStatus(String(error));
        }
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setStatus("Song URL copied.");
    } catch {
      setCopyUrl(url);
      open("copy-url");
    }
  };
  const copyClipboard = (
    value: Instrument | ops.PatternClipboard,
    kind: "instrument" | "pattern",
  ): void => {
    launch(async () => {
      if (!(await storage.saveClipboard(value, kind))) {
        notify("Clipboard is available for this session; browser storage is unavailable.");
      }
    });
  };
  const pasteClipboard = <T,>(
    pending: Promise<T | null>,
    apply: (draft: Song, data: T) => void,
  ): void => {
    const currentSong = history.song;
    launch(async () => {
      const data = await pending;
      // The destination indexes describe the song at the time of the paste command.
      if (data !== null && history.song === currentSong && !disabled()) {
        edit((draft) => {
          apply(draft, data);
        });
      }
    });
  };
  const copyInstrument = (): void => {
    const selected = channel().instruments[selectedInstrumentIndex()];
    if (selected) {
      copyClipboard(selected, "instrument");
    }
  };
  const pasteInstrument = (): void => {
    const track = channelIndex();
    const index = selectedInstrumentIndex();
    pasteClipboard(storage.loadClipboard("instrument"), (draft, data) => {
      const { instruments } = required(draft.channels[track]);
      const target = instruments[index];
      if (target) {
        instruments[index] = { ...clone(data), id: target.id };
      }
    });
  };
  const command = (name: string): void => {
    if (recording() !== "off" || (editorLocked() && name !== "Multiplayer…")) {
      return;
    }
    const execute = (fn: (s: Song, selection: Selection) => void): void => {
      edit((s) => {
        fn(s, selection());
      });
    };
    switch (name) {
      case "Multiplayer…": {
        open("multiplayer");
        return;
      }
      case "Undo": {
        history.undo();
        break;
      }
      case "Redo": {
        history.redo();
        break;
      }
      case "New Blank Song": {
        history.replace(createBlankSong(prefs(), favorites()));
        resetView();
        break;
      }
      case "Import Song": {
        open("import");
        break;
      }
      case "Export Song": {
        open("export");
        break;
      }
      case "Copy Song URL": {
        void shareUrl();
        break;
      }
      case "Share Song URL": {
        void shareUrl(true);
        break;
      }
      case "Copy": {
        copyClipboard(ops.copyPatterns(song(), selection()), "pattern");
        setTime(null);
        break;
      }
      case "Cut": {
        copyClipboard(ops.copyPatterns(song(), selection()), "pattern");
        execute((s, selected) => {
          ops.cutPatterns(s, selected);
        });
        setTime(null);
        break;
      }
      case "Paste": {
        const destination = selection();
        pasteClipboard(storage.loadClipboard(), (draft, data) => {
          const warnings = ops.pastePatterns(draft, destination, data);
          if (warnings.length > 0) {
            notify(warnings.join(" "));
          }
        });
        break;
      }
      case "Insert Bar": {
        execute(ops.insertBars);
        break;
      }
      case "Insert Channel Below": {
        edit((s) => {
          ops.insertChannelBelow(s, channelIndex());
        });
        break;
      }
      case "Delete Selected Bars": {
        execute(ops.deleteBars);
        setTime(null);
        break;
      }
      case "Delete Selected Channels": {
        execute(ops.deleteChannels);
        break;
      }
      case "Select All": {
        setTime(null);
        setRectangle(
          selection().barStart === 0 &&
            selection().barEnd === song().barCount - 1 &&
            selection().channelStart === 0 &&
            selection().channelEnd === song().channels.length - 1
            ? emptySelection(channelIndex(), bar())
            : {
                channelStart: 0,
                channelEnd: song().channels.length - 1,
                barStart: 0,
                barEnd: song().barCount - 1,
              },
        );
        break;
      }
      case "Select Channel": {
        setTime(null);
        setRectangle({
          ...selection(),
          barStart:
            selection().barStart === 0 && selection().barEnd === song().barCount - 1 ? bar() : 0,
          barEnd:
            selection().barStart === 0 && selection().barEnd === song().barCount - 1
              ? bar()
              : song().barCount - 1,
        });
        break;
      }
      case "Duplicate Reused Patterns": {
        execute(ops.duplicateReusedPatterns);
        break;
      }
      case "Move Notes Up": {
        edit((s) => {
          ops.transpose(s, selection(), 1, prefs().allowOutsideScale);
        });
        break;
      }
      case "Move Notes Down": {
        edit((s) => {
          ops.transpose(s, selection(), -1, prefs().allowOutsideScale);
        });
        break;
      }
      case "Move All Notes Sideways": {
        setOffset(0);
        open("sideways");
        break;
      }
      case "Add Assets": {
        open("assets");
        break;
      }
      case "Snap Notes To Scale": {
        execute(ops.snapToScale);
        break;
      }
      case "Snap Notes To Rhythm": {
        execute(ops.snapToRhythm);
        break;
      }
      case "Detect Key": {
        edit((s) => {
          ops.detectKey(s);
        });
        break;
      }
    }
    if (!["Import Song", "Export Song", "Add Assets", "Move All Notes Sideways"].includes(name)) {
      editor?.focus();
    }
  };
  const audition = (pitch: number | null, brief = false): void => {
    if (recording() !== "off" && !brief) {
      return;
    }
    if (pitch === null) {
      audio().releaseAll();
    } else if (!brief || !playing()) {
      audio().setSong(song());
      audio().setVolume(prefs().listeningVolume / 100);
      launch(async () => {
        await audio().audition(channel(), pitch);
      });
      if (brief) {
        setTimeout(() => engine?.release(pitch), 160);
      }
    }
  };
  const liveOn = (pitch: number): void => {
    const r = editorState();
    if (
      r.channel.kind !== "track" ||
      (r.prefs.filterRecording && !scalePitches(r.song).includes(pitch % 12))
    ) {
      return;
    }
    if (r.recording === "off") {
      audio().setSong(r.song);
    }
    audio().setVolume(r.prefs.listeningVolume / 100);
    launch(async () => {
      await audio().audition(r.channel, pitch);
    });
    if (recordData && r.recording === "recording") {
      recordData.recorder.noteOn(pitch, audio().absoluteBeat);
    }
  };
  const liveOff = (pitch: number): void => {
    engine?.release(pitch);
    recordData?.recorder.noteOff(pitch, audio().absoluteBeat);
  };
  const captureRecording = (lock?: EditorLockScope): void => {
    const startBar = position().bar;
    setCurrent({
      channel: channelIndex(),
      bar: startBar,
    });
    setRectangle(emptySelection(channelIndex(), startBar));
    setTime(null);
    audio().pause();
    setPlaying(false);
    history.cancelPreview();
    const source = history.committedSong;
    const data: NonNullable<typeof recordData> = {
      recorder: new PerformanceRecorder(source, channelIndex(), startBar, prefs().snapRecording),
      timer: null,
      source,
      lock,
    };
    recordData = data;
    const capture = (): void => {
      setRecording("recording");
      audio().setSong(song());
      launch(async () => {
        await audio().play(startBar, true);
        for (const pitch of held.values()) {
          data.recorder.noteOn(pitch, startBar * song().beatsPerBar);
        }
      }, stopRecording);
      setPlaying(true);
    };
    if (prefs().countIn) {
      setRecording("count-in");
      data.timer = setTimeout(capture, (song().beatsPerBar * 60_000) / song().tempo);
    } else {
      capture();
    }
    requestAnimationFrame(() => {
      stopButton?.focus();
    });
  };
  const startRecording = async (): Promise<void> => {
    if (
      dialog() ||
      channel().kind !== "track" ||
      recording() !== "off" ||
      editorLocked() ||
      waitingForRecordingLock()
    ) {
      return;
    }
    if (multiplayer().status !== "connected") {
      captureRecording();
      return;
    }
    const scope = { channelId: channel().id };
    setWaitingForRecordingLock(true);
    const granted = await multiplayerClient.acquireLock(scope);
    setWaitingForRecordingLock(false);
    if (!granted) {
      notify("This track is locked by another editor.");
    } else if (channel().id !== scope.channelId || dialog() || editorLocked()) {
      multiplayerClient.releaseLock(scope);
    } else {
      captureRecording(scope);
    }
  };
  const importFile = async (file: File): Promise<void> => {
    try {
      const loaded = /\.midi?$/iu.test(file.name)
        ? importMidi(new Uint8Array(await file.arrayBuffer()))
        : storage.parseSongBytes(new Uint8Array(await file.arrayBuffer()));
      history.replace(loaded);
      resetView();
      close();
    } catch (error) {
      setStatus(`Import failed: ${String(error)}`);
    }
  };
  const exportFile = async (): Promise<void> => {
    const options = {
      intro: intro(),
      outro: outro(),
      loopCount: loopCount(),
      muted: muted(),
      threadCount: prefs().audioThreads,
    };
    const name = `${formats.sanitizeFilename(fileName())}.${format()}`;
    pref("exportFormat", format());
    const audioFile = rendered();
    if (audioFile) {
      formats.downloadFile(name, audioFile);
      close();
      return;
    }
    let token = renderToken;
    try {
      if (format() === "wav" || format() === "mp3") {
        setRendering(true);
        token = ++renderToken;
        await Promise.all(
          song().resources.flatMap((resource) => {
            const promise = resourceLoads.get(resourceCacheKey(resource));
            return promise ? [promise] : [];
          }),
        );
        if (token !== renderToken) {
          return;
        }
        // Release the paused playback pool so export owns the thread budget.
        const playback = engine;
        engine = null;
        await playback?.close();
        if (token !== renderToken) {
          return;
        }
        exportAbort = new AbortController();
        setProgress(0);
        const blob = await (format() === "mp3" ? renderMp3 : renderWav)(song(), {
          ...options,
          signal: exportAbort.signal,
          onProgress: (value) => {
            setProgress(value);
          },
        });
        if (token !== renderToken) {
          return;
        }
        setRendered(blob);
        setRendering(false);
      } else if (format() === "slopemp") {
        formats.downloadFile(
          name,
          storage.serializeSongBytes(formats.expandSequence(song(), options)),
        );
        close();
      } else if (format() === "mid") {
        formats.downloadFile(name, exportMidi(song(), options), "audio/midi");
        close();
      }
    } catch (error) {
      if (token !== renderToken) {
        return;
      }
      setRendering(false);
      setStatus(`Export failed: ${String(error)}`);
    }
  };
  const numberHelp = {
    "Beats per bar": "Set the length of each bar in beats",
    "Song length": "Set the number of bars in the song",
    Tracks: "Set how many instrument tracks the song has",
    Automations: "Set how many tracks change settings during playback",
    "Max patterns": "Set how many patterns each track can use",
  };
  const SettingsNumber = (props: {
    label: keyof typeof numberHelp;
    value: number;
    min: number;
    apply: (s: Song, n: number) => void;
    max?: number;
  }): JSX.Element => (
    <Setting label={props.label} tooltip={numberHelp[props.label]}>
      <NumericInput
        class="control numeric"
        aria-label={props.label}
        value={props.value}
        min={props.min}
        max={props.max}
        disabled={disabled()}
        onCommit={(value) => {
          edit((s) => {
            props.apply(
              s,
              Math.max(
                props.min,
                Math.min(props.max ?? Number.MAX_SAFE_INTEGER, Math.round(value)),
              ),
            );
          });
        }}
      />
    </Setting>
  );
  const midiKey = (): number => song().key;
  const receiveMidi = (pitch: number, down: boolean): void => {
    if (down) {
      liveOn(pitch);
    } else {
      liveOff(pitch);
    }
  };
  createEffect(() => {
    if (multiplayer().status === "connected") {
      revision();
      const track = history.committedSong.channels[channelIndex()];
      if (track) {
        multiplayerClient.setSelection({
          channelId: track.id,
          bar: bar(),
          pattern: track.cells[bar()] ?? 0,
        });
      }
    }
  });
  createEffect(
    on(song, () => {
      engine?.setSong(song());
    }),
  );
  createEffect(
    on(
      createMemo(() => prefs().listeningVolume),
      () => {
        engine?.setVolume(prefs().listeningVolume / 100);
      },
    ),
  );
  createEffect(
    on(
      createMemo(() => prefs().audioThreads),
      () => {
        engine?.setThreadCount(prefs().audioThreads);
      },
    ),
  );
  createEffect(
    on(muted, () => {
      engine?.setMuted(muted());
    }),
  );
  onMount(() => {
    if (!Reflect.has(navigator, "mediaSession")) {
      return;
    }
    const session = navigator.mediaSession;
    const actions = {
      play: (): void => {
        if (!playing() && !disabled() && dialog() === null) {
          togglePlay();
        }
      },
      pause: (): void => {
        if (playing()) {
          togglePlay();
        }
      },
    };
    for (const action of ["play", "pause"] as const) {
      try {
        session.setActionHandler(action, actions[action]);
      } catch {
        // A browser can expose Media Session without supporting every action.
        continue;
      }
      onCleanup(() => {
        session.setActionHandler(action, null);
      });
    }
    createEffect(() => {
      session.playbackState = playing() ? "playing" : "paused";
    });
    onCleanup(() => {
      session.playbackState = "none";
    });
  });
  onMount(() => {
    let disposed = false;
    onCleanup(() => {
      disposed = true;
    });
    onCleanup(
      history.subscribe(() => {
        // BrowserHistory finishes updating its navigation metadata after notifying.
        // Publish the complete edit together once the current command has finished.
        queueMicrotask(() => {
          if (!disposed) {
            batch(() => {
              setSong(history.song);
              setRevision((value) => value + 1);
            });
          }
        });
      }),
    );
  });
  onMount(() => {
    history.setContextHandlers(
      () => captureContext(),
      (context) => {
        setCurrent(context.current);
        setRectangle(context.rectangle);
        setTime(context.time);
        setInstrument(context.instrument);
      },
    );
  });
  createEffect(
    on([song, revision], () => {
      history.updateContext();
    }),
  );
  createEffect(
    on([song, revision], () => {
      if (!history.isPreview) {
        const committedSong = song();
        persistence.schedule(() => {
          void persistSession(committedSong);
        });
      }
    }),
  );
  createEffect(
    on(
      createMemo(() => prefs().songInUrl),
      () => {
        history.setSongInURL(prefs().songInUrl);
      },
    ),
  );
  onMount(() => {
    const flush = (): void => {
      persistence.flush();
    };
    const hidden = (): void => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };
    globalThis.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    onCleanup((): void => {
      flush();
      globalThis.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    });
  });
  onMount(() => {
    onCleanup(
      history.connect(() => {
        resetView();
      }, notify),
    );
  });
  createEffect(
    on(dialog, () => {
      if (!dialog()) {
        return;
      }
      const element = dialogElement;
      const input = element?.querySelector<HTMLInputElement>(
        "input:not([type=checkbox]):not([type=range]),button",
      );
      input?.focus();
      if (input instanceof HTMLInputElement) {
        input.select();
      }
    }),
  );
  onMount(() => {
    const blur = (): void => {
      for (const pitch of held.values()) {
        liveOff(pitch);
      }
      held.clear();
      engine?.releaseAll();
    };
    const down = (event: KeyboardEvent): void => {
      setControl(event.ctrlKey);
      const r = editorState();
      if (!editorLocked()) {
        history.clearPreviewInterruption();
      }
      if (r.dialog) {
        if (event.key === "Escape") {
          event.preventDefault();
          dismissDialog();
        }
        return;
      }
      if (
        editorLocked() ||
        event.defaultPrevented ||
        editableTarget(event) ||
        (event.target instanceof Element && event.target.closest("dialog,[role=dialog]"))
      ) {
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      const keyAction = keyActionForEvent(event, r.prefs.keyBindings);
      if (keyAction === "play" || keyAction === "record" || keyAction === "playPointer") {
        event.preventDefault();
        editor?.focus({
          preventScroll: true,
        });
        if (event.repeat) {
          return;
        }
        if (r.recording !== "off") {
          stopRecording();
        } else if (keyAction === "record") {
          void startRecording();
        } else if (keyAction === "playPointer") {
          if (!pointer) {
            return;
          }
          seek(pointer.bar, pointer.beat);
          if (!r.playing) {
            togglePlay();
          }
        } else {
          togglePlay();
        }
        return;
      }
      if (!keyAction && r.prefs.unboundKeysPlayNotes && !mod && !event.altKey) {
        const pitch = keyboardPitch(
          event.code,
          r.prefs.keyboardLayout,
          octave(),
          r.song.key,
          scalePitches(r.song),
        );
        if (pitch !== null && !held.has(event.code)) {
          event.preventDefault();
          held.set(event.code, pitch);
          liveOn(pitch);
        }
      }
      if (r.recording !== "off" || !keyAction) {
        return;
      }
      event.preventDefault();
      const directions: Record<string, readonly [-1 | 0 | 1, -1 | 0 | 1]> = {
        moveUp: [-1, 0],
        moveDown: [1, 0],
        moveLeft: [0, -1],
        moveRight: [0, 1],
        extendUp: [-1, 0],
        extendDown: [1, 0],
        extendLeft: [0, -1],
        extendRight: [0, 1],
      };
      const direction = directions[keyAction];
      if (direction) {
        const [dt, db] = direction;
        if (keyAction.startsWith("extend")) {
          extend(
            clamp(selectionEnd.channel + dt, 0, r.song.channels.length - 1),
            clamp(selectionEnd.bar + db, 0, r.song.barCount - 1),
          );
        } else {
          select(
            (r.channelIndex + dt + r.song.channels.length) % r.song.channels.length,
            (r.bar + db + r.song.barCount) % r.song.barCount,
          );
        }
        return;
      }
      if (keyAction === "channelUp" || keyAction === "channelDown") {
        edit((s) => {
          ops.moveChannels(s, r.selection, keyAction === "channelUp" ? -1 : 1);
        });
        return;
      }
      if (keyAction.startsWith("pattern")) {
        const n = Number(keyAction.slice(-1));
        const entry = digitEntry;
        const cell = `${r.channelIndex}:${r.bar}`;
        const combined =
          entry.cell === cell && entry.value === (r.channel.cells[r.bar] ?? 0)
            ? entry.value * 10 + n
            : n;
        const value = combined <= r.song.patternCount ? combined : n;
        digitEntry = {
          value,
          cell,
        };
        if (value <= r.song.patternCount) {
          edit((s) => {
            ops.assignPattern(s, r.selection, value);
          });
        }
        return;
      }
      digitEntry = {
        value: 0,
        cell: "",
      };
      const commands: Record<string, string> = {
        import: "Import Song",
        export: "Export Song",
        undo: "Undo",
        redo: "Redo",
        copy: "Copy",
        cut: "Cut",
        paste: "Paste",
        insertBar: "Insert Bar",
        insertChannel: "Insert Channel Below",
        deleteBars: "Delete Selected Bars",
        deleteChannels: "Delete Selected Channels",
        selectAll: "Select All",
        selectChannel: "Select Channel",
        duplicate: "Duplicate Reused Patterns",
        assets: "Add Assets",
      };
      const action = commands[keyAction];
      if (action !== undefined) {
        command(action);
      } else if (keyAction === "copyInstrument") {
        copyInstrument();
      } else if (keyAction === "pasteInstrument") {
        pasteInstrument();
      } else if (["transposeUp", "transposeDown", "octaveUp", "octaveDown"].includes(keyAction)) {
        edit((s) => {
          ops.transpose(
            s,
            r.selection,
            keyAction.endsWith("Up") ? 1 : -1,
            r.prefs.allowOutsideScale,
            keyAction.startsWith("octave"),
          );
        });
      } else if (keyAction === "muteSelected" || keyAction === "muteAll") {
        mute(keyAction === "muteAll" ? "all" : "selected");
      } else if (keyAction === "solo" || keyAction === "exclude") {
        mute(keyAction);
      } else if (keyAction === "randomPreset" || keyAction === "randomInstrument") {
        edit((s) => {
          const t = required(s.channels[r.channelIndex]);
          const old = t.instruments[instrument()];
          if (old) {
            t.instruments[instrument()] =
              keyAction === "randomInstrument"
                ? randomInstrument(old, Math.random, assets())
                : randomPreset(old, assets());
          }
        });
      } else if (keyAction === "channelSettings") {
        open("channel-settings");
      } else if (keyAction === "previousBar") {
        seek(r.position.bar - 1);
      } else if (keyAction === "nextBar") {
        seek(r.position.bar + 1);
      } else if (keyAction === "clearSelection") {
        setTime(null);
        setRectangle(emptySelection(r.channelIndex, r.bar));
      }
    };
    const up = (event: KeyboardEvent): void => {
      setControl(event.ctrlKey);
      const pitch = held.get(event.code);
      if (pitch !== undefined) {
        liveOff(pitch);
        held.delete(event.code);
      }
    };
    globalThis.addEventListener("keydown", down);
    globalThis.addEventListener("keyup", up);
    globalThis.addEventListener("blur", blur);
    onCleanup((): void => {
      globalThis.removeEventListener("keydown", down);
      globalThis.removeEventListener("keyup", up);
      globalThis.removeEventListener("blur", blur);
    });
  });
  onCleanup(() => {
    engine?.pause();
  });
  createEffect(
    on(
      [
        recording,
        createMemo(() => prefs().metronome),
        createMemo(() => song().tempo),
        createMemo(() => song().beatsPerBar),
      ],
      () => {
        if (recording() === "off" || (recording() === "recording" && !prefs().metronome)) {
          return;
        }
        const metronome = createMetronome();
        metronomeClock = {
          source: metronome,
          lastBeat: Math.floor(engine?.absoluteBeat ?? 0),
        };
        metronome.click(true);
        let count = 0;
        const timer =
          recording() === "count-in"
            ? setInterval(() => {
                count++;
                metronome.click(count % song().beatsPerBar === 0);
              }, 60_000 / song().tempo)
            : null;
        onCleanup((): void => {
          if (timer !== null) {
            clearInterval(timer);
          }
          metronomeClock = null;
          void metronome.close();
        });
      },
    ),
  );
  createEffect(
    on([createMemo(() => channel().id), createMemo(() => song().key), octave], () => {
      engine?.releaseAll();
      held.clear();
    }),
  );
  createEffect(
    on(
      createMemo(() => prefs().midi),
      () => {
        if (!prefs().midi) {
          return;
        }
        const input = new MidiInput(
          (pitch, down) => {
            receiveMidi(pitch, down);
          },
          () => midiKey(),
        );
        launch(async () => {
          await input.enable();
        });
        onCleanup((): void => {
          input.disable();
        });
      },
    ),
  );
  const updateAssetState = (key: string, state: AssetLoadState): void => {
    setAssetStates((previous) => new Map(previous).set(key, state));
  };
  const activateAsset = (id: string, key: string): void => {
    installAudioResourceAlias(key, id);
    activeResources.set(id, key);
  };
  const loadSongAsset = async (
    resource: Resource,
    key: string,
    signal: AbortSignal,
  ): Promise<void> => {
    updateAssetState(key, { status: "loading" });
    try {
      const result = await loadAsset(key, resource.url, signal);
      if (signal.aborted) {
        return;
      }
      if (wantedResources.get(resource.id) === key) {
        activateAsset(resource.id, key);
      }
      updateAssetState(key, { status: "ready", result });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      const message = String(error);
      updateAssetState(key, { status: "error", error: message });
      if (wantedResources.get(resource.id) === key) {
        setStatus(message);
      }
    }
  };
  createEffect(
    on(resources, (entries) => {
      wantedResources = new Map(
        entries.map((resource) => [resource.id, resourceCacheKey(resource)]),
      );
      const wantedKeys = new Set(wantedResources.values());
      resourceLoads.retain(wantedKeys);
      for (const [id, key] of activeResources) {
        if (wantedResources.get(id) !== key) {
          removeAudioResource(id);
          activeResources.delete(id);
        }
      }
      const states = new Map(assetStates());
      for (const key of states.keys()) {
        if (!wantedKeys.has(key)) {
          removeAudioResource(key);
          states.delete(key);
        }
      }
      setAssetStates(states);
      for (const resource of entries) {
        const key = resourceCacheKey(resource);
        if (activeResources.has(resource.id)) {
          continue;
        }
        if (assetStates().get(key)?.status === "ready") {
          activateAsset(resource.id, key);
        } else if (!assetStates().has(key)) {
          resourceLoads.start(key, async (signal) => {
            await loadSongAsset(resource, key, signal);
          });
        }
      }
    }),
  );
  onCleanup(() => {
    resourceLoads.retain(new Set());
    for (const id of activeResources.keys()) {
      removeAudioResource(id);
    }
    for (const key of assetStates().keys()) {
      removeAudioResource(key);
    }
  });
  onMount(() => {
    const focusEditor = (event: PointerEvent): void => {
      history.clearPreviewInterruption();
      if (
        event.target instanceof Element &&
        event.target.closest(".pattern-region,.channel-region")
      ) {
        editor?.focus({
          preventScroll: true,
        });
        if (event.target.closest("button") && !event.target.closest(".pattern-header")) {
          event.preventDefault();
        }
      }
    };
    editor?.addEventListener("pointerdown", focusEditor, true);
    onCleanup(() => {
      editor?.removeEventListener("pointerdown", focusEditor, true);
    });
  });
  return (
    <main
      ref={(element) => {
        editor = element;
      }}
      tabIndex={-1}
      class={`editor layout-${prefs().layout} ${disabled() ? "is-recording" : ""}`}
      style={editorColors(channelIndex())}
      aria-label="SlopeMP music editor"
    >
      <div class="workspace" inert={editorLocked()}>
        {channel().kind === "track" ? (
          <PatternEditor
            song={song()}
            channel={channel()}
            bar={bar()}
            committedPattern={committedPattern()}
            scale={scalePitches(song())}
            allowOutsideScale={prefs().allowOutsideScale}
            leftAlignPiano={prefs().leftAlignPiano}
            disabled={disabled() || trackLocked()}
            playhead={
              playing() &&
              (position().bar === bar() ||
                ((channel().cells[bar()] ?? 0) > 0 &&
                  channel().cells[position().bar] === channel().cells[bar()]))
                ? readPlayhead
                : null
            }
            selection={time()}
            onSelection={(value) => {
              setTime(value);
            }}
            onOctave={(value) => {
              if (value !== octave()) {
                edit((draft) => {
                  required(draft.channels[channelIndex()]).octave = value;
                });
              }
            }}
            onZoom={(n) => {
              edit((draft) => {
                required(draft.channels[channelIndex()]).octaves = n;
              });
            }}
            onAudition={(pitch) => {
              audition(pitch);
            }}
            onPreviewNote={(pitch) => {
              audition(pitch, true);
            }}
            onPointerBeat={(beat) => {
              pointer =
                beat === null
                  ? null
                  : {
                      bar: bar(),
                      beat,
                    };
            }}
            onGesture={(notes, phase) => {
              try {
                if (phase === "cancel") {
                  history.cancelPreview();
                } else if (notes) {
                  const reads: EditPath[] = [
                    ["channels", { id: channel().id }, "cells", bar()],
                    ["key"],
                    ["rhythm"],
                    ["beatsPerBar"],
                  ];
                  const change: SongRecipe = (draft) => {
                    ops.ensurePattern(draft, channelIndex(), bar()).notes = notes;
                  };
                  if (phase === "preview") {
                    history.preview(change, reads);
                  } else {
                    edit(change, reads);
                  }
                } else {
                  history.commitPreview();
                }
              } catch (error) {
                history.cancelPreview();
                setStatus(String(error));
              }
            }}
          />
        ) : (
          <section class="pattern-region automation-region" inert={trackLocked()}>
            <AutomationPanel
              copiedEffect={copiedEffect()}
              onCopyEffect={copyEffect}
              channel={channel()}
              song={song()}
              bar={bar()}
              onPreview={(value) => {
                if (!value) {
                  history.cancelPreview();
                } else {
                  history.preview((s) => {
                    s.channels[channelIndex()] = value;
                  });
                }
              }}
              onChange={(value) => {
                edit((s) => {
                  const capacity = Math.max(
                    s.patternCount,
                    ...Object.keys(value.patterns).map(Number),
                  );
                  if (capacity > s.patternCount) {
                    ops.setPatternCount(s, capacity);
                  }
                  s.channels[channelIndex()] = value;
                });
              }}
            />
          </section>
        )}
        <aside class="settings-area">
          <fieldset disabled={disabled()} class="instrument-settings" inert={trackLocked()}>
            <DrawingLock.Provider
              value={{ acquire: acquireDrawingLock, interrupted: editorLocked }}
            >
              <InstrumentPanel
                copiedEffect={copiedEffect()}
                onCopyEffect={copyEffect}
                assets={assets()}
                channel={channel()}
                selectedInstrument={selectedInstrumentIndex()}
                onSelectInstrument={(value) => {
                  setInstrument(value);
                }}
                onCopyInstrument={copyInstrument}
                onPasteInstrument={pasteInstrument}
                onChange={(value) => {
                  const scope = drawingScope();
                  if (scope) {
                    history.cancelPreview();
                    const source = history.committedSong;
                    const draft = clone(source);
                    draft.channels[channelIndex()] = value;
                    try {
                      history.commit(createTransaction(source, draft), scope);
                    } catch (error) {
                      notify(String(error));
                    }
                  } else {
                    edit((s) => {
                      s.channels[channelIndex()] = value;
                    });
                  }
                }}
                onPreview={(value) => {
                  if (!value) {
                    history.cancelPreview();
                  } else {
                    history.preview((s) => {
                      s.channels[channelIndex()] = value;
                    });
                  }
                }}
                onAddAssets={() => {
                  open("assets");
                }}
                onDialogChange={(opened) => {
                  if (opened) {
                    resumeOnClose = playing();
                    if (playing()) {
                      audio().pause();
                      setPlaying(false);
                    }
                  } else {
                    if (resumeOnClose) {
                      resumeOnClose = false;
                      launch(async () => {
                        await audio().play(position().bar);
                      });
                      setPlaying(true);
                    }
                    editor?.focus();
                  }
                }}
              />
            </DrawingLock.Provider>
          </fieldset>
          <div class="main-settings">
            <div class={`transport ${playing() || disabled() ? "transport-active" : ""}`}>
              {!disabled() ? (
                <button
                  type="button"
                  class="control accent play-button"
                  aria-label={playControl().label}
                  title={playControl().title}
                  aria-pressed={playing()}
                  disabled={disabled()}
                  onClick={() => {
                    if (control() && !playing()) {
                      void startRecording();
                    } else {
                      togglePlay();
                    }
                  }}
                >
                  <Icon name={playControl().icon} />
                </button>
              ) : null}
              {!playing() || disabled() ? (
                <button
                  type="button"
                  ref={(element) => {
                    stopButton = element;
                  }}
                  class="control danger"
                  classList={{ "transport-stop": disabled() }}
                  aria-label={disabled() ? "Stop Recording" : "Record"}
                  title={disabled() ? "Finish recording notes" : "Record notes into the song"}
                  aria-pressed={disabled()}
                  onClick={() => {
                    if (disabled()) {
                      stopRecording();
                    } else {
                      void startRecording();
                    }
                  }}
                >
                  <Icon name={disabled() ? "player-stop" : "player-record"} />
                </button>
              ) : null}
              <button
                type="button"
                class="control small"
                aria-label="Previous bar"
                title="Move playback back one bar"
                disabled={disabled()}
                onClick={() => {
                  seek(position().bar - 1);
                }}
              >
                <Icon name="player-skip-back" />
              </button>
              <button
                type="button"
                class="control small"
                aria-label="Next bar"
                title="Move playback forward one bar"
                disabled={disabled()}
                onClick={() => {
                  seek(position().bar + 1);
                }}
              >
                <Icon name="player-skip-forward" />
              </button>
            </div>
            {disabled() ? (
              <output class="recording-status">
                <Icon name="player-record" />
                {recording() === "count-in" ? "Count-in…" : "Recording…"}
              </output>
            ) : null}
            <div class="speaker sr-only" aria-label="Playback position">
              <span>
                {position().bar + 1}:{Math.floor(position().beat) + 1}
              </span>
            </div>
            <div class="menu-row">
              {[
                {
                  label: "File",
                  icon: "file" as const,
                  items: fileItems,
                },
                {
                  label: "Edit",
                  icon: "pencil" as const,
                  items: editItems,
                },
              ].map(({ label, icon, items }) => (
                <SelectWrap class="action-menu">
                  <Icon name={icon} leading />
                  <select
                    class="control"
                    aria-label={`${label} menu`}
                    title={
                      label === "File"
                        ? "Save, share, or open songs"
                        : "Change notes, patterns, and tracks"
                    }
                    disabled={disabled()}
                    onChange={(event) => {
                      const menu = event.currentTarget;
                      const { value } = menu;
                      menu.value = "";
                      command(value);
                    }}
                  >
                    <option value="" disabled selected>
                      {label}
                    </option>
                    {items.map((item) => (
                      <option
                        value={item}
                        disabled={((): boolean => {
                          if (item === "Undo") {
                            return !canUndo();
                          } else {
                            if (item === "Redo") {
                              return !canRedo();
                            } else {
                              return false;
                            }
                          }
                        })()}
                      >
                        {item}
                      </option>
                    ))}
                  </select>
                </SelectWrap>
              ))}
            </div>
            <button
              type="button"
              class="control wide"
              title="Set playback, recording, and editor preferences"
              disabled={disabled()}
              onClick={() => {
                open("preferences");
              }}
            >
              <Icon name="settings" leading />
              Preferences
            </button>
            <button
              type="button"
              class="control wide"
              title="Show how to edit and play the song"
              disabled={disabled()}
              onClick={() => {
                open("help");
              }}
            >
              <Icon name="help" leading />
              Help
            </button>
            <section class="song-settings">
              <fieldset class="settings-group" aria-label="Scale and key">
                <Setting label="Scale" tooltip="Choose the notes shown in the editor">
                  <SelectWrap>
                    <select
                      class="control"
                      aria-label="Scale"
                      disabled={disabled()}
                      value={song().scale}
                      onChange={(event) => {
                        const { value } = event.currentTarget;
                        if (value === "snap") {
                          command("Snap Notes To Scale");
                        } else if (value === "Custom") {
                          open("custom-scale");
                        } else {
                          edit((s) => {
                            s.scale = value;
                          });
                        }
                        event.currentTarget.value = history.song.scale;
                      }}
                    >
                      {Object.keys(scales)
                        .concat("Custom")
                        .map((name) => (
                          <option>{name}</option>
                        ))}
                      <option value="snap">Edit: Snap Notes To Scale</option>
                    </select>
                  </SelectWrap>
                </Setting>
                {song().scale === "Custom" && (
                  <button
                    type="button"
                    class="control wide"
                    title="Choose the notes in the scale"
                    disabled={disabled()}
                    onClick={() => {
                      open("custom-scale");
                    }}
                  >
                    <Icon name="music" leading />
                    Edit Custom Scale
                  </button>
                )}
                <Setting label="Key" tooltip="Choose the scale's root note">
                  <SelectWrap>
                    <select
                      class="control"
                      aria-label="Key"
                      disabled={disabled()}
                      value={song().key}
                      onChange={(event) => {
                        const { value } = event.currentTarget;
                        if (value === "detect") {
                          command("Detect Key");
                        } else {
                          edit((s) => {
                            ops.setKey(s, Number(value));
                          });
                        }
                        event.currentTarget.value = String(history.song.key);
                      }}
                    >
                      {pitchNames
                        .map((_, i) => 11 - i)
                        .map((n) => (
                          <option value={n}>{pitchNames[n]}</option>
                        ))}
                      <option value="detect">Edit: Detect Key</option>
                    </select>
                  </SelectWrap>
                </Setting>
              </fieldset>
              <fieldset class="settings-group" aria-label="Timing">
                <Setting label="Tempo" tooltip="Set the song speed">
                  <span class="tempo-controls">
                    <input
                      class="tempo-slider"
                      aria-label="Coarse tempo"
                      type="range"
                      min={1}
                      max={300}
                      step={1}
                      value={song().tempo}
                      disabled={disabled()}
                      onInput={(e) => {
                        history.preview((s) => {
                          s.tempo = Number(e.target.value);
                        });
                      }}
                      onPointerUp={() => {
                        history.commitPreview();
                      }}
                      onKeyUp={() => {
                        history.commitPreview();
                      }}
                      onPointerCancel={() => {
                        history.cancelPreview();
                      }}
                    />
                    <NumericInput
                      class="control numeric"
                      aria-label="Tempo"
                      min={1}
                      max={300}
                      value={song().tempo}
                      disabled={disabled()}
                      onCommit={(value) => {
                        edit((s) => {
                          s.tempo = clamp(Math.round(value), 1, 300);
                        });
                      }}
                    />
                  </span>
                </Setting>
                <Setting label="Rhythm" tooltip="Set the spacing for drawing notes">
                  <SelectWrap>
                    <select
                      class="control"
                      aria-label="Rhythm"
                      disabled={disabled()}
                      value={song().rhythm}
                      onChange={(event) => {
                        const { value } = event.currentTarget;
                        if (value === "snap") {
                          command("Snap Notes To Rhythm");
                        } else {
                          const rhythm = Number(value);
                          if (
                            rhythm === 3 ||
                            rhythm === 4 ||
                            rhythm === 6 ||
                            rhythm === 8 ||
                            rhythm === 24
                          ) {
                            edit((s) => {
                              s.rhythm = rhythm;
                            });
                          }
                        }
                        event.currentTarget.value = String(history.song.rhythm);
                      }}
                    >
                      {[3, 4, 6, 8, 24].map((n) => (
                        <option value={n}>{n === 24 ? "freehand" : `/${n}`}</option>
                      ))}
                      <option value="snap">Edit: Snap Notes To Rhythm</option>
                    </select>
                  </SelectWrap>
                </Setting>
                {
                  <SettingsNumber
                    label={"Beats per bar"}
                    value={song().beatsPerBar}
                    min={1}
                    apply={ops.setBeatsPerBar}
                    max={64}
                  />
                }
              </fieldset>
              <fieldset class="settings-group" aria-label="Arrangement">
                {
                  <SettingsNumber
                    label={"Song length"}
                    value={song().barCount}
                    min={1}
                    apply={ops.setSongLength}
                  />
                }
                {
                  <SettingsNumber
                    label={"Tracks"}
                    value={song().channels.filter((t) => t.kind === "track").length}
                    min={1}
                    apply={(s, n) => {
                      ops.setChannelCount(s, "track", n);
                    }}
                  />
                }
                {
                  <SettingsNumber
                    label={"Automations"}
                    value={song().channels.filter((t) => t.kind === "automation").length}
                    min={0}
                    apply={(s, n) => {
                      ops.setChannelCount(s, "automation", n);
                    }}
                  />
                }
                {
                  <SettingsNumber
                    label={"Max patterns"}
                    value={song().patternCount}
                    min={1}
                    apply={ops.setPatternCount}
                  />
                }
              </fieldset>
            </section>
          </div>
        </aside>
      </div>
      <ChannelEditor
        onChannelCount={(kind, count) => {
          edit((s) => {
            ops.setChannelCount(s, kind, count);
          });
        }}
        song={song()}
        channel={channelIndex()}
        bar={bar()}
        selection={selection()}
        muted={muted()}
        playhead={playing() ? readPlayhead : null}
        disabled={disabled() || editorLocked()}
        editors={multiplayer().editors}
        localEditor={multiplayer().editorId}
        onSelect={select}
        onRectangle={extend}
        onAssign={(delta) => {
          edit((s) => {
            ops.assignPattern(
              s,
              selection(),
              ((channel().cells[bar()] ?? 0) + delta + s.patternCount + 1) % (s.patternCount + 1),
            );
          });
        }}
        onMute={(i) => {
          setMuted((previous) => {
            const next = new Set(previous);
            const { id } = required(song().channels[i]);
            if (next.has(id)) {
              next.delete(id);
            } else {
              next.add(id);
            }
            return next;
          });
        }}
        onLoop={(start, end, phase) => {
          if (phase === "preview") {
            history.preview((s) => {
              s.loopStart = start;
              s.loopEnd = end;
            });
          } else if (phase === "commit") {
            history.commitPreview();
          } else {
            history.cancelPreview();
          }
        }}
        onPointerBar={(b) => {
          pointer =
            b === null
              ? null
              : {
                  bar: Math.floor(b),
                  beat: (b % 1) * song().beatsPerBar,
                };
        }}
      />
      {multiplayer().status !== "offline" ? (
        <button
          type="button"
          class="control multiplayer-status"
          aria-label={`Multiplayer: ${connectionLabel(multiplayer())}`}
          title={multiplayer().address ?? "Multiplayer"}
          onClick={() => {
            open("multiplayer");
          }}
        >
          <Icon name="users" />
        </button>
      ) : null}
      {status() ? (
        <output class="status">
          <span>{status()}</span>
          <button
            type="button"
            class="control small"
            onClick={() => {
              setStatus("");
            }}
            aria-label="Dismiss message"
            title="Hide this message"
          >
            <Icon name="x" />
          </button>
        </output>
      ) : null}
      {dialog() ? (
        <div
          class="modal-backdrop"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) {
              dismissDialog();
            }
          }}
        >
          <dialog
            open
            ref={(element) => {
              dialogElement = element;
            }}
            class={`dialog ${dialog() === "preferences" || dialog() === "help" ? "categorized-dialog" : ""} ${dialog() === "preferences" ? "preferences-dialog" : ""}`}
            aria-modal="true"
            aria-label={dialogTitle[dialog() ?? "help"]}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                const focusable = [
                  ...e.currentTarget.querySelectorAll<HTMLElement>(
                    "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]",
                  ),
                ];
                const [first] = focusable;
                const last = focusable.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
              if (
                e.key === "Enter" &&
                !(e.target instanceof HTMLButtonElement) &&
                !(e.target instanceof HTMLSelectElement)
              ) {
                if (["sideways", "custom-scale", "layout"].includes(dialog() ?? "")) {
                  e.preventDefault();
                  dialogElement?.querySelector<HTMLButtonElement>("[data-confirm]")?.click();
                }
              }
            }}
          >
            <header>
              <h2>{dialogTitle[dialog() ?? "help"]}</h2>
              <button
                type="button"
                class="control small"
                aria-label="Close dialog"
                title={dialog() === "favorites" ? "Return to Add Assets" : "Return to the editor"}
                onClick={dismissDialog}
              >
                <Icon name="x" />
              </button>
            </header>
            {dialog() === "multiplayer" && (
              <MultiplayerDialog
                state={multiplayer()}
                connect={startMultiplayer}
                disconnect={() => {
                  multiplayerClient.disconnect();
                }}
              />
            )}
            {dialog() === "channel-settings" && (
              <>
                {
                  <SettingsNumber
                    label={"Tracks"}
                    value={song().channels.filter((t) => t.kind === "track").length}
                    min={1}
                    apply={(s, n) => {
                      ops.setChannelCount(s, "track", n);
                    }}
                  />
                }
                {
                  <SettingsNumber
                    label={"Automations"}
                    value={song().channels.filter((t) => t.kind === "automation").length}
                    min={0}
                    apply={(s, n) => {
                      ops.setChannelCount(s, "automation", n);
                    }}
                  />
                }
                {
                  <SettingsNumber
                    label={"Max patterns"}
                    value={song().patternCount}
                    min={1}
                    apply={ops.setPatternCount}
                  />
                }
              </>
            )}
            {dialog() === "preferences" && (
              <PreferencesDialogContent
                prefs={prefs()}
                song={song()}
                octave={octave()}
                onChange={pref}
                onChooseLayout={() => {
                  open("layout");
                }}
              />
            )}
            {dialog() === "help" && <HelpDialogContent />}
            {dialog() === "layout" && (
              <>
                <div class="layout-options">
                  {(["long", "tall"] as const).map((l) => (
                    <label
                      title={
                        l === "long"
                          ? "Place the arrangement below the note grid"
                          : "Place the arrangement beside the note grid"
                      }
                    >
                      <input
                        type="radio"
                        name="layout"
                        value={l}
                        checked={layoutDraft() === l}
                        onChange={() => {
                          setLayoutDraft(l);
                        }}
                      />
                      {l === "long" ? "Long" : "Tall"}
                      <div class={`layout-preview ${l}`}>
                        <span>Pattern</span>
                        <span>Settings</span>
                        <span>Channels</span>
                      </div>
                    </label>
                  ))}
                </div>
                <Actions
                  onOkay={() => {
                    pref("layout", layoutDraft());
                    close();
                  }}
                  onCancel={close}
                />
              </>
            )}
            {dialog() === "custom-scale" && (
              <>
                <div class="scale-toggles">
                  {noteNames.map((name, i) => (
                    <label
                      title={
                        i === 0
                          ? "Keep the root note in the scale"
                          : "Include this note in the scale"
                      }
                    >
                      <input
                        type="checkbox"
                        checked={customMask().includes(i)}
                        disabled={i === 0}
                        onChange={(e) => {
                          setCustomMask((previous) =>
                            e.target.checked
                              ? [...previous, i].sort((a, b) => a - b)
                              : previous.filter((p) => p !== i),
                          );
                        }}
                      />
                      {name}
                    </label>
                  ))}
                </div>
                <Actions
                  onOkay={() => {
                    edit((s) => {
                      s.customScale = [...customMask()];
                      s.scale = "Custom";
                    });
                    close();
                  }}
                  onCancel={close}
                />
              </>
            )}
            {dialog() === "sideways" && (
              <>
                <Setting label="Beat offset" tooltip="Move notes earlier or later">
                  <NumericInput
                    class="control numeric"
                    aria-label="Beat offset"
                    min={-song().beatsPerBar}
                    max={song().beatsPerBar}
                    step={1 / 24}
                    value={offset()}
                    onCommit={(value) => {
                      setOffset(clamp(value, -song().beatsPerBar, song().beatsPerBar));
                    }}
                  />
                </Setting>
                <Setting label="Strategy" tooltip="Choose where notes go past a bar edge">
                  <SelectWrap>
                    <select
                      class="control"
                      aria-label="Strategy"
                      value={strategy()}
                      onChange={(e) => {
                        setStrategy(e.target.value);
                      }}
                    >
                      <option value="overflow">Overflow notes across bars</option>
                      <option value="wrap">Wrap notes around within bars</option>
                    </select>
                  </SelectWrap>
                </Setting>
                <Actions
                  onOkay={() => {
                    edit((s) => {
                      ops.moveAllNotes(s, offset(), strategy() === "wrap");
                    });
                    pref("sidewaysStrategy", strategy());
                    close();
                  }}
                  onCancel={close}
                />
              </>
            )}
            {dialog() === "import" && (
              <>
                <input
                  aria-label="Song file"
                  title="Open a song or MIDI performance for editing"
                  type="file"
                  accept=".slopemp,.mid,.midi"
                  onInput={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      void importFile(file);
                    }
                  }}
                />
                <div class="dialog-actions">
                  <button
                    type="button"
                    class="control"
                    title="Return to the editor"
                    onClick={close}
                  >
                    <Icon name="x" leading />
                    Cancel
                  </button>
                </div>
              </>
            )}
            {dialog() === "export" && (
              <>
                <fieldset disabled={rendering() || Boolean(rendered())}>
                  <Setting label="File name" tooltip="Name the exported song">
                    <input
                      class="control"
                      aria-label="File name"
                      maxLength={250}
                      value={fileName()}
                      onInput={(e) => {
                        setFileName(e.target.value);
                      }}
                    />
                  </Setting>
                  <div class="export-scope">
                    <label title="Include the bars before the loop">
                      <input
                        type="checkbox"
                        checked={intro()}
                        disabled={song().loopStart === 0}
                        onChange={(e) => {
                          setIntro(e.target.checked);
                        }}
                      />
                      Intro
                    </label>
                    <label title="Set how many times the loop repeats in the export">
                      Loop Count{" "}
                      <NumericInput
                        class="control numeric"
                        aria-label="Loop Count"
                        min={1}
                        max={4}
                        value={loopCount()}
                        onCommit={(value) => {
                          setLoopCount(clamp(value, 1, 4));
                        }}
                      />
                    </label>
                    <label title="Include the bars after the loop">
                      <input
                        type="checkbox"
                        checked={outro()}
                        disabled={song().loopEnd === song().barCount}
                        onChange={(e) => {
                          setOutro(e.target.checked);
                        }}
                      />
                      Outro
                    </label>
                  </div>
                  <Setting label="File Type" tooltip="Choose an audio file or an editable song">
                    <SelectWrap>
                      <select
                        class="control"
                        aria-label="File Type"
                        value={format()}
                        onChange={(e) => {
                          setFormat(e.target.value);
                        }}
                      >
                        <option value="wav">.wav</option>
                        <option value="mp3">.mp3</option>
                        <option value="mid">.mid</option>
                        <option value="slopemp">.slopemp (editable song)</option>
                      </select>
                    </SelectWrap>
                  </Setting>
                </fieldset>
                {rendering() ? (
                  <progress aria-label="Audio generation" value={progress()} max={1} />
                ) : null}
                <div class="dialog-actions">
                  <button
                    type="button"
                    class="control accent"
                    title={
                      rendered()
                        ? "Save the finished audio file"
                        : "Save the song in the chosen format"
                    }
                    disabled={rendering()}
                    onClick={() => void exportFile()}
                  >
                    <Icon name={rendered() ? "device-floppy" : "file-export"} leading />
                    {rendered() ? "Save File" : "Export"}
                  </button>
                  <button
                    type="button"
                    class="control"
                    title="Return to the editor"
                    onClick={close}
                  >
                    <Icon name="x" leading />
                    Cancel
                  </button>
                </div>
              </>
            )}
            {assetDialogOpen() && (
              <AssetPanel
                song={song()}
                assets={assets()}
                favorites={favorites()}
                showFavorites={dialog() === "favorites"}
                onViewFavorites={() => {
                  showAssetDialog("favorites");
                }}
                onViewAssets={() => {
                  showAssetDialog("assets");
                }}
                onFavoritesChange={(value) => void changeFavorites(value)}
                onStatus={notifyAssets}
                onChange={(value, loaded) => {
                  if (loaded.size > 0) {
                    setAssetStates((previous) => {
                      const next = new Map(previous);
                      for (const [key, result] of loaded) {
                        next.set(key, { status: "ready", result });
                      }
                      return next;
                    });
                  }
                  edit((s) => {
                    s.resources = value;
                  });
                  close();
                }}
              />
            )}
            {assetDialogOpen() && assetDialogMessage() && (
              <p role="alert">{assetDialogMessage()}</p>
            )}
            {dialog() === "copy-url" && (
              <>
                <input
                  class="control wide"
                  aria-label="Song URL"
                  title="Copy this link to save or share the song"
                  readOnly
                  value={copyUrl()}
                  onFocus={(e) => {
                    e.target.select();
                  }}
                />
                <div class="dialog-actions">
                  <button
                    type="button"
                    class="control"
                    title="Return to the editor"
                    onClick={close}
                  >
                    <Icon name="x" leading />
                    Close
                  </button>
                </div>
              </>
            )}
          </dialog>
        </div>
      ) : null}
    </main>
  );
};
