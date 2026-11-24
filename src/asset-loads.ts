type AssetLoad = {
  controller: AbortController;
  promise: Promise<void>;
};

// Removing a source cancels its work immediately. A later request for the same
// key gets its own load, which an older completion must never remove.
export class AssetLoads {
  private readonly loads = new Map<string, AssetLoad>();

  public get(key: string): Promise<void> | undefined {
    return this.loads.get(key)?.promise;
  }

  public has(key: string): boolean {
    return this.loads.has(key);
  }

  public start(key: string, load: (signal: AbortSignal) => Promise<void>): void {
    if (this.loads.has(key)) {
      return;
    }
    const controller = new AbortController();
    const promise = (async (): Promise<void> => {
      await Promise.resolve();
      try {
        if (!controller.signal.aborted) {
          await load(controller.signal);
        }
      } finally {
        if (this.loads.get(key)?.controller === controller) {
          this.loads.delete(key);
        }
      }
    })();
    this.loads.set(key, { controller, promise });
  }

  public retain(keys: ReadonlySet<string>): void {
    for (const [key, load] of this.loads) {
      if (!keys.has(key)) {
        load.controller.abort();
        this.loads.delete(key);
      }
    }
  }
}
