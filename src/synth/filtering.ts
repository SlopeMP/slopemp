/*!
 * Adapted from UltraBox 91b4bc1988e605ba5f5009f557e52ccb33975754.
 * Copyright (c) 2012-2022 John Nesky and contributing authors.
 * SPDX-License-Identifier: MIT
 * See ../../license/ultrabox-MIT.txt for the full license.
 */
import { required } from "../model";
export class FilterCoefficients {
  public readonly a: number[] = [1];

  public readonly b: number[] = [1];

  public order: number = 0;

  public allPass1stOrderInvertPhaseAbove(cornerRadiansPerSample: number): void {
    const g: number = (Math.sin(cornerRadiansPerSample) - 1) / Math.cos(cornerRadiansPerSample);
    this.a[1] = g;
    this.b[0] = g;
    this.b[1] = 1;
    this.order = 1;
  }

  public lowPass2ndOrderButterworth(cornerRadiansPerSample: number, peakLinearGain: number): void {
    const alpha: number = Math.sin(cornerRadiansPerSample) / (2 * peakLinearGain);
    const cos: number = Math.cos(cornerRadiansPerSample);
    const a0: number = 1 + alpha;
    this.a[1] = (-2 * cos) / a0;
    this.a[2] = (1 - alpha) / a0;
    this.b[0] = (1 - cos) / (2 * a0);
    this.b[2] = (1 - cos) / (2 * a0);
    this.b[1] = (1 - cos) / a0;
    this.order = 2;
  }

  public highShelf2ndOrder(
    cornerRadiansPerSample: number,
    shelfLinearGain: number,
    slope: number,
  ): void {
    const A: number = Math.sqrt(shelfLinearGain);
    const c: number = Math.cos(cornerRadiansPerSample);
    const Aplus: number = A + 1;
    const Aminus: number = A - 1;
    const alpha: number =
      Math.sin(cornerRadiansPerSample) * 0.5 * Math.sqrt((Aplus / A) * (1 / slope - 1) + 2);
    const sqrtA2Alpha: number = 2 * Math.sqrt(A) * alpha;
    const a0: number = Aplus - Aminus * c + sqrtA2Alpha;
    this.a[1] = (2 * (Aminus - Aplus * c)) / a0;
    this.a[2] = (Aplus - Aminus * c - sqrtA2Alpha) / a0;
    this.b[0] = (A * (Aplus + Aminus * c + sqrtA2Alpha)) / a0;
    this.b[1] = (-2 * A * (Aminus + Aplus * c)) / a0;
    this.b[2] = (A * (Aplus + Aminus * c - sqrtA2Alpha)) / a0;
    this.order = 2;
  }
}
export class FrequencyResponse {
  public real: number = 0;

  public imag: number = 0;

  public analyze(filter: FilterCoefficients, radiansPerSample: number): void {
    this.analyzeComplex(filter, Math.cos(radiansPerSample), Math.sin(radiansPerSample));
  }

  public analyzeComplex(filter: FilterCoefficients, real: number, imag: number): void {
    const a: number[] = filter.a;
    const b: number[] = filter.b;
    const realZ1: number = real;
    const imagZ1: number = -imag;
    let realNum: number = required(b[0]) + required(b[1]) * realZ1;
    let imagNum: number = required(b[1]) * imagZ1;
    let realDenom: number = 1 + required(a[1]) * realZ1;
    let imagDenom: number = required(a[1]) * imagZ1;
    let realZ: number = realZ1;
    let imagZ: number = imagZ1;
    for (let i: number = 2; i <= filter.order; i++) {
      const realTemp: number = realZ * realZ1 - imagZ * imagZ1;
      const imagTemp: number = realZ * imagZ1 + imagZ * realZ1;
      realZ = realTemp;
      imagZ = imagTemp;
      realNum += required(b[i]) * realZ;
      imagNum += required(b[i]) * imagZ;
      realDenom += required(a[i]) * realZ;
      imagDenom += required(a[i]) * imagZ;
    }
    this.real = realNum * realDenom + imagNum * imagDenom;
    this.imag = imagNum * realDenom - realNum * imagDenom;
  }

  public angle(): number {
    return Math.atan2(this.imag, this.real);
  }
}
export class DynamicBiquadFilter {
  public a1: number = 0;

  public a2: number = 0;

  public b0: number = 1;

  public b1: number = 0;

  public b2: number = 0;

  public a1Delta: number = 0;

  public a2Delta: number = 0;

  public b0Delta: number = 0;

  public b1Delta: number = 0;

  public b2Delta: number = 0;

  public output1: number = 0;

  public output2: number = 0;

  public resetOutput(): void {
    this.output1 = 0;
    this.output2 = 0;
  }

  public loadCoefficientsWithGradient(
    start: FilterCoefficients,
    end: FilterCoefficients,
    deltaRate: number,
  ): void {
    if (start.order !== 2 || end.order !== 2) {
      throw new Error("Invalid synthesis state.");
    }
    this.a1 = required(start.a[1]);
    this.a2 = required(start.a[2]);
    this.b0 = required(start.b[0]);
    this.b1 = required(start.b[1]);
    this.b2 = required(start.b[2]);
    this.a1Delta = (required(end.a[1]) - required(start.a[1])) * deltaRate;
    this.a2Delta = (required(end.a[2]) - required(start.a[2])) * deltaRate;
    this.b0Delta = (required(end.b[0]) / required(start.b[0])) ** deltaRate;
    this.b1Delta = (required(end.b[1]) / required(start.b[1])) ** deltaRate;
    this.b2Delta = (required(end.b[2]) / required(start.b[2])) ** deltaRate;
  }
}
