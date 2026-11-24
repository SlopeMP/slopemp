import { expect, test } from "bun:test";

import { insertionRange, loopPath, notePath } from "../../src/editor-geometry";
import { createNote } from "../../src/model";
import fixtures from "../fixtures/note-paths.json";

test("note paths match the reference for bends, varying sizes, and fractional widths", () => {
  for (const fixture of fixtures) {
    expect(
      notePath(
        fixture.note,
        fixture.pitch,
        fixture.width,
        (pitch) => 13 * (37 - pitch - 0.5),
        fixture.radius,
        fixture.showSize,
      ),
    ).toBe(fixture.path);
  }
});

test("insertion follows beat alignment and clips to neighboring notes", () => {
  expect(insertionRange(0.25, 1, 4, 8, [])).toEqual({ start: 0, end: 1 });
  expect(insertionRange(0.75, 1, 4, 8, [])).toEqual({ start: 0.5, end: 1.5 });
  expect(insertionRange(1, 1, 4, 8, [createNote(0, 0.75, 48), createNote(1.25, 2, 48)])).toEqual({
    start: 0.75,
    end: 1.25,
  });
  expect(insertionRange(7.9, 1, 4, 8, [])).toEqual({ start: 7, end: 8 });
});

test("the loop uses a 20 px capsule with a 4 px hover inset", () => {
  expect(loopPath(0, 128)).toBe("M 10 2 L 118 2 A 8 8 0 0 1 118 18 L 10 18 A 8 8 0 0 1 10 2 z");
  expect(loopPath(0, 20, 4)).toBe("M 10 4 L 10 4 A 6 6 0 0 1 10 16 L 10 16 A 6 6 0 0 1 10 4 z");
});
