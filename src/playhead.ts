import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

export type PlayheadSource = () => number;

// Animate the playhead independently of note and arrangement updates.
export const createPlayhead = <T extends Element>(
  source: Accessor<PlayheadSource | null>,
  update: (element: T, position: number) => void,
): ((element: T) => void) => {
  const [element, setElement] = createSignal<T>();
  createEffect(() => {
    const target = element();
    const read = source();
    if (!target || !read) {
      return;
    }
    update(target, read());
    let frame = 0;
    const animate = (): void => {
      update(target, read());
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    onCleanup(() => {
      cancelAnimationFrame(frame);
    });
  });
  return (target): void => {
    setElement(() => target);
  };
};
