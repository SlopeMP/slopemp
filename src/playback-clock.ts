export type AudioBlock = {
  id: number;
  start: number;
  end: number;
  duration: number;
  loopStart: number;
  loopEnd: number;
};

// Follow the audio already queued for output, rather than the renderer's future cursor.
// Output acknowledgments anchor interpolation to the AudioContext clock. When rendering
// falls behind, stop at the last available sample instead of drifting ahead of the sound.
export class PlaybackClock {
  private readonly blocks: AudioBlock[] = [];
  private startTime = 0;
  private stoppedPosition = 0;

  public reset(position: number): void {
    this.blocks.length = 0;
    this.stoppedPosition = position;
  }

  public enqueue(block: AudioBlock, time: number): void {
    if (this.blocks.length === 0) {
      this.startTime = time;
    }
    this.blocks.push(block);
  }

  public consumed(id: number, time: number): void {
    const index = this.blocks.findIndex((block) => block.id === id);
    if (index === -1) {
      return;
    }
    this.stoppedPosition = this.blocks[index]?.end ?? this.stoppedPosition;
    this.blocks.splice(0, index + 1);
    this.startTime = time;
  }

  public position(time: number): number {
    let elapsed = Math.max(0, time - this.startTime);
    for (const block of this.blocks) {
      if (elapsed >= block.duration) {
        elapsed -= block.duration;
        continue;
      }
      const loopLength = block.loopEnd - block.loopStart;
      const wraps = block.end < block.start && loopLength > 0;
      const advance = block.end - block.start + (wraps ? loopLength : 0);
      const position = block.start + advance * (elapsed / block.duration);
      return wraps && position >= block.loopEnd ? position - loopLength : position;
    }
    return this.blocks.at(-1)?.end ?? this.stoppedPosition;
  }
}
