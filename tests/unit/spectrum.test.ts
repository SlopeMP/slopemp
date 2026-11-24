import { expect, test } from "bun:test";

import { SpectrumWave, SpectrumWaveState } from "../../src/synth/engine";
import fixtures from "../fixtures/spectrum-waveforms.json";

test("spectrum waveforms match the reference sample for sample at both drum tuning extremes", () => {
  for (const fixture of fixtures) {
    const settings = new SpectrumWave(false);
    settings.spectrum = [...fixture.spectrum];
    settings.markCustomWaveDirty();
    const wave = new SpectrumWaveState().getCustomWave(settings, fixture.lowestOctave);
    const hash = new Bun.CryptoHasher("sha256").update(new Uint8Array(wave.buffer)).digest("hex");
    expect(hash).toBe(fixture.hash);
    expect(wave[32_768]).toBe(wave[0]);
  }
});
