/*!
 * Copyright (c) John Nesky and contributing authors.
 * SPDX-License-Identifier: MIT
 * See ../license/README.md for the source and license.
 */
import { required } from "./model";
const chorusPeriodSeconds = 2;
const chorusDelayRange = 0.0034;
const chorusDelayOffsets: ReadonlyArray<readonly number[]> = [
  [1.51, 2.1, 3.35],
  [1.47, 2.15, 3.25],
];
const chorusPhaseOffsets: ReadonlyArray<readonly number[]> = [
  [0, 2.1, 4.2],
  [3.2, 5.3, 1],
];
const chorusMaxDelay = chorusDelayRange * (1 + Math.max(...chorusDelayOffsets.flat()));

// The amount slider changes the delayed voices' gain. The pitch movement
// stays fixed at a slow two-second cycle, even at the highest amount.
export class Chorus {
  public readonly sampleRate: number;
  public readonly output: [number, number] = [0, 0];
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readonly mask: number;
  private readonly range: number;
  private readonly angle: number;
  private readonly offsets: number[][];
  private index = 0;
  private phase = 0;
  private amount = -1;
  private voiceMult = 0;
  private combinedMult = 1;

  public constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    const length = 2 ** Math.ceil(Math.log2(sampleRate * chorusMaxDelay));
    this.left = new Float32Array(length);
    this.right = new Float32Array(length);
    this.mask = length - 1;
    this.range = sampleRate * chorusDelayRange;
    this.angle = (Math.PI * 2) / (chorusPeriodSeconds * sampleRate);
    this.offsets = chorusDelayOffsets.map((offsets) =>
      offsets.map((offset) => length - offset * this.range),
    );
  }

  public process(left: number, right: number, amount: number): [number, number] {
    if (this.amount !== amount) {
      this.amount = amount;
      const normalized = amount / 100;
      this.voiceMult = normalized * 0.6 + normalized ** 6 * 0.4;
      this.combinedMult = 1 / Math.sqrt(3 * this.voiceMult * this.voiceMult + 1);
    }
    if (amount === 0) {
      this.output[0] = left;
      this.output[1] = right;
      return this.output;
    }
    this.phase %= Math.PI * 2;
    for (let channel = 0; channel < 2; channel++) {
      const buffer = channel === 0 ? this.left : this.right;
      const input = channel === 0 ? left : right;
      const offsets = required(this.offsets[channel]);
      const phases = required(chorusPhaseOffsets[channel]);
      const tap0 = this.read(buffer, required(offsets[0]), required(phases[0]));
      const tap1 = this.read(buffer, required(offsets[1]), required(phases[1]));
      const tap2 = this.read(buffer, required(offsets[2]), required(phases[2]));
      buffer[this.index] = input;
      this.output[channel] = this.combinedMult * (input + this.voiceMult * (tap1 - tap0 - tap2));
    }
    this.index = (this.index + 1) & this.mask;
    this.phase += this.angle;
    return this.output;
  }

  private read(buffer: Float32Array, offset: number, phase: number): number {
    const position = this.index + offset - this.range * Math.sin(this.phase + phase);
    const fraction = position % 1;
    const a = required(buffer[position & this.mask]);
    const b = required(buffer[(position + 1) & this.mask]);
    return a + (b - a) * fraction;
  }
}
