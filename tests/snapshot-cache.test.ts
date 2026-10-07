import { expect, it } from "vitest";
import { SnapshotCache } from "../apps/web/src/snapshot-cache.js";

it("coalesces concurrent reads and expires from completion time", async () => {
  let now = 0,
    reads = 0;
  const cache = new SnapshotCache<string>(30, () => now);
  let resolve!: (value: string) => void;
  const load = () => {
    reads++;
    return new Promise<string>((done) => {
      resolve = done;
    });
  };
  const first = cache.get("project", "schema", load);
  expect(cache.get("project", "schema", load)).toBe(first);
  await Promise.resolve();
  now = 100;
  resolve("fixture");
  expect(await first).toBe("fixture");
  now = 129;
  expect(await cache.get("project", "schema", load)).toBe("fixture");
  expect(reads).toBe(1);
  now = 130;
  expect(await cache.get("project", "schema", async () => "new fixture")).toBe(
    "new fixture",
  );
});

it("bypasses on refresh, schema change, invalidation, and rejected reads", async () => {
  const cache = new SnapshotCache<number>();
  let reads = 0;
  const load = async () => ++reads;
  expect(await cache.get("project", "a", load)).toBe(1);
  expect(await cache.get("project", "a", load, true)).toBe(2);
  expect(await cache.get("project", "b", load)).toBe(3);
  cache.invalidate("project");
  expect(await cache.get("project", "b", load)).toBe(4);
  await expect(
    cache.get("project", "c", async () => {
      throw new Error("fixture");
    }),
  ).rejects.toThrow("fixture");
  expect(await cache.get("project", "c", load)).toBe(5);
});

it("does not restore an invalidated snapshot when an old request finishes", async () => {
  const cache = new SnapshotCache<string>();
  let resolve!: (value: string) => void;
  const old = cache.get(
    "project",
    "schema",
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  await Promise.resolve();
  cache.invalidate("project");
  expect(await cache.get("project", "schema", async () => "current")).toBe(
    "current",
  );
  resolve("old");
  await old;
  expect(await cache.get("project", "schema", async () => "unexpected")).toBe(
    "current",
  );
});

it("drops entries automatically at expiry and clears them on shutdown", async () => {
  const { vi } = await import("vitest");
  vi.useFakeTimers();
  try {
    const cache = new SnapshotCache<number>(30);
    let reads = 0;
    const load = async () => ++reads;
    expect(await cache.get("project", "schema", load)).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(await cache.get("project", "schema", load)).toBe(2);
    cache.clear();
    expect(await cache.get("project", "schema", load)).toBe(3);
    cache.clear();
  } finally {
    vi.useRealTimers();
  }
});
