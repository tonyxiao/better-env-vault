import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { startServer } from "../apps/web/src/server.js";
import { fixture, MemoryProvider } from "./helpers.js";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.length = 0;
});

it("boots the desktop server over private pipes and exits on parent pipe closure", async () => {
  const schema = await fixture("# @optional\nTOKEN=\n");
  const child = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", "--import", "tsx", "apps/macos/server.ts"],
    {
      cwd: resolve(import.meta.dirname, ".."),
      env: { PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (part) => (stderr += part));
  const lines = createInterface({ input: child.stdout! });
  const ready = once(lines, "line");
  child.stdin!.write(JSON.stringify({ schemas: [schema.path] }) + "\n");
  const [line] = await ready;
  const { url, bootstrap } = JSON.parse(line);
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(url).not.toContain(bootstrap);
  expect((await fetch(url + "/api/projects")).status).toBe(401);
  const session = await fetch(url + "/api/session", {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({ token: bootstrap }),
  });
  expect(session.status).toBe(200);
  const exited = once(child, "exit");
  child.stdin!.end();
  await exited;
  await expect(fetch(url)).rejects.toThrow();
  expect(stderr).toBe("");
});

it("isolates per-launch credentials and rejects replay by another webview", async () => {
  const schema = await fixture("# @optional\nTOKEN=\n");
  const first = await startServer({
    schemas: [schema.path],
    provider: new MemoryProvider(),
  });
  const second = await startServer({
    schemas: [schema.path],
    provider: new MemoryProvider(),
  });
  const connect = (url: string, token: string) =>
    fetch(url + "/api/session", {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  try {
    expect((await connect(second.url, first.bootstrap)).status).toBe(401);
    const session = await connect(first.url, first.bootstrap);
    expect(session.status).toBe(200);
    expect((await connect(first.url, first.bootstrap)).status).toBe(401);
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    expect(
      (
        await fetch(second.url + "/api/projects", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(first.url + "/api/projects", {
          headers: { Cookie: cookie },
        })
      ).headers.get("cache-control"),
    ).toBe("no-store");
  } finally {
    await first.close();
    await second.close();
  }
});

it("keeps credential setup on private pipes, rejects invalid input without echoing it, and exits when cancelled", async () => {
  const child = spawn(
    process.execPath,
    ["--disable-warning=DEP0205", "--import", "tsx", "apps/macos/server.ts"],
    {
      cwd: resolve(import.meta.dirname, ".."),
      env: { PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (part) => (stderr += part));
  const lines = createInterface({ input: child.stdout! });
  const initial = once(lines, "line");
  child.stdin!.write(
    JSON.stringify({ schemas: [], configureServiceAccount: true }) + "\n",
  );
  expect(JSON.parse((await initial)[0])).toEqual({
    setupRequired: true,
    error: false,
  });
  const rejected = once(lines, "line");
  child.stdin!.write(
    JSON.stringify({ serviceAccountToken: "invalid-fixture-not-a-token" }) +
      "\n",
  );
  expect(JSON.parse((await rejected)[0])).toEqual({
    setupRequired: true,
    error: true,
  });
  const exited = once(child, "exit");
  child.stdin!.end();
  await exited;
  expect(stderr).toBe("");
});
