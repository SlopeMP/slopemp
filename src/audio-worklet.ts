import { audioBlockFrames, AudioOutputBuffer, nextAudioBlock } from "./audio-output-buffer";

type OutputOptions = { processorOptions: { output: SharedArrayBuffer } };

// These globals belong to AudioWorkletGlobalScope, which lib.dom does not expose.
declare const currentTime: number;
declare const sampleRate: number;
declare const registerProcessor: (name: string, processor: typeof SlopeOutput) => void;
declare class AudioWorkletProcessor {
  public constructor();
}

class SlopeOutput extends AudioWorkletProcessor {
  private readonly output: AudioOutputBuffer;
  private offset = 0;
  private generation = -1;
  private waiting = true;

  public constructor(options: OutputOptions) {
    super();
    this.output = new AudioOutputBuffer(options.processorOptions.output);
  }

  public process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [channels] = outputs;
    const [left, right] = channels ?? [];
    if (!left || !right) {
      return true;
    }
    const { output } = this;
    // Get the write cursor first so a block published after a generation change
    // cannot be read with the previous generation.
    const { writeIndex: end, generation, readIndex } = output;
    if (this.generation !== generation) {
      this.generation = generation;
      this.waiting = true;
      this.offset = 0;
    }
    let index = readIndex;
    let frame = 0;
    while (index !== end && frame < left.length) {
      if (output.blockGeneration(index) !== generation) {
        this.offset = 0;
        output.release(index);
        index = nextAudioBlock(index);
        continue;
      }
      // Cold voices and newly started workers can take longer than a quantum.
      // Begin each transport generation only after its scheduling margin exists.
      if (this.waiting) {
        if ((end - index) >>> 0 < output.queuedBlocks) {
          return true;
        }
        this.waiting = false;
      }
      const block = output.block(index);
      const count = Math.min(left.length - frame, audioBlockFrames - this.offset);
      for (let sample = 0; sample < count; sample++) {
        left[frame + sample] = block.left[this.offset + sample] ?? 0;
        right[frame + sample] = block.right[this.offset + sample] ?? 0;
      }
      frame += count;
      this.offset += count;
      if (this.offset === audioBlockFrames) {
        this.offset = 0;
        output.release(index, currentTime + frame / sampleRate);
        index = nextAudioBlock(index);
      }
    }
    // Web Audio zeroes each output channel before calling process.
    return true;
  }
}
registerProcessor("slope-output", SlopeOutput);
