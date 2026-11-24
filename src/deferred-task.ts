// Coalesce expensive browser persistence until input settles. A lifecycle flush starts
// saving the latest committed edit when navigation happens before the timer.
export class DeferredTask {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idle: number | undefined;
  private task: (() => void) | undefined;

  public schedule(task: () => void): void {
    this.cancel();
    this.task = task;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (typeof globalThis.requestIdleCallback === "function") {
        this.idle = globalThis.requestIdleCallback(
          () => {
            this.flush();
          },
          { timeout: 1000 },
        );
      } else {
        this.flush();
      }
    }, 250);
  }

  public flush(): void {
    const { task } = this;
    this.cancel();
    task?.();
  }

  private cancel(): void {
    clearTimeout(this.timer);
    if (this.idle !== undefined) {
      globalThis.cancelIdleCallback(this.idle);
    }
    this.timer = undefined;
    this.idle = undefined;
    this.task = undefined;
  }
}
