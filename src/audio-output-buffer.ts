export const audioBlockFrames = 512;
export const queuedAudioBlocks = 4;
// Leave room to queue a new transport generation before the worklet drops the old one.
const slots = 2 * queuedAudioBlocks;
const readCursor = 0;
const writeCursor = 1;
const generationCursor = 2;
const controlBytes = 3 * Int32Array.BYTES_PER_ELEMENT;
const generationBytes = slots * Int32Array.BYTES_PER_ELEMENT;
const timeBytes = slots * Float64Array.BYTES_PER_ELEMENT;
const sampleOffset = timeBytes + controlBytes + generationBytes;
const channelBytes = audioBlockFrames * Float32Array.BYTES_PER_ELEMENT;

export const nextAudioBlock = (index: number): number => (index + 1) >>> 0;

// The worker owns the write cursor and the worklet owns the read cursor.
// Publishing a cursor makes the slot's samples or playback time visible to its peer.
export class AudioOutputBuffer {
  public readonly buffer: SharedArrayBuffer;
  private readonly control: Int32Array<SharedArrayBuffer>;
  private readonly generations: Int32Array<SharedArrayBuffer>;
  private readonly times: Float64Array<SharedArrayBuffer>;
  private readonly samples: ReadonlyArray<{ left: Float32Array; right: Float32Array }>;

  public constructor(buffer = new SharedArrayBuffer(sampleOffset + slots * channelBytes * 2)) {
    this.buffer = buffer;
    this.times = new Float64Array(buffer, 0, slots);
    this.control = new Int32Array(buffer, timeBytes, 3);
    this.generations = new Int32Array(buffer, timeBytes + controlBytes, slots);
    this.samples = Array.from({ length: slots }, (_, slot) => {
      const offset = sampleOffset + slot * channelBytes * 2;
      return {
        left: new Float32Array(buffer, offset, audioBlockFrames),
        right: new Float32Array(buffer, offset + channelBytes, audioBlockFrames),
      };
    });
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

  public hasSpace(observedRead: number): boolean {
    const occupied = (this.writeIndex - observedRead) >>> 0;
    return occupied < slots;
  }

  public block(index: number): { left: Float32Array; right: Float32Array } {
    const block = this.samples[index % slots];
    if (!block) {
      throw new RangeError("Invalid audio buffer slot.");
    }
    return block;
  }

  public blockGeneration(index: number): number {
    return this.generations[index % slots] ?? 0;
  }

  public consumedTime(index: number): number {
    return this.times[index % slots] ?? 0;
  }

  public writeBlock(left: Float32Array, right: Float32Array): void {
    const index = this.writeIndex;
    const block = this.block(index);
    block.left.set(left);
    block.right.set(right);
    this.generations[index % slots] = this.generation;
    Atomics.store(this.control, writeCursor, nextAudioBlock(index));
  }

  public release(index: number, time?: number): void {
    if (time !== undefined) {
      this.times[index % slots] = time;
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
