import { describe, expect, test } from "bun:test";

import {
  AudioEngine,
  envelopeValue,
  evaluateAutomation,
  processEffect,
  registerAudioResource,
  registerSoundFont,
  SongRenderer,
  waveSample,
} from "../../src/audio";
import { evaluateLane } from "../../src/automation";
import { exportSequence } from "../../src/formats";
import {
  createEffect,
  createEnvelope,
  createInstrument,
  EFFECT_GROUPS,
  EFFECT_PARAMETERS,
  INSTRUMENT_TYPES,
  presetInstrument,
  validateInstrument,
  validFMGraph,
} from "../../src/instruments";
import { exportMidi, importMidi, keyboardPitch, PerformanceRecorder } from "../../src/midi";
import type { Song } from "../../src/model";
import { createChannel, createNote, createSong, required, validateSong } from "../../src/model";
import { renderMp3, renderWav } from "./export-worker-fixture";
const shortSong = (): Song => {
  const song = createSong();
  song.barCount = 1;
  song.beatsPerBar = 1;
  song.loopEnd = 1;
  song.tempo = 300;
  for (const channel of song.channels) {
    channel.cells = [1];
    required(channel.patterns[1]).notes = [createNote(0, 0.8, 48)];
  }
  return song;
};
const rms = (samples: number[]): number => {
  return Math.sqrt(samples.reduce((sum, value): number => sum + value * value, 0) / samples.length);
};
describe("instrument configuration", (): void => {
  test("all types construct valid independent configurations", (): void => {
    for (const type of INSTRUMENT_TYPES) {
      const instrument = createInstrument(type);
      expect(validateInstrument(instrument)).toBe(true);
      expect(instrument.customWave).toHaveLength(64);
      expect(instrument.operators).toHaveLength(4);
      expect(instrument.harmonics).toHaveLength(28);
      expect(instrument.spectrum).toHaveLength(30);
      required(instrument.operators[0]).customWave[0] = 20;
      expect(required(instrument.operators[1]).customWave[0]).toBe(0);
    }
  });
  test("instrument volume accepts 0–250% and rejects values outside the range", () => {
    const instrument = createInstrument();
    for (const volume of [0, 1, 1.5, 2.5]) {
      expect(validateInstrument({ ...instrument, volume })).toBe(true);
    }
    for (const volume of [-0.01, 2.51, Number.NaN, Infinity]) {
      expect(validateInstrument({ ...instrument, volume })).toBe(false);
    }
  });
  test("presets preserve mix values and identity", (): void => {
    const before = createInstrument();
    before.volume = 0.31;
    before.presetEffects = false;
    const after = presetInstrument("grand piano", before);
    expect(after.id).toBe(before.id);
    expect(after.volume).toBe(0.31);
    expect(after.presetEffects).toBe(false);
    expect(after.preset).toBe("grand piano");
  });
  test("FM rejects cycles, nonexistent nodes and absent carriers", (): void => {
    const instrument = createInstrument("FM (n-op)");
    expect(validFMGraph(instrument.operators, instrument.connections)).toBe(true);
    expect(
      validFMGraph(instrument.operators, [
        ...instrument.connections,
        { from: required(instrument.operators[0]).id, to: required(instrument.operators[1]).id },
      ]),
    ).toBe(false);
    expect(
      validFMGraph(instrument.operators, [
        { from: "missing", to: required(instrument.operators[0]).id },
      ]),
    ).toBe(false);
    expect(
      validFMGraph(
        instrument.operators.map((operator) => ({ ...operator, carrier: false })),
        [],
      ),
    ).toBe(false);
  });
  test("invalid imported operator data fails validation", (): void => {
    const instrument = createInstrument();
    required(instrument.operators[0]).coarse = 49;
    expect(validateInstrument(instrument)).toBe(false);
  });
});
describe("envelopes", (): void => {
  test("every envelope starts exactly at A and stays between reversed endpoints", (): void => {
    for (const type of [
      "None",
      "Note Size",
      "Punch",
      "Flare",
      "Twang",
      "Swell",
      "Decay",
      "Sine",
      "Square",
      "Triangle",
      "Staged / SF2",
      "SF2",
    ]) {
      const envelope = { ...createEnvelope(), type, a: 2, b: -1 };
      expect(envelopeValue(envelope, 0)).toBe(2);
      for (const time of [0.001, 0.1, 0.5, 1, 10]) {
        const value = envelopeValue(envelope, time);
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThanOrEqual(2);
      }
    }
  });
  test("zero freezes and infinite speed has defined first tick and average", (): void => {
    const envelope = { ...createEnvelope(), type: "Sine", a: 2, b: -2, speed: 0 };
    expect(envelopeValue(envelope, 20)).toBe(2);
    envelope.speed = Infinity;
    expect(envelopeValue(envelope, 0)).toBe(2);
    expect(envelopeValue(envelope, 1)).toBe(0);
    envelope.type = "Decay";
    expect(envelopeValue(envelope, 1)).toBe(-2);
  });
});
describe("stereo effects", (): void => {
  test("Gain scales both channels in decibels and bypass preserves the input", (): void => {
    const effect = createEffect("Gain");
    expect(processEffect([0.2, -0.3], effect, 44_100, 0)).toEqual([0.2, -0.3]);
    effect.parameters["gain"] = 20;
    const amplified = processEffect([0.2, -0.3], effect, 44_100, 0);
    expect(amplified[0]).toBeCloseTo(2, 12);
    expect(amplified[1]).toBeCloseTo(-3, 12);
    effect.parameters["gain"] = -20;
    const attenuated = processEffect([0.2, -0.3], effect, 44_100, 0);
    expect(attenuated[0]).toBeCloseTo(0.02, 12);
    expect(attenuated[1]).toBeCloseTo(-0.03, 12);
    effect.enabled = false;
    expect(processEffect([0.2, -0.3], effect, 44_100, 0)).toEqual([0.2, -0.3]);
  });
  test("Monoize averages explicitly, bypass preserves stereo identity", (): void => {
    const effect = createEffect("Monoize");
    expect(processEffect([1, -0.5], effect, 44_100, 0)).toEqual([0.25, 0.25]);
    effect.enabled = false;
    expect(processEffect([1, -0.5], effect, 44_100, 0)).toEqual([1, -0.5]);
    expect(effect.parameters).toEqual({});
  });
  test("neutral pan and width preserve left/right channels", (): void => {
    expect(processEffect([0.3, -0.7], createEffect("Pan"), 44_100, 0)).toEqual([0.3, -0.7]);
    const pair = processEffect([0.3, -0.7], createEffect("Stereo Width"), 44_100, 0);
    expect(pair[0]).toBeCloseTo(0.3);
    expect(pair[1]).toBeCloseTo(-0.7);
  });
  test("sample reduction holds the processed sample without an added dry signal", (): void => {
    const effect = createEffect("Sample Rate Reduction");
    effect.parameters["sampleRate"] = 8000;
    expect(processEffect([0.5, -0.5], effect, 16_000, 0)).toEqual([0, 0]);
    expect(processEffect([0.25, -0.25], effect, 16_000, 1 / 16_000)).toEqual([0.25, -0.25]);
    expect(processEffect([0.9, -0.9], effect, 16_000, 2 / 16_000)).toEqual([0.25, -0.25]);
  });
  test("bit crushing replaces the input with quantized samples at unity gain", (): void => {
    const effect = createEffect("Bitcrusher");
    effect.parameters["bits"] = 2;
    // Old saved values and automation cannot restore the removed shared controls.
    effect.parameters["inputGain"] = 12;
    effect.parameters["outputGain"] = -12;
    effect.parameters["mix"] = 0;
    expect(
      processEffect([0.3, -0.4], effect, 8000, 0, {
        inputGain: -24,
        outputGain: 24,
        mix: 20,
      }),
    ).toEqual([0.25, -0.5]);
  });
  test("unexposed effect properties and automation cannot alter processing", (): void => {
    const hidden = {
      inputGain: 24,
      outputGain: -24,
      mix: 0,
      legacy: true,
      filterStage: "instrument",
      resourceId: "unreachable-impulse",
      resonance: 20,
      gain: 24,
      bias: 1,
      cents: 100,
      voices: 8,
      spread: 0,
      delay: 2,
      time: 0.001,
      feedback: 95,
      mode: "Loop",
      midGain: 24,
      sideGain: -24,
      width: 0,
      sampleRate: 100,
      threshold: -80,
      attack: 1,
      release: 5,
    };
    for (const type of Object.values(EFFECT_GROUPS).flat()) {
      if (type === "Vinyl Simulation") {
        continue;
      }
      const clean = createEffect(type);
      const polluted = structuredClone(clean);
      const editable = new Set((EFFECT_PARAMETERS[type] ?? []).map(({ key }) => key));
      const overrides: Record<string, number> = {};
      for (const [key, value] of Object.entries(hidden)) {
        if (!editable.has(key) && !(type === "EQ" && key === "gain")) {
          polluted.parameters[key] = value;
          if (typeof value === "number") {
            overrides[key] = value;
          }
        }
      }
      for (let frame = 0; frame < 2400; frame++) {
        const input: [number, number] = [Math.sin(frame * 0.17), Math.cos(frame * 0.13)];
        expect(
          processEffect(input, polluted, 1000, frame / 1000, overrides),
          `${type} at frame ${frame}`,
        ).toEqual(processEffect(input, clean, 1000, frame / 1000));
      }
    }
  });
  test("pitch and modulation transformations do not leak the unprocessed attack", (): void => {
    for (const type of [
      "Pitch Shift",
      "Detune",
      "Vibrato",
      "Frequency Shifter",
      "Rotary Speaker",
    ]) {
      expect(processEffect([0.5, -0.5], createEffect(type), 8000, 0)).toEqual([0, 0]);
    }
  });
  test("all catalog effects remain finite with bounded inputs", (): void => {
    for (const type of Object.values(EFFECT_GROUPS).flat()) {
      const effect = createEffect(type);
      for (let index = 0; index < 1000; index++) {
        const output = processEffect(
          [Math.sin(index) * 0.5, Math.cos(index) * 0.3],
          effect,
          8000,
          index / 8000,
        );
        expect(output.every(Number.isFinite)).toBe(true);
        expect(Math.max(...output.map(Math.abs))).toBeLessThan(10);
      }
    }
  });
  test("delay keeps immediate signal and independent instances retain independent state", (): void => {
    const first = createEffect("Echo");
    const second = createEffect("Echo");
    expect(processEffect([0.3, -0.6], first, 8000, 0)).toEqual([0.3, -0.6]);
    expect(processEffect([0, 0], second, 8000, 0)).toEqual([0, 0]);
  });
});
describe("automation and synthesis", (): void => {
  test("direct samples retain their values when rendering resumes in blocks", () => {
    const song = shortSong();
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    const instrument = createInstrument("FM (n-op)");
    instrument.attack = 0;
    channel.instruments = [instrument];
    const renderer = new SongRenderer(song, 8000);
    const left = new Float32Array(64);
    const right = new Float32Array(64);
    renderer.process(left, right);
    const first = renderer.sample();
    const expected: typeof first = [...first];
    const second = renderer.sample();
    expect(second).not.toBe(first);
    renderer.process(left, right);
    expect(first).toEqual(expected);
    expect(left.some((sample) => sample !== 0)).toBe(true);
    const third = renderer.sample();
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });
  test("lane interpolation ends at its explicit boundary", (): void => {
    const lane = {
      id: "lane",
      target: "tempo",
      enabled: true,
      interpolation: "linear" as const,
      points: [
        { time: 1, value: 100 },
        { time: 3, value: 200 },
      ],
    };
    expect(evaluateLane(lane, 0)).toBeUndefined();
    expect(evaluateLane(lane, 2)).toBe(150);
    expect(evaluateLane(lane, 4)).toBeUndefined();
  });
  test("lowest Song row overrides, zero cells/mutes restore bases", (): void => {
    const song = createSong();
    const first = createChannel("automation");
    const second = createChannel("automation");
    for (const [index, channel] of [first, second].entries()) {
      channel.cells[0] = 1;
      required(channel.patterns[1]).lanes = [
        {
          id: `lane-${index}`,
          target: "tempo",
          enabled: true,
          interpolation: "hold",
          points: [
            { time: 0, value: index ? 250 : 100 },
            { time: 8, value: index ? 250 : 100 },
          ],
        },
      ];
    }
    song.channels.push(first, second);
    expect(evaluateAutomation(song, 0, 2).tempo).toBe(250);
    expect(evaluateAutomation(song, 0, 2, new Set([second.id])).tempo).toBe(100);
    expect(evaluateAutomation(song, 5, 2).tempo).toBe(150);
  });
  test("wave generator rejects ultrasonic sources and centers drawn waves", (): void => {
    expect(waveSample("square", 0.1, 24_000, 44_100)).toBe(0);
    const constant = Array.from({ length: 64 }, (): number => 12);
    expect(waveSample("custom", 0.25, 440, 44_100, 0.5, constant)).toBe(0);
  });
  test("all synthesis types with resolved sources generate finite nonzero audio", (): void => {
    registerAudioResource(
      "test-sample",
      Float32Array.from({ length: 100 }, (_, i): number => Math.sin(i / 5)),
      Float32Array.from({ length: 100 }, (_, i): number => Math.cos(i / 5)),
      8000,
    );
    for (const type of INSTRUMENT_TYPES.filter((candidate) => candidate !== "SoundFont")) {
      const song = shortSong();
      song.channels = song.channels.slice(0, 1);
      required(song.channels[0]).instruments = [createInstrument(type)];
      const renderer = new SongRenderer(song, 8000);
      const samples = Array.from({ length: 1000 }, (): number => renderer.sample()[0]);
      expect(samples.every(Number.isFinite)).toBe(true);
      expect(rms(samples)).toBeGreaterThan(0.0001);
    }
  });
  test("instrument gain scales audio above 100% across synthesis engines", () => {
    for (const type of ["chip wave", "FM (n-op)"]) {
      const song = shortSong();
      song.channels = song.channels.slice(0, 1);
      const instrument = createInstrument(type);
      required(song.channels[0]).instruments = [instrument];
      const levels = [1, 1.5, 2.5].map((volume) => {
        instrument.volume = volume;
        const renderer = new SongRenderer(structuredClone(song), 8000);
        return rms(Array.from({ length: 1000 }, () => renderer.sample()[0]));
      });
      expect(required(levels[0])).toBeGreaterThan(0);
      expect(required(levels[1]) / required(levels[0])).toBeCloseTo(1.5, 4);
      expect(required(levels[2]) / required(levels[0])).toBeCloseTo(2.5, 4);
    }
  });
  test("mute silences tracks and Auto mute bypasses processing", (): void => {
    const song = shortSong();
    const renderer = new SongRenderer(song, 8000);
    renderer.muted = new Set(song.channels.map((channel) => channel.id));
    expect(
      Array.from({ length: 100 }, (): number => renderer.sample()[0]).every((value) => value === 0),
    ).toBe(true);
  });
  test("finite sequence counts intro, repetitions, outro independently", (): void => {
    const song = createSong();
    song.loopStart = 2;
    song.loopEnd = 4;
    expect(exportSequence(song, { intro: false, outro: false, loopCount: 2 })).toEqual([
      2, 3, 2, 3,
    ]);
  });
  test("Next Bar events terminate rather than cycling at zero time", (): void => {
    const song = shortSong();
    const auto = createChannel("automation", 1, 8);
    auto.cells[0] = 1;
    required(auto.patterns[1]).lanes = [
      {
        id: "jump",
        target: "nextBar",
        enabled: true,
        interpolation: "hold",
        points: [{ time: 0, value: 1 }],
      },
    ];
    song.channels.push(auto);
    const renderer = new SongRenderer(song, 8000, 0, [0, 0]);
    let count = 0;
    while (renderer.playing && count < 10_000) {
      renderer.sample();
      count++;
    }
    expect(count).toBeLessThan(200);
    expect(count).toBeGreaterThan(1);
  });
  test("malformed SoundFont fails without replacing resources", (): void => {
    expect((): Array<{ name: string; bank: number; program: number }> =>
      registerSoundFont("bad", new ArrayBuffer(12)),
    ).toThrow("valid SF2 or SF3 SoundFont");
  });
  test("AudioEngine can initialize without browser AudioContext until first user action", (): void => {
    const engine = new AudioEngine(createSong());
    expect(engine.playing).toBe(false);
    engine.seek(2, 0.5);
    expect(engine.bar).toBe(2);
    expect(engine.beat).toBe(0.5);
  });
});
describe("audio exports", (): void => {
  test("WAV is stereo PCM of the exact finite duration and excludes listening state", async (): Promise<void> => {
    const song = shortSong();
    const blob = await renderWav(song, { sampleRate: 8000 });
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    expect(blob.type).toBe("audio/wav");
    expect(new TextDecoder().decode(buffer.slice(0, 4))).toBe("RIFF");
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true) / 4).toBeCloseTo(1600, 0);
    expect(buffer.byteLength).toBeGreaterThan(44);
  });
  test("MP3 output is encoded MPEG and never a mislabeled WAV", async (): Promise<void> => {
    const blob = await renderMp3(shortSong());
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(blob.type).toBe("audio/mpeg");
    expect(bytes[0]).toBe(255);
    expect((bytes[1] ?? 0) & 224).toBe(224);
    expect(bytes.length).toBeGreaterThan(1000);
  });
  test("unresolved samples block export with relink guidance", async (): Promise<void> => {
    const song = shortSong();
    const instrument = createInstrument("chip wave");
    instrument.resourceId = "missing";
    required(song.channels[0]).instruments = [instrument];
    expect(await renderWav(song).catch(String)).toContain("Relink");
  });
  test("abort stops rendering", async (): Promise<void> => {
    const controller = new AbortController();
    controller.abort();
    expect(await renderWav(shortSong(), { signal: controller.signal }).catch(String)).toContain(
      "cancelled",
    );
  });
});
describe("performance and MIDI", (): void => {
  test("physical layouts handle gaps, independent key geometry and bounds", (): void => {
    expect(keyboardPitch("KeyA", "Wicki-Hayden", 4)).toBe(51);
    expect(keyboardPitch("KeyS", "Wicki-Hayden", 4)).toBe(53);
    expect(keyboardPitch("KeyQ", "Wicki-Hayden", 4)).toBe(56);
    expect(keyboardPitch("KeyA", "piano starting at C Major", 4)).toBeUndefined();
    expect(keyboardPitch("KeyZ", "piano starting at C Major", 4, 5)).toBe(43);
    expect(keyboardPitch("KeyZ", "piano transposing C Major to song key", 4, 5)).toBe(48);
    expect(keyboardPitch("Space", "Wicki-Hayden", 4)).toBeUndefined();
  });
  test("recording creates isolated replacement patterns and splits chords/barlines", (): void => {
    const song = shortSong();
    song.barCount = 2;
    song.loopEnd = 2;
    for (const channel of song.channels) {
      channel.cells = [1, 1];
    }
    const recorder = new PerformanceRecorder(song, 0);
    recorder.noteOn(48, 0.1);
    recorder.noteOn(52, 0.5);
    recorder.noteOff(48, 1.25);
    recorder.noteOff(52, 1.5);
    const result = recorder.finish(1.5);
    validateSong(result);
    expect(required(result.channels[0]).cells[0]).not.toBe(1);
    expect(required(result.channels[0]).cells[1]).not.toBe(1);
    const first = required(
      required(result.channels[0]).patterns[required(required(result.channels[0]).cells[0])],
    );
    expect(first.notes.some((note) => note.pitches.length === 2)).toBe(true);
    expect(required(result.channels[1]).cells).toEqual([1, 1]);
    expect(required(song.channels[0]).cells).toEqual([1, 1]);
  });
  test("very short taps are retained and silence produces no song edit", (): void => {
    const song = shortSong();
    const recorder = new PerformanceRecorder(song, 0);
    expect(recorder.finish(2)).toEqual(song);
    recorder.noteOn(40, 0.1);
    recorder.noteOff(40, 0.10001);
    const result = recorder.finish(0.2);
    const { notes } = required(
      required(result.channels[0]).patterns[required(required(result.channels[0]).cells[0])],
    );
    expect(required(notes[0]).end - required(notes[0]).start).toBeCloseTo(1 / 24);
    validateSong(result);
  });
  test("MIDI round trip preserves pitches, meter and base tempo", (): void => {
    const song = shortSong();
    for (const channel of song.channels) {
      channel.instruments = [createInstrument()];
    }
    const bytes = exportMidi(song, { intro: false, outro: false });
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("MThd");
    const loaded = importMidi(bytes);
    validateSong(loaded);
    expect(loaded.tempo).toBe(song.tempo);
    expect(loaded.beatsPerBar).toBe(1);
    expect(required(required(required(loaded.channels[0]).patterns[1]).notes[0]).pitches).toEqual([
      48,
    ]);
  });
  test("malformed MIDI is rejected without mutating an existing song", (): void => {
    expect((): Song => importMidi(new Uint8Array([77, 84, 104]))).toThrow();
    expect((): Song => importMidi(new Uint8Array(40))).toThrow("not a MIDI");
  });
});
describe("distinct processing behavior", (): void => {
  const response = (
    type: string,
    frequency: number,
    configure?: (effect: ReturnType<typeof createEffect>) => void,
  ): number => {
    const effect = createEffect(type);
    effect.parameters["frequency"] = 1000;
    if (type === "EQ") {
      effect.parameters["bandCount"] = 1;
    }
    configure?.(effect);
    const samples: number[] = [];
    for (let index = 0; index < 8000; index++) {
      const value = Math.sin((index * 2 * Math.PI * frequency) / 16_000);
      const output = processEffect([value, value], effect, 16_000, index / 16_000);
      if (index > 4000) {
        samples.push(output[0]);
      }
    }
    return rms(samples);
  };
  test("low/high pass and notch have distinct measured frequency responses", (): void => {
    expect(response("Low Pass", 200)).toBeGreaterThan(response("Low Pass", 5000) * 10);
    expect(response("High Pass", 5000)).toBeGreaterThan(response("High Pass", 200) * 10);
    expect(response("Notch", 1000)).toBeLessThan(response("Notch", 200) / 10);
  });
  test("parametric EQ honors gain independently of cutoff filters", (): void => {
    expect(
      response("EQ", 1000, (effect) => {
        effect.parameters["gain"] = 12;
      }),
    ).toBeGreaterThan(response("EQ", 1000) * 3);
    expect(
      response("EQ", 1000, (effect) => {
        effect.parameters["gain"] = -12;
      }),
    ).toBeLessThan(response("EQ", 1000) / 3);
  });
  test("modulation, serial order and repeated instance identities change processing", (): void => {
    const crusher = createEffect("Bitcrusher");
    const drive = createEffect("Overdrive");
    crusher.parameters["bits"] = 2;
    drive.parameters["drive"] = 20;
    const left = processEffect(processEffect([0.173, -0.173], crusher, 8000, 0), drive, 8000, 0);
    const right = processEffect(processEffect([0.173, -0.173], drive, 8000, 0), crusher, 8000, 0);
    expect(left).not.toEqual(right);
    const tremolo = createEffect("Tremolo");
    tremolo.parameters["depth"] = 100;
    expect(processEffect([1, 1], tremolo, 8000, 0)[0]).toBe(0.5);
    expect(processEffect([1, 1], tremolo, 8000, 0.125)[0]).toBe(1);
  });
  test("recording transport passes loop and song ends using the musical clock", (): void => {
    const song = shortSong();
    const renderer = new SongRenderer(song, 8000);
    renderer.recording = true;
    for (let index = 0; index < 3201; index++) {
      renderer.sample();
    }
    expect(renderer.bar).toBe(2);
    expect(renderer.playing).toBe(true);
  });
});

describe("configured ordinary envelope stages", () => {
  test("the editor staged type honors delay, hold and release from the instantaneous level", () => {
    const envelope = {
      ...createEnvelope(),
      type: "Staged / SF2",
      a: 0,
      b: 1,
      delay: 0.1,
      attack: 0.2,
      hold: 0.3,
      decay: 0.2,
      sustain: 0.5,
      release: 0.4,
    };
    expect(envelopeValue(envelope, 0.05)).toBe(0);
    expect(envelopeValue(envelope, 0.2)).toBeCloseTo(0.5);
    expect(envelopeValue(envelope, 0.4)).toBe(1);
    expect(envelopeValue(envelope, 0.7)).toBeCloseTo(0.75);
    expect(envelopeValue(envelope, 0.9)).toBe(0.5);
    expect(envelopeValue(envelope, 0.25, 0.25, 1, 0.15)).toBeCloseTo(0.1875);
    expect(envelopeValue(envelope, 1, 1, 1, 0.15)).toBe(0);
  });
  test("native volume and modulation laws keep their sustain units and key scaling", () => {
    const envelope = {
      ...createEnvelope(),
      type: "Staged / SF2",
      a: 0,
      b: 1,
      law: "SF2 volume",
      delay: -32_768,
      attack: -32_768,
      hold: -32_768,
      decay: -32_768,
      sustain: 60,
      release: 0,
    };
    expect(envelopeValue(envelope, 0.1)).toBeCloseTo(10 ** (-60 / 200));
    expect(envelopeValue({ ...envelope, law: "SF2 modulation", sustain: 500 }, 0.1)).toBe(0.5);
    const held = { ...envelope, hold: 0, keyToHold: 1200, sustain: 1440 };
    expect(envelopeValue(held, 0.75, 0.75, 1, undefined, 60)).toBe(1);
    expect(envelopeValue(held, 0.75, 0.75, 1, undefined, 61)).toBeLessThan(0.0001);
  });
  test("native modulator routes affect ordinary stages independently from preset stages", () => {
    const envelope = {
      ...createEnvelope(),
      type: "Staged / SF2",
      a: 0,
      b: 1,
      law: "SF2 modulation",
      delay: -32_768,
      attack: 0,
      hold: -32_768,
      decay: -32_768,
      sustain: 0,
      release: 0,
    };
    const routed = {
      ...envelope,
      sf2Modulators: [{ source: 3, destination: 26, amount: 1200, amountSource: 0, transform: 0 }],
    };
    expect(envelopeValue(envelope, 0.5, 0.5, 1, undefined, 127)).toBeCloseTo(0.5);
    expect(envelopeValue(routed, 0.5, 0.5, 1, undefined, 127)).toBeCloseTo(0.25);
    expect(Object.hasOwn(envelope, "sf2Modulators")).toBe(false);
  });
  test("note size follows expression at zero and infinite speed", () => {
    const envelope = { ...createEnvelope(), type: "Note Size", a: -1, b: 3, speed: 0 };
    expect(envelopeValue(envelope, 0.5, 0.5, 0.25)).toBe(0);
    expect(envelopeValue({ ...envelope, speed: Infinity }, 0.5, 0.5, 0.75)).toBe(2);
  });
});

test("native envelopes ignore hidden generator overrides and retain visible intermediate levels", () => {
  const envelope = {
    ...createEnvelope(),
    type: "Staged / SF2",
    a: 0,
    b: 1,
    law: "SF2 modulation",
    delay: 0,
    attack: 0,
    hold: -32_768,
    decay: -32_768,
    sustain: 0,
    release: 0,
    initialLevel: 0.2,
    terminalLevel: 0.3,
  };
  expect(envelopeValue(envelope, 0.5)).toBe(0.2);
  expect(envelopeValue({ ...envelope, sf2Generators: { 25: -32_768 } }, 0.5)).toBe(0.2);
  expect(envelopeValue(envelope, 2, 2, 1, 1)).toBeCloseTo(0.3);
});
test("multitap tap count and reverb gate hold produce distinct tails", () => {
  const impulse = (type: string, parameter: string, value: number): number[] => {
    const effect = createEffect(type);
    effect.parameters[parameter] = value;
    effect.parameters["time"] = 0.01;
    effect.parameters["feedback"] = 0;
    return Array.from(
      { length: 400 },
      (_, index) => processEffect([index === 0 ? 1 : 0, 0], effect, 1000, index / 1000)[0],
    );
  };
  const one = impulse("Multitap Delay", "taps", 1);
  const three = impulse("Multitap Delay", "taps", 3);
  expect(three[20]).toBeGreaterThan(required(one[20]));
  const short = impulse("Gated Reverb", "hold", 0.01);
  const long = impulse("Gated Reverb", "hold", 0.2);
  expect(Math.max(...short.slice(20).map(Math.abs))).toBe(0);
  expect(Math.max(...long.slice(20).map(Math.abs))).toBeGreaterThan(0);
});

test("factory reverbs use their visible enabled state and produce a tail", () => {
  const instrument = presetInstrument("celesta");
  const reverb = required(instrument.effects.find((effect) => effect.type === "Reverb"));
  expect(reverb.enabled).toBe(true);
  expect(reverb.parameters).not.toHaveProperty("mix");

  const render = (enabled: boolean): Float32Array => {
    const song = createSong();
    song.channels = song.channels.slice(0, 1);
    const channel = required(song.channels[0]);
    const copy = structuredClone(instrument);
    const effect = required(copy.effects.find((item) => item.id === reverb.id));
    effect.enabled = enabled;
    channel.instruments = [copy];
    channel.cells = [1];
    required(channel.patterns[1]).notes = [createNote(0, 0.25, 48)];
    const renderer = new SongRenderer(song, 44_100);
    const left = new Float32Array(44_100);
    renderer.process(left, new Float32Array(left.length));
    return left;
  };
  const dry = render(false);
  const wet = render(true);
  const tailDifference = wet.slice(22_050).reduce((sum, sample, index) => {
    return sum + Math.abs(sample - required(dry[index + 22_050]));
  }, 0);
  expect(tailDifference).toBeGreaterThan(0.01);
});
