import { expect, it } from "vitest";
import { VaultBrowser } from "../apps/web/src/vault-browser.js";
import { startServer } from "../apps/web/src/server.js";
import { MemoryProvider, config } from "./helpers.js";
import { VaultError } from "../packages/core/src/errors.js";
import {
  applyCatalogEvent,
  type VaultCatalog,
  type VaultCatalogEvent,
} from "../apps/web/src/vault-model.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

it("streams fast vaults before slow ones and starts the next queued read without a batch barrier", async () => {
  const provider = new MemoryProvider();
  const ids = Array.from({ length: 9 }, (_, index) => `vault-${index}`);
  provider.listVaults = async () => ids.map((id) => ({ id, name: id }));
  const gates = new Map(ids.map((id) => [id, deferred()]));
  const startedSix = deferred(),
    startedSeven = deferred();
  const started: string[] = [];
  let active = 0,
    maxActive = 0;
  provider.readVault = async (id) => {
    started.push(id);
    maxActive = Math.max(maxActive, ++active);
    if (started.length === 6) startedSix.resolve();
    if (started.length === 7) startedSeven.resolve();
    await gates.get(id)!.promise;
    active--;
    return [];
  };
  const controller = new AbortController();
  const stream = new VaultBrowser({}, provider).catalogEvents(
    false,
    true,
    controller.signal,
  );
  try {
    expect((await stream.next()).value).toMatchObject({
      type: "start",
      environments: expect.any(Array),
    });
    expect(started).toHaveLength(0);
    const first = stream.next();
    await startedSix.promise;
    expect(started).toHaveLength(6);
    gates.get(ids[1])!.resolve();
    expect((await first).value).toMatchObject({ type: "vault", id: ids[1] });
    const next = stream.next();
    await startedSeven.promise;
    expect(started).toHaveLength(7);
    expect(maxActive).toBe(6);
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toHaveLength(7);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await stream.return(undefined);
  }
});

it("isolates failed vaults but aborts the stream on expired authentication", async () => {
  const provider = new MemoryProvider();
  const id = config.environments.dev.vault;
  provider.readVault = async (vault) => {
    if (vault === id) throw new Error("secret-bearing SDK diagnostics");
    return [];
  };
  const browser = new VaultBrowser({}, provider);
  const events: VaultCatalogEvent[] = [];
  for await (const event of browser.catalogEvents()) events.push(event);
  expect(events.find((event) => event.type === "error")).toMatchObject({ id });
  expect(events.at(-1)?.type).toBe("complete");
  expect(JSON.stringify(events)).not.toContain("secret-bearing");
  browser.reset();
  provider.readVault = async () => {
    throw new VaultError("Authorization expired.", "authentication", 502);
  };
  const stream = browser.catalogEvents();
  expect((await stream.next()).value?.type).toBe("start");
  await expect(stream.next()).rejects.toMatchObject({ code: "authentication" });
});

it("protects the stream and sends data before the final vault is ready", async () => {
  const provider = new MemoryProvider();
  const slow = config.environments.dev.vault;
  const gate = deferred();
  const read = provider.readVault.bind(provider);
  provider.readVault = async (id) => {
    if (id === slow) await gate.promise;
    return read(id);
  };
  const app = await startServer({ schemas: [], discovery: {}, provider });
  try {
    const endpoint = app.url + "/api/catalog?stream=1&values=1";
    expect((await fetch(endpoint)).status).toBe(401);
    const session = await fetch(app.url + "/api/session", {
      method: "POST",
      headers: { Origin: app.url, "Content-Type": "application/json" },
      body: JSON.stringify({ token: app.bootstrap }),
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const response = await fetch(endpoint, { headers: { Cookie: cookie } });
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: VaultCatalogEvent[] = [];
    while (!events.some((event) => event.type === "vault")) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) if (line) events.push(JSON.parse(line));
    }
    expect(events[0].type).toBe("start");
    expect(events.some((event) => event.type === "complete")).toBe(false);
    expect(
      events.some((event) => event.type === "vault" && event.id === slow),
    ).toBe(false);
    gate.resolve();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    for (const line of buffer.split("\n"))
      if (line) events.push(JSON.parse(line));
    expect(events.at(-1)?.type).toBe("complete");
    expect(events.filter((event) => event.type === "vault")).toHaveLength(3);
  } finally {
    gate.resolve();
    await app.close();
  }
});

it("keeps environment order stable and rejects stale streamed results after a save", async () => {
  const provider = new MemoryProvider();
  const browser = new VaultBrowser({}, provider);
  const envs = await browser.projects();
  const first = envs[0].id,
    second = envs[1].id;
  const initial: VaultCatalog = {
    environments: envs,
    matrices: [],
    errors: [],
    auth: "desktop",
  };
  let catalog = applyCatalogEvent(initial, {
    type: "vault",
    id: second,
    matrix: await browser.matrix(second, false),
  });
  const older = await browser.matrix(first, false);
  catalog = applyCatalogEvent(catalog, {
    type: "vault",
    id: first,
    matrix: { ...older, revision: 2 },
  });
  expect(catalog.matrices.map((entry) => entry.id)).toEqual([first, second]);
  const unchanged = applyCatalogEvent(catalog, {
    type: "vault",
    id: first,
    matrix: { ...older, revision: 1 },
  });
  expect(unchanged).toBe(catalog);
});
