import {
  applyTransaction,
  clone,
  createNote,
  createTransaction,
  emptyPattern,
  invertTransaction,
  required,
} from "./index";
import type { Channel, Song, Transaction } from "./index";

export const multiplayerFixture = (initial: Song): Transaction[] => {
  const transactions: Transaction[] = [];
  let song = initial;
  const edit = (recipe: (draft: Song) => void): Transaction => {
    const draft = clone(song);
    recipe(draft);
    const transaction = createTransaction(song, draft);
    song = applyTransaction(song, transaction);
    transactions.push(transaction);
    return transaction;
  };
  const first = required(initial.channels[0]).id;
  const second = required(initial.channels[1]).id;
  const track = (draft: Song, id: string): Channel =>
    required(draft.channels.find((entry) => entry.id === id));

  edit((draft) => {
    const channel = track(draft, first);
    channel.name = "Lead";
    channel.cells[0] = 1;
    channel.cells[2] = 1;
    required(channel.patterns[1]).notes = [
      { ...createNote(0, 2, [36, 40, 43]), id: "fixture-lead-intro" },
      { ...createNote(3, 6, 41, 2), id: "fixture-lead-finish" },
    ];
  });
  edit((draft) => {
    const channel = track(draft, second);
    channel.name = "Countermelody";
    channel.cells[1] = 2;
    required(channel.patterns[2]).notes = [
      { ...createNote(1, 4, 48), id: "fixture-countermelody-note" },
    ];
    draft.channels.reverse();
  });
  edit((draft) => {
    const channel = track(draft, first);
    const instrument = required(channel.instruments[0]);
    instrument.volume = 0.58;
    channel.effects.push({
      id: "fixture-fader",
      type: "Gain",
      enabled: true,
      parameters: { gain: 80 },
    });
    const patterns: Channel["patterns"] = Object.fromEntries(
      Array.from({ length: draft.patternCount }, (_, index) => [index + 1, emptyPattern()]),
    );
    required(patterns[1]).lanes.push({
      id: "fixture-automation-lane",
      target: "volume",
      enabled: true,
      interpolation: "linear",
      points: [
        { time: 0, value: 0.3 },
        { time: 4, value: 0.75 },
      ],
    });
    const cells = Array.from({ length: draft.barCount }, (_, index) => (index === 0 ? 1 : 0));
    draft.channels.splice(1, 0, {
      id: "fixture-automation",
      name: "Lead volume",
      kind: "automation",
      octave: 3,
      octaves: 3,
      cells,
      patterns,
      instruments: [],
      effects: [],
      target: { kind: "instrument", channelId: first, instrumentId: instrument.id },
      enabled: true,
    });
  });
  edit((draft) => {
    draft.resources.push({
      id: "fixture-sample-reference",
      url: "https://example.invalid/samples/piano.wav",
      rootKey: 57,
      loopStart: 100,
      loopEnd: 600,
    });
    const pattern = required(track(draft, first).patterns[1]);
    const note = required(pattern.notes[0]);
    note.pins.splice(1, 0, { time: 1, interval: 2, volume: 2 });
    draft.title = "Shared arrangement";
  });
  const last = edit((draft) => {
    draft.tempo = 165;
    draft.loopStart = 1;
    draft.loopEnd = 5;
    const counter = track(draft, second);
    counter.cells[1] = 0;
    counter.cells[3] = 2;
    const pattern = required(counter.patterns[2]);
    pattern.notes = [{ ...createNote(0, 1.5, [43, 55]), id: "fixture-countermelody-reprise" }];
  });
  transactions.push(invertTransaction(last), last);
  return transactions;
};
