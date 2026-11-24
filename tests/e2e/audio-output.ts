import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Observe the real output graph, including worklet delivery, without replacing synthesis.
export const probeOutput = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const attached = new WeakSet<AudioNode>();
    const connect: unknown = Reflect.get(AudioNode.prototype, "connect");
    if (typeof connect !== "function") {
      throw new TypeError("Missing audio output API");
    }
    Reflect.set(
      AudioNode.prototype,
      "connect",
      new Proxy(connect, {
        apply(target, source: unknown, args: unknown[]): unknown {
          if (
            source instanceof AudioNode &&
            args[0] instanceof AudioDestinationNode &&
            !attached.has(source)
          ) {
            attached.add(source);
            Reflect.set(globalThis, "audioOutputRMS", 0);
            Reflect.set(globalThis, "audioOutputContext", source.context);
            Reflect.set(
              globalThis,
              "audioOutputGeneration",
              Number(Reflect.get(globalThis, "audioOutputGeneration") ?? 0) + 1,
            );
            const analyser = source.context.createAnalyser();
            analyser.fftSize = 2048;
            Reflect.apply(target, source, [analyser]);
            const samples = new Float32Array(analyser.fftSize);
            const timer = setInterval(() => {
              if (source.context.state === "closed") {
                clearInterval(timer);
                return;
              }
              analyser.getFloatTimeDomainData(samples);
              let energy = 0;
              for (const sample of samples) {
                energy += sample * sample;
              }
              Reflect.set(globalThis, "audioOutputRMS", Math.sqrt(energy / samples.length));
              if (!samples.every(Number.isFinite)) {
                Reflect.set(globalThis, "audioOutputInvalid", true);
              }
            }, 30);
          }
          return Reflect.apply(target, source, args);
        },
      }),
    );
  });
};
export const expectAudible = async (page: Page): Promise<void> => {
  await expect
    .poll(async () => await page.evaluate(() => Number(Reflect.get(globalThis, "audioOutputRMS"))))
    .toBeGreaterThan(0.001);
  expect(await page.evaluate(() => Reflect.get(globalThis, "audioOutputInvalid") === true)).toBe(
    false,
  );
};
