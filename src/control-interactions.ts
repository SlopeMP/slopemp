// Only mouse movement restores hover after touch/pen input. Disabled controls ignore states.
// Pointer and keyboard presses share feedback; release preserves hover under a stationary mouse.
export const installControlInteractions = (): (() => void) => {
  let blockMouseHover = false;
  let pressed: HTMLElement | null = null;
  const releases = new WeakMap<HTMLElement, number>();
  const control = (event: Event): HTMLElement | null =>
    event.target instanceof Element ? event.target.closest<HTMLElement>(".control,.switch") : null;
  const hover = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && (event.movementX !== 0 || event.movementY !== 0)) {
      blockMouseHover = false;
    }
    const el = control(event);
    if (el && event.pointerType === "mouse" && !blockMouseHover && !el.matches(":disabled")) {
      el.classList.add("mouse-hover");
    }
  };
  const freezeRelease = (el: HTMLElement): void => {
    const token = (releases.get(el) ?? 0) + 1;
    releases.set(el, token);
    el.classList.add("just-released");
    // Native click and checked-state changes finish before transitions resume.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (releases.get(el) === token && !el.classList.contains("pressed")) {
          el.classList.remove("just-released");
        }
      });
    });
  };
  const down = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse") {
      blockMouseHover = true;
      document.querySelectorAll(".mouse-hover").forEach((el) => {
        el.classList.remove("mouse-hover");
      });
    }
    pressed = control(event);
    if (pressed && !pressed.matches(":disabled")) {
      pressed.classList.remove("just-released");
      pressed.classList.add("pressed");
    }
  };
  const release = (event: Event): void => {
    const el = pressed;
    if (el === null) {
      return;
    }
    pressed = null;
    freezeRelease(el);
    el.classList.remove("pressed");
    if (event instanceof PointerEvent && event.pointerType === "mouse" && !blockMouseHover) {
      const bounds = el.getBoundingClientRect();
      el.classList.toggle(
        "mouse-hover",
        event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          event.clientY >= bounds.top &&
          event.clientY <= bounds.bottom,
      );
    }
  };
  const leave = (event: PointerEvent): void => {
    control(event)?.classList.remove("mouse-hover");
  };
  const click = (event: MouseEvent): void => {
    const el = control(event);
    if (el && !el.matches(":disabled")) {
      freezeRelease(el);
    }
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.key !== " " && event.key !== "Enter") {
      return;
    }
    queueMicrotask(() => {
      if (event.defaultPrevented) {
        return;
      }
      const el = control(event);
      if (el && !el.matches(":disabled")) {
        pressed = el;
        el.classList.remove("just-released");
        el.classList.add("pressed");
      }
    });
  };
  const keyup = (event: KeyboardEvent): void => {
    if (event.key === " " || event.key === "Enter") {
      release(event);
    }
  };
  const blur = (event: FocusEvent): void => {
    release(event);
    control(event)?.classList.remove("mouse-hover");
  };
  document.addEventListener("pointermove", hover);
  document.addEventListener("pointerover", hover);
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
  document.addEventListener("pointerout", leave);
  document.addEventListener("click", click);
  document.addEventListener("keydown", keydown);
  document.addEventListener("keyup", keyup);
  document.addEventListener("blur", blur, true);
  return (): void => {
    document.removeEventListener("pointermove", hover);
    document.removeEventListener("pointerover", hover);
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointerup", release);
    document.removeEventListener("pointercancel", release);
    document.removeEventListener("pointerout", leave);
    document.removeEventListener("click", click);
    document.removeEventListener("keydown", keydown);
    document.removeEventListener("keyup", keyup);
    document.removeEventListener("blur", blur, true);
  };
};
