import { required } from "../model";
// Noise generators and pitch filter adapted from UltraBox (MIT).
// See ../../license/ultrabox-MIT.txt.
import { inverseRealFourierTransform, scaleElementsByFactor } from "./fft";
export const noiseWaveLength = 1 << 15;
type NoiseDefinition = {
  name: string;
  expression: number;
  basePitch: number;
  pitchFilterMult: number;
  isSoft: boolean;
  samples: Float32Array | null;
};
export const noises: NoiseDefinition[] = [
  {
    name: "retro",
    expression: 0.25,
    basePitch: 69,
    pitchFilterMult: 1024,
    isSoft: false,
    samples: null,
  },
  { name: "white", expression: 1, basePitch: 69, pitchFilterMult: 8, isSoft: true, samples: null },
  {
    name: "clang",
    expression: 0.4,
    basePitch: 69,
    pitchFilterMult: 1024,
    isSoft: false,
    samples: null,
  },
  {
    name: "buzz",
    expression: 0.3,
    basePitch: 69,
    pitchFilterMult: 1024,
    isSoft: false,
    samples: null,
  },
  {
    name: "hollow",
    expression: 1.5,
    basePitch: 96,
    pitchFilterMult: 1,
    isSoft: true,
    samples: null,
  },
  {
    name: "shine",
    expression: 1,
    basePitch: 69,
    pitchFilterMult: 1024,
    isSoft: false,
    samples: null,
  },
  {
    name: "deep",
    expression: 1.5,
    basePitch: 120,
    pitchFilterMult: 1024,
    isSoft: true,
    samples: null,
  },
  {
    name: "cutter",
    expression: 0.005,
    basePitch: 96,
    pitchFilterMult: 1024,
    isSoft: false,
    samples: null,
  },
  {
    name: "metallic",
    expression: 1,
    basePitch: 96,
    pitchFilterMult: 1024,
    isSoft: false,
    samples: null,
  },
  {
    name: "static",
    expression: 1,
    basePitch: 96,
    pitchFilterMult: 1024,
    isSoft: false,
    samples: null,
  },
  {
    name: "1-bit white",
    expression: 0.5,
    basePitch: 74.41,
    pitchFilterMult: 1024,
    isSoft: false,
    samples: null,
  },
  {
    name: "1-bit metallic",
    expression: 0.5,
    basePitch: 86.41,
    pitchFilterMult: 1024,
    isSoft: false,
    samples: null,
  },
  {
    name: "crackling",
    expression: 0.9,
    basePitch: 69,
    pitchFilterMult: 1024,
    isSoft: false,
    samples: null,
  },
  { name: "pink", expression: 1, basePitch: 69, pitchFilterMult: 8, isSoft: true, samples: null },
  {
    name: "brownian",
    expression: 1,
    basePitch: 69,
    pitchFilterMult: 8,
    isSoft: true,
    samples: null,
  },
];
const getRetroWave = (): Float32Array => {
  const definition = required(noises[0]);
  if (definition.samples === null) {
    const wave = new Float32Array(noiseWaveLength + 1);
    // The "retro" drum uses a "Linear Feedback Shift Register" similar to the NES noise channel.
    let drumBuffer: number = 1;
    for (let i: number = 0; i < noiseWaveLength; i++) {
      wave[i] = (drumBuffer & 1) * 2 - 1;
      let newBuffer: number = drumBuffer >> 1;
      if (((drumBuffer + newBuffer) & 1) === 1) {
        newBuffer += 1 << 14;
      }
      drumBuffer = newBuffer;
    }
    wave[noiseWaveLength] = required(wave[0]);
    definition.samples = wave;
  }
  return definition.samples;
};
export const drawNoiseSpectrum = (
  wave: Float32Array,
  waveLength: number,
  lowOctave: number,
  highOctave: number,
  lowPower: number,
  highPower: number,
  overallSlope: number,
): number => {
  const referenceOctave: number = 11;
  const referenceIndex: number = 1 << referenceOctave;
  const lowIndex: number = Math.trunc(2 ** lowOctave);
  const highIndex: number = Math.min(waveLength >> 1, Math.trunc(2 ** highOctave));
  const retroWave: Float32Array = getRetroWave();
  let combinedAmplitude: number = 0;
  for (let i: number = lowIndex; i < highIndex; i++) {
    const lerped: number =
      lowPower + ((highPower - lowPower) * (Math.log2(i) - lowOctave)) / (highOctave - lowOctave);
    let amplitude: number = 2 ** ((lerped - 1) * 7 + 1) * lerped;
    amplitude *= (i / referenceIndex) ** overallSlope;
    combinedAmplitude += amplitude;
    amplitude *= required(retroWave[i]);
    const radians: number = 0.61803398875 * i * i * Math.PI * 2;
    wave[i] = Math.cos(radians) * amplitude;
    wave[waveLength - i] = Math.sin(radians) * amplitude;
  }
  return combinedAmplitude;
};
export const getDrumWave = (index: number): Float32Array => {
  if (index === 0) {
    return getRetroWave();
  }
  let wave: Float32Array | null = required(noises[index]).samples;
  if (wave === null) {
    wave = new Float32Array(noiseWaveLength + 1);
    required(noises[index]).samples = wave;

    if (index === 1) {
      // White noise is just random values for each sample.
      for (let i: number = 0; i < noiseWaveLength; i++) {
        wave[i] = Math.random() * 2 - 1;
      }
    } else if (index === 2) {
      // The clang waveform is based on a variant by DAzombieRE.
      let drumBuffer: number = 1;
      for (let i: number = 0; i < noiseWaveLength; i++) {
        wave[i] = (drumBuffer & 1) * 2 - 1;
        let newBuffer: number = drumBuffer >> 1;
        if (((drumBuffer + newBuffer) & 1) === 1) {
          newBuffer += 2 << 14;
        }
        drumBuffer = newBuffer;
      }
    } else if (index === 3) {
      // The buzz waveform is based on a variant by DAzombieRE.
      let drumBuffer: number = 1;
      for (let i: number = 0; i < noiseWaveLength; i++) {
        wave[i] = (drumBuffer & 1) * 2 - 1;
        let newBuffer: number = drumBuffer >> 1;
        if (((drumBuffer + newBuffer) & 1) === 1) {
          newBuffer += 10 << 2;
        }
        drumBuffer = newBuffer;
      }
    } else if (index === 4) {
      // "hollow" drums, designed in frequency space and then converted via FFT:
      drawNoiseSpectrum(wave, noiseWaveLength, 10, 11, 1, 1, 0);
      drawNoiseSpectrum(wave, noiseWaveLength, 11, 14, 0.6578, 0.6578, 0);
      inverseRealFourierTransform(wave, noiseWaveLength);
      scaleElementsByFactor(wave, 1 / Math.sqrt(noiseWaveLength));
    } else if (index === 5) {
      // "Shine" drums from modbox!
      let drumBuffer = 1;
      for (let i = 0; i < noiseWaveLength; i++) {
        wave[i] = (drumBuffer & 1) * 2 - 1;
        let newBuffer = drumBuffer >> 1;
        if (((drumBuffer + newBuffer) & 1) === 1) {
          newBuffer += 10 << 2;
        }
        drumBuffer = newBuffer;
      }
    } else if (index === 6) {
      // "Deep" drums from modbox!
      drawNoiseSpectrum(wave, noiseWaveLength, 1, 10, 1, 1, 0);
      drawNoiseSpectrum(wave, noiseWaveLength, 20, 14, -2, -2, 0);
      inverseRealFourierTransform(wave, noiseWaveLength);
      scaleElementsByFactor(wave, 1 / Math.sqrt(noiseWaveLength));
    } else if (index === 7) {
      // "Cutter" drums from modbox!
      let drumBuffer = 1;
      for (let i = 0; i < noiseWaveLength; i++) {
        wave[i] = (drumBuffer & 1) * 4 * (Math.random() * 14 + 1) - 8;
        let newBuffer = drumBuffer >> 1;
        if (((drumBuffer + newBuffer) & 1) === 1) {
          newBuffer += 15 << 2;
        }
        drumBuffer = newBuffer;
      }
    } else if (index === 8) {
      // "Metallic" drums from modbox!
      let drumBuffer = 1;
      for (let i = 0; i < noiseWaveLength; i++) {
        wave[i] = (drumBuffer & 1) / 2 - 0.5;
        let newBuffer = drumBuffer >> 1;
        if (((drumBuffer + newBuffer) & 1) === 1) {
          newBuffer -= 10 << 2;
        }
        drumBuffer = newBuffer;
      }
    } else if (index === 9) {
      // a noise more like old static than white noise
      let drumBuffer: number = 1;
      for (let i: number = 0; i < noiseWaveLength; i++) {
        wave[i] = (drumBuffer & 1) * 2 - 1.1;
        let newBuffer: number = drumBuffer >> 1;
        if (((drumBuffer + newBuffer) & 1) === 1) {
          newBuffer += 8 ^ (2 << 16);
        }
        drumBuffer = newBuffer;
      }
    } else if (index === 10) {
      for (let i = 0; i < noiseWaveLength; i++) {
        wave[i] = Math.round(Math.random());
      }
    } else if (index === 11) {
      let drumBuffer = 1;
      for (let i = 0; i < noiseWaveLength; i++) {
        wave[i] = Math.round(drumBuffer & 1);
        let newBuffer = drumBuffer >> 1;
        if (((drumBuffer + newBuffer) & 1) === 1) {
          newBuffer -= 10 << 2;
        }
        drumBuffer = newBuffer;
      }
    } else if (index === 12) {
      for (let i = 0; i < noiseWaveLength; i++) {
        const randomSample = Math.random();
        wave[i] = randomSample ** Math.clz32(randomSample);
      }
    } else if (index === 13) {
      // https://noisehack.com/generate-noise-web-audio-api/
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;

      for (let i = 0; i < noiseWaveLength; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        wave[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        wave[i] = (wave[i] ?? 0) * 0.44;
        b6 = white * 0.115926;
      }
    } else if (index === 14) {
      let lastOut = 0;

      for (let i = 0; i < noiseWaveLength; i++) {
        const white = Math.random() * 2 - 1;
        wave[i] = (lastOut + 0.02 * white) / 1.02;
        lastOut = wave[i] ?? 0;
        wave[i] = (wave[i] ?? 0) * 14;
      }
    } else {
      throw new Error(`Unrecognized drum index: ${index}`);
    }

    wave[noiseWaveLength] = wave[0] ?? 0;
  }

  return wave;
};
