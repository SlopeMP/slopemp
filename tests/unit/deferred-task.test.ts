import { expect, test } from "bun:test";

import { DeferredTask } from "../../src/deferred-task";

test("persistence coalesces edits and lifecycle flush runs the latest task exactly once", () => {
  const pending = new DeferredTask();
  const saved: number[] = [];
  for (let revision = 0; revision < 20; revision++) {
    pending.schedule(() => {
      saved.push(revision);
    });
  }
  expect(saved).toEqual([]);
  pending.flush();
  expect(saved).toEqual([19]);
  pending.flush();
  expect(saved).toEqual([19]);
  pending.schedule(() => {
    saved.push(20);
  });
  pending.flush();
  expect(saved).toEqual([19, 20]);
});
