// Copyright (c) John Nesky and contributing authors.
// SPDX-License-Identifier: MIT
// See ../../license/README.md for the source and license.

export const scaleElementsByFactor = (array: Float32Array, factor: number): void => {
  for (let i: number = 0; i < array.length; i++) {
    array[i] = (array[i] ?? 0) * factor;
  }
};

const isPowerOf2 = (n: number): boolean => {
  return Boolean(n) && !(n & (n - 1));
};

const countBits = (n: number): number => {
  if (!isPowerOf2(n)) {
    throw new Error("FFT array length must be a power of 2.");
  }
  return Math.round(Math.log(n) / Math.log(2));
};

// Rearranges the elements of the array, swapping the element at an index
// with an element at an index that is the bitwise reverse of the first
// index in base 2. Useful for computing the FFT.
const reverseIndexBits = (array: Float32Array, fullArrayLength: number): void => {
  const bitCount: number = countBits(fullArrayLength);
  const finalShift: number = 32 - bitCount;
  for (let i: number = 0; i < fullArrayLength; i++) {
    // Dear JavaScript: Please support bit order reversal intrinsics. Thanks! :D
    let j: number = ((i >> 1) & 1_431_655_765) | ((i & 1_431_655_765) << 1);
    j = ((j >> 2) & 858_993_459) | ((j & 858_993_459) << 2);
    j = ((j >> 4) & 252_645_135) | ((j & 252_645_135) << 4);
    j = ((j >> 8) & 16_711_935) | ((j & 16_711_935) << 8);
    j = ((j >> 16) & 65_535) | ((j & 65_535) << 16);
    j >>>= finalShift;

    if (j > i) {
      const temp: number = array[i] ?? 0;
      array[i] = array[j] ?? 0;
      array[j] = temp;
    }
  }
};

export const inverseRealFourierTransform = (array: Float32Array, fullArrayLength: number): void => {
  const totalPasses: number = countBits(fullArrayLength);
  if (fullArrayLength < 4) {
    throw new Error("FFT array length must be at least 4.");
  }

  // Perform all but the last few passes in reverse.
  for (let pass: number = totalPasses - 1; pass >= 2; pass--) {
    const subStride: number = 1 << pass;
    const midSubStride: number = subStride >> 1;
    const stride: number = subStride << 1;
    const radiansIncrement: number = (Math.PI * 2) / stride;
    const cosIncrement: number = Math.cos(radiansIncrement);
    const sinIncrement: number = Math.sin(radiansIncrement);
    const oscillatorMultiplier: number = 2 * cosIncrement;

    for (let startIndex: number = 0; startIndex < fullArrayLength; startIndex += stride) {
      const startIndexA: number = startIndex;
      const midIndexA: number = startIndexA + midSubStride;
      const startIndexB: number = startIndexA + subStride;
      const midIndexB: number = startIndexB + midSubStride;
      const stopIndex: number = startIndexB + subStride;
      const realStartA: number = array[startIndexA] ?? 0;
      const imagStartB: number = array[startIndexB] ?? 0;
      array[startIndexA] = realStartA + imagStartB;
      array[midIndexA] = (array[midIndexA] ?? 0) * 2;
      array[startIndexB] = realStartA - imagStartB;
      array[midIndexB] = (array[midIndexB] ?? 0) * 2;
      let c: number = cosIncrement;
      let s: number = -sinIncrement;
      let cPrev: number = 1;
      let sPrev: number = 0;
      for (let index: number = 1; index < midSubStride; index++) {
        const indexA0: number = startIndexA + index;
        const indexA1: number = startIndexB - index;
        const indexB0: number = startIndexB + index;
        const indexB1: number = stopIndex - index;
        const real0: number = array[indexA0] ?? 0;
        const real1: number = array[indexA1] ?? 0;
        const imag0: number = array[indexB0] ?? 0;
        const imag1: number = array[indexB1] ?? 0;
        const tempA: number = real0 - real1;
        const tempB: number = imag0 + imag1;
        array[indexA0] = real0 + real1;
        array[indexA1] = imag1 - imag0;
        array[indexB0] = tempA * c - tempB * s;
        array[indexB1] = tempB * c + tempA * s;
        const cTemp: number = oscillatorMultiplier * c - cPrev;
        const sTemp: number = oscillatorMultiplier * s - sPrev;
        cPrev = c;
        sPrev = s;
        c = cTemp;
        s = sTemp;
      }
    }
  }

  // The final passes with strides 4 and 2, combined into one loop.
  for (let index: number = 0; index < fullArrayLength; index += 4) {
    const index1: number = index + 1;
    const index2: number = index + 2;
    const index3: number = index + 3;
    const real0: number = array[index] ?? 0;
    const real1: number = (array[index1] ?? 0) * 2;
    const imag2: number = array[index2] ?? 0;
    const imag3: number = (array[index3] ?? 0) * 2;
    const tempA: number = real0 + imag2;
    const tempB: number = real0 - imag2;
    array[index] = tempA + real1;
    array[index1] = tempA - real1;
    array[index2] = tempB + imag3;
    array[index3] = tempB - imag3;
  }

  reverseIndexBits(array, fullArrayLength);
};
