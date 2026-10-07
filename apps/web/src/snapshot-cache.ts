/** Server-process memory only. Never used by CLI exports or write validation. */
export class SnapshotCache<T> {
  private entries = new Map<
    string,
    {
      fingerprint: string;
      pending: boolean;
      expires: number;
      value: Promise<T>;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private ttlMs = 30_000,
    private now = () => Date.now(),
  ) {}

  get(
    key: string,
    fingerprint: string,
    load: () => Promise<T>,
    fresh = false,
  ): Promise<T> {
    const current = this.entries.get(key);
    if (
      !fresh &&
      current?.fingerprint === fingerprint &&
      (current.pending || current.expires > this.now())
    )
      return current.value;
    this.invalidate(key);
    const entry: {
      fingerprint: string;
      pending: boolean;
      expires: number;
      value: Promise<T>;
      timer?: ReturnType<typeof setTimeout>;
    } = {
      fingerprint,
      pending: true,
      expires: 0,
      value: Promise.resolve().then(load),
    };
    this.entries.set(key, entry);
    void entry.value.then(
      () => {
        entry.pending = false;
        entry.expires = this.now() + this.ttlMs;
        if (this.entries.get(key) !== entry) return;
        entry.timer = setTimeout(() => {
          if (this.entries.get(key) === entry) this.invalidate(key);
        }, this.ttlMs);
        entry.timer.unref();
      },
      () => {
        if (this.entries.get(key) === entry) this.invalidate(key);
      },
    );
    return entry.value;
  }

  invalidate(key: string) {
    clearTimeout(this.entries.get(key)?.timer);
    this.entries.delete(key);
  }

  clear() {
    for (const key of this.entries.keys()) this.invalidate(key);
  }
}
