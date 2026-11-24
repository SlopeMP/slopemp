import type { Page } from "@playwright/test";

import type { AudioTrackCommand } from "../../src/audio-thread-pool";

// Observe assignments in the coordinator before it starts its nested workers.
export const observeTrackWorkers = async (page: Page, coordinator: string): Promise<void> => {
  const observe = (): void => {
    const assignments = new Map<Worker, string[]>();
    const report = (): void => {
      postMessage({
        type: "threads",
        count: assignments.size + 1,
        assignments: [...assignments.values()],
      });
    };
    class ObservedTrackWorker extends Worker {
      public override postMessage(
        command: AudioTrackCommand,
        options: StructuredSerializeOptions | Transferable[] = [],
      ): void {
        if (command.type === "init" || command.type === "update") {
          assignments.set(this, command.trackIds);
          report();
        }
        super.postMessage(command, Array.isArray(options) ? { transfer: options } : options);
      }

      public override terminate(): void {
        assignments.delete(this);
        report();
        super.terminate();
      }
    }
    Reflect.set(globalThis, "Worker", ObservedTrackWorker);
    report();
  };
  await page.route(`**/${coordinator}.js`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `(${observe.toString()})();\n${await response.text()}` });
  });
};
