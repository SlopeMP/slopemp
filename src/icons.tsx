import starFilled from "@tabler/icons/filled/star.svg" with { type: "text" };
import arrowDown from "@tabler/icons/outline/arrow-down.svg" with { type: "text" };
import arrowUp from "@tabler/icons/outline/arrow-up.svg" with { type: "text" };
import arrowsMaximize from "@tabler/icons/outline/arrows-maximize.svg" with { type: "text" };
import book from "@tabler/icons/outline/book.svg" with { type: "text" };
import category from "@tabler/icons/outline/category.svg" with { type: "text" };
import check from "@tabler/icons/outline/check.svg" with { type: "text" };
import chevronDown from "@tabler/icons/outline/chevron-down.svg" with { type: "text" };
import chevronRight from "@tabler/icons/outline/chevron-right.svg" with { type: "text" };
import chevronUp from "@tabler/icons/outline/chevron-up.svg" with { type: "text" };
import clipboardCopy from "@tabler/icons/outline/clipboard-copy.svg" with { type: "text" };
import clipboard from "@tabler/icons/outline/clipboard.svg" with { type: "text" };
import copy from "@tabler/icons/outline/copy.svg" with { type: "text" };
import deviceFloppy from "@tabler/icons/outline/device-floppy.svg" with { type: "text" };
import dice from "@tabler/icons/outline/dice.svg" with { type: "text" };
import download from "@tabler/icons/outline/download.svg" with { type: "text" };
import edit from "@tabler/icons/outline/edit.svg" with { type: "text" };
import externalLink from "@tabler/icons/outline/external-link.svg" with { type: "text" };
import fileExport from "@tabler/icons/outline/file-export.svg" with { type: "text" };
import file from "@tabler/icons/outline/file.svg" with { type: "text" };
import help from "@tabler/icons/outline/help.svg" with { type: "text" };
import infoCircle from "@tabler/icons/outline/info-circle.svg" with { type: "text" };
import keyboard from "@tabler/icons/outline/keyboard.svg" with { type: "text" };
import layout from "@tabler/icons/outline/layout.svg" with { type: "text" };
import listDetails from "@tabler/icons/outline/list-details.svg" with { type: "text" };
import microphone from "@tabler/icons/outline/microphone.svg" with { type: "text" };
import minus from "@tabler/icons/outline/minus.svg" with { type: "text" };
import music from "@tabler/icons/outline/music.svg" with { type: "text" };
import pencil from "@tabler/icons/outline/pencil.svg" with { type: "text" };
import piano from "@tabler/icons/outline/piano.svg" with { type: "text" };
import playerPause from "@tabler/icons/outline/player-pause.svg" with { type: "text" };
import playerPlay from "@tabler/icons/outline/player-play.svg" with { type: "text" };
import playerRecord from "@tabler/icons/outline/player-record.svg" with { type: "text" };
import playerSkipBack from "@tabler/icons/outline/player-skip-back.svg" with { type: "text" };
import playerSkipForward from "@tabler/icons/outline/player-skip-forward.svg" with { type: "text" };
import playerStop from "@tabler/icons/outline/player-stop.svg" with { type: "text" };
import plus from "@tabler/icons/outline/plus.svg" with { type: "text" };
import refresh from "@tabler/icons/outline/refresh.svg" with { type: "text" };
import repeat from "@tabler/icons/outline/repeat.svg" with { type: "text" };
import restore from "@tabler/icons/outline/restore.svg" with { type: "text" };
import settings from "@tabler/icons/outline/settings.svg" with { type: "text" };
import sparkles from "@tabler/icons/outline/sparkles.svg" with { type: "text" };
import star from "@tabler/icons/outline/star.svg" with { type: "text" };
import trash from "@tabler/icons/outline/trash.svg" with { type: "text" };
import volumeOff from "@tabler/icons/outline/volume-off.svg" with { type: "text" };
import volume from "@tabler/icons/outline/volume.svg" with { type: "text" };
import waveSine from "@tabler/icons/outline/wave-sine.svg" with { type: "text" };
import waveSquare from "@tabler/icons/outline/wave-square.svg" with { type: "text" };
import x from "@tabler/icons/outline/x.svg" with { type: "text" };
import zoomIn from "@tabler/icons/outline/zoom-in.svg" with { type: "text" };
import zoomOut from "@tabler/icons/outline/zoom-out.svg" with { type: "text" };
import type { JSX } from "solid-js";

// Only package-supplied SVGs are inserted, with their original currentColor strokes.
const icons = {
  "arrow-down": arrowDown,
  "arrow-up": arrowUp,
  "arrows-maximize": arrowsMaximize,
  book,
  category,
  check,
  "chevron-down": chevronDown,
  "chevron-right": chevronRight,
  "chevron-up": chevronUp,
  clipboard,
  "clipboard-copy": clipboardCopy,
  copy,
  "device-floppy": deviceFloppy,
  dice,
  download,
  edit,
  "external-link": externalLink,
  file,
  "file-export": fileExport,
  help,
  "info-circle": infoCircle,
  keyboard,
  layout,
  "list-details": listDetails,
  microphone,
  minus,
  music,
  pencil,
  piano,
  "player-pause": playerPause,
  "player-play": playerPlay,
  "player-record": playerRecord,
  "player-skip-back": playerSkipBack,
  "player-skip-forward": playerSkipForward,
  "player-stop": playerStop,
  plus,
  refresh,
  repeat,
  restore,
  settings,
  sparkles,
  star,
  "star-filled": starFilled,
  trash,
  volume,
  "volume-off": volumeOff,
  "wave-sine": waveSine,
  "wave-square": waveSquare,
  x,
  "zoom-in": zoomIn,
  "zoom-out": zoomOut,
};

export type IconName = keyof typeof icons;

export const Icon = (props: {
  readonly name: IconName;
  readonly leading?: boolean;
}): JSX.Element => (
  <span
    class="tabler-icon"
    classList={{ "tabler-icon-leading": props.leading }}
    aria-hidden="true"
    innerHTML={icons[props.name]}
  />
);
