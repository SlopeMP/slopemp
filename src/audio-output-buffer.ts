export const audioBlockFrames = 256;
const readCursor = 0;
const writeCursor = 1;
const generationCursor = 2;
const queueLengthCursor = 3;
const controlBytes = 4 * Int32Array.BYTES_PER_ELEMENT;
const channelBytes = audioBlockFrames * Float32Array.BYTES_PER_ELEMENT;
const slotBytes = Float64Array.BYTES_PER_ELEMENT + Int32Array.BYTES_PER_ELEMENT + 2 * channelBytes;

export const nextAudioBlock = (index: number): number => (index + 1) >>> 0;

// The worker owns the write cursor and the worklet owns the read cursor.
// Publishing a cursor makes the slot's samples or playback time visible to its peer.
export class AudioOutputBuffer {
  public readonly buffer: SharedArrayBuffer;
  public readonly capacity: number;
  private readonly control: Int32Array<SharedArrayBuffer>;
  private readonly generations: Int32Array<SharedArrayBuffer>;
  private readonly times: Float64Array<SharedArrayBuffer>;
  private readonly samples: ReadonlyArray<{ left: Float32Array; right: Float32Array }>;

  public constructor(buffer: SharedArrayBuffer) {
    this.buffer = buffer;
    const slots = (buffer.byteLength - controlBytes) / slotBytes;
    this.capacity = slots;
    const timeBytes = slots * Float64Array.BYTES_PER_ELEMENT;
    const generationBytes = slots * Int32Array.BYTES_PER_ELEMENT;
    const sampleOffset = timeBytes + controlBytes + generationBytes;
    this.control = new Int32Array(buffer, 0, 4);
    this.times = new Float64Array(buffer, controlBytes, slots);
    this.generations = new Int32Array(buffer, controlBytes + timeBytes, slots);
    this.samples = Array.from({ length: slots }, (_, slot) => {
      const offset = sampleOffset + slot * channelBytes * 2;
      return {
        left: new Float32Array(buffer, offset, audioBlockFrames),
        right: new Float32Array(buffer, offset + channelBytes, audioBlockFrames),
      };
    });
  }

  public get queuedBlocks(): number {
    return Atomics.load(this.control, queueLengthCursor);
  }

  public get readIndex(): number {
    return Atomics.load(this.control, readCursor) >>> 0;
  }

  public get writeIndex(): number {
    return Atomics.load(this.control, writeCursor) >>> 0;
  }

  public get generation(): number {
    return Atomics.load(this.control, generationCursor);
  }

  public set generation(generation: number) {
    Atomics.store(this.control, generationCursor, generation);
  }

  public static create(sampleRate: number, baseLatency = 0): AudioOutputBuffer {
    // Audio callbacks can consume several blocks before the worker gets CPU time.
    // Keep at least 20 ms queued, scaling with the device's processing latency.
    const latency = Number.isFinite(baseLatency) ? Math.max(0, baseLatency) : 0;
    const seconds = Math.max(0.02, Math.min(0.1, 2 * latency));
    const queuedBlocks = Math.max(2, Math.ceil((sampleRate * seconds) / audioBlockFrames));
    // Reserve two generations. Power-of-two capacity keeps slot addressing
    // continuous when the unsigned 32-bit cursors wrap.
    const slots = 2 ** Math.ceil(Math.log2(2 * queuedBlocks));
    const output = new AudioOutputBuffer(new SharedArrayBuffer(controlBytes + slots * slotBytes));
    Atomics.store(output.control, queueLengthCursor, queuedBlocks);
    return output;
  }

  public hasSpace(observedRead: number): boolean {
    const occupied = (this.writeIndex - observedRead) >>> 0;
    return occupied < this.capacity;
  }

  public block(index: number): { left: Float32Array; right: Float32Array } {
    const block = this.samples[index % this.capacity];
    if (!block) {
      throw new RangeError("Invalid audio buffer slot.");
    }
    return block;
  }

  public blockGeneration(index: number): number {
    return this.generations[index % this.capacity] ?? 0;
  }

  public consumedTime(index: number): number {
    return this.times[index % this.capacity] ?? 0;
  }

  public writeBlock(left: Float32Array, right: Float32Array): void {
    const index = this.writeIndex;
    const block = this.block(index);
    block.left.set(left);
    block.right.set(right);
    this.generations[index % this.capacity] = this.generation;
    Atomics.store(this.control, writeCursor, nextAudioBlock(index));
  }

  public release(index: number, time?: number): void {
    if (time !== undefined) {
      this.times[index % this.capacity] = time;
    }
    Atomics.store(this.control, readCursor, nextAudioBlock(index));
    Atomics.notify(this.control, readCursor, 1);
  }

  public async waitForRead(observedRead: number): Promise<void> {
    const wait = Atomics.waitAsync(this.control, readCursor, observedRead);
    if (wait.async) {
      await wait.value;
    }
  }
}
