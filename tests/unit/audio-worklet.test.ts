import { expect, test } from "bun:test";

import { audioBlockFrames, AudioOutputBuffer } from "../../src/audio-output-buffer";
import { required } from "../../src/model";

type OutputOptions = { processorOptions: { output: SharedArrayBuffer } };
type Output = { process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };

test("audio worklet consumes shared stereo blocks and skips stale playback", async () => {
  const output = new AudioOutputBuffer();
  const registered: Output[] = [];
  const globals = {
    currentTime: 10,
    sampleRate: audioBlockFrames,
    AudioWorkletProcessor: class {},
    registerProcessor: (_name: string, Processor: new (options: OutputOptions) => Output): void => {
      registered.push(new Processor({ processorOptions: { output: output.buffer } }));
    },
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  try {
    Object.assign(globalThis, globals);
    await import("../../src/audio-worklet");
    const processor = required(registered[0]);
    const write = (sample: number): void => {
      output.writeBlock(
        new Float32Array(audioBlockFrames).fill(sample),
        new Float32Array(audioBlockFrames).fill(-sample),
      );
    };
    const consume = (frames: number, time: number): Float32Array[] => {
      Object.assign(globalThis, { currentTime: time });
      const channels = [new Float32Array(frames), new Float32Array(frames)];
      expect(processor.process([], [channels])).toBe(true);
      return channels;
    };
    const expectStereo = (channels: Float32Array[], samples: number[]): void => {
      expect([...required(channels[0])]).toEqual(samples);
      expect([...required(channels[1])]).toEqual(
        samples.map((sample) => (sample === 0 ? 0 : -sample)),
      );
    };
    const samples = (count: number, value: number): number[] => Array<number>(count).fill(value);

    write(1);
    write(2);
    expectStereo(consume(audioBlockFrames - 32, 10), samples(audioBlockFrames - 32, 1));
    expect(output.readIndex).toBe(0);
    expectStereo(consume(128, 11 - 32 / audioBlockFrames), [...samples(32, 1), ...samples(96, 2)]);
    expect(output.readIndex).toBe(1);
    expect(output.consumedTime(0)).toBe(11);
    expectStereo(consume(audioBlockFrames, 11 + 96 / audioBlockFrames), [
      ...samples(audioBlockFrames - 96, 2),
      ...samples(96, 0),
    ]);
    expect(output.readIndex).toBe(2);
    expect(output.consumedTime(1)).toBe(12);

    write(3);
    write(4);
    expectStereo(consume(128, 12 + 96 / audioBlockFrames), samples(128, 3));
    const oldTimes = [output.consumedTime(2), output.consumedTime(3)];
    output.generation = 1;
    write(5);
    expectStereo(
      consume(audioBlockFrames, 12 + 224 / audioBlockFrames),
      samples(audioBlockFrames, 5),
    );
    expect(output.readIndex).toBe(5);
    expect([output.consumedTime(2), output.consumedTime(3)]).toEqual(oldTimes);
    expect(output.consumedTime(4)).toBe(13 + 224 / audioBlockFrames);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
