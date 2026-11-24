// Published samples are read-only. Sharing their backing store avoids copying
// large decoded fonts for every playback and export worker.
export const createSampleBuffer = (length: number): Float32Array =>
  typeof SharedArrayBuffer === "function"
    ? new Float32Array(new SharedArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT))
    : new Float32Array(length);

export const shareSamples = (samples: Float32Array): Float32Array => {
  if (typeof SharedArrayBuffer !== "function" || samples.buffer instanceof SharedArrayBuffer) {
    return samples;
  }
  const shared = createSampleBuffer(samples.length);
  shared.set(samples);
  return shared;
};
