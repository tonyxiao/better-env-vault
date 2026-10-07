import { it, expect } from "vitest";
import { request as httpRequest } from "node:http";
import { startServer } from "../apps/web/src/server.js";
import { fixture, MemoryProvider, config } from "./helpers.js";
import { OnePasswordProvider } from "../packages/core/src/provider.js";
import { VaultError } from "../packages/core/src/errors.js";
import { vi } from "vitest";

it("connects another browser with a fresh link, preserves valid sessions, and isolates server cookies by port", async () => {
  const schema = await fixture("# @public\nKEY=example\n");
  const provider = new MemoryProvider();
  const first = await startServer({ schemas: [schema.path], provider });
  const second = await startServer({ schemas: [schema.path], provider });
  const connect = async (app: typeof first, token: string, cookie?: string) =>
    fetch(app.url + "/api/session", {
      method: "POST",
      headers: {
        Origin: app.url,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ token }),
    });
  try {
    expect((await fetch(first.url + "/api/projects")).status).toBe(401);
    const initial = await connect(first, first.bootstrap);
    const cookie = initial.headers.get("set-cookie")!.split(";")[0];
    expect((await connect(first, first.bootstrap)).status).toBe(401);
    expect((await connect(first, first.bootstrap, cookie)).status).toBe(200);
    const fresh = new URL(first.issueLaunchUrl()).hash.slice(
      "#session=".length,
    );
    const otherBrowser = await connect(first, fresh);
    expect(otherBrowser.status).toBe(200);
    expect((await connect(first, fresh)).status).toBe(401);
    const separateServer = await connect(second, second.bootstrap);
    const separateCookie = separateServer.headers
      .get("set-cookie")!
      .split(";")[0];
    expect(cookie.split("=")[0]).not.toBe(separateCookie.split("=")[0]);
    const sharedJar = { Cookie: cookie + "; " + separateCookie };
    expect(
      (await fetch(first.url + "/api/projects", { headers: sharedJar })).status,
    ).toBe(200);
    expect(
      (await fetch(second.url + "/api/projects", { headers: sharedJar }))
        .status,
    ).toBe(200);
  } finally {
    await first.close();
    await second.close();
  }
});

it("reconnects after expired provider authorization when the user refreshes", async () => {
  const schema = await fixture("# @optional\nTOKEN=\n");
  const expired = new MemoryProvider(),
    fresh = new MemoryProvider();
  expired.readVault = async () => {
    throw new VaultError(
      "Expired desktop authorization.",
      "authentication",
      502,
    );
  };
  const connect = vi
    .spyOn(OnePasswordProvider, "connect")
    .mockResolvedValueOnce(expired as unknown as OnePasswordProvider)
    .mockResolvedValueOnce(fresh as unknown as OnePasswordProvider);
  const app = await startServer({ schemas: [schema.path] });
  try {
    const session = await fetch(app.url + "/api/session", {
      method: "POST",
      headers: { Origin: app.url, "Content-Type": "application/json" },
      body: JSON.stringify({ token: app.bootstrap }),
    });
    const headers = {
      Cookie: session.headers.get("set-cookie")!.split(";")[0],
    };
    expect(
      (await fetch(app.url + "/api/matrix?project=0", { headers })).status,
    ).toBe(502);
    expect(
      (await fetch(app.url + "/api/matrix?project=0", { headers })).status,
    ).toBe(200);
    expect(connect).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
    connect.mockRestore();
  }
});

it("protects matrix reads, reveal, mutations, launch replay, and filesystem boundaries", async () => {
  const schema = await fixture("# @optional\nTOKEN=\n");
  const provider = new MemoryProvider();
  await provider.save(
    config.environments.dev.vault,
    "TOKEN",
    "private-content",
    "private-notes",
  );
  const app = await startServer({ schemas: [schema.path], provider });
  try {
    expect((await fetch(app.url + "/api/matrix?project=0")).status).toBe(401);
    const hostileHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          app.url + "/api/projects",
          { headers: { Host: "evil.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
        request.end();
      },
    );
    expect(hostileHostStatus).toBe(403);
    const sessionOptions = {
      method: "POST",
      headers: { Origin: app.url, "Content-Type": "application/json" },
      body: JSON.stringify({ token: app.bootstrap }),
    };
    const session = await fetch(app.url + "/api/session", sessionOptions);
    expect(session.status).toBe(200);
    expect((await fetch(app.url + "/api/session", sessionOptions)).status).toBe(
      401,
    );
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const projects = await (
      await fetch(app.url + "/api/projects", { headers: { Cookie: cookie } })
    ).json();
    const response = await fetch(app.url + "/api/matrix?project=0", {
      headers: { Cookie: cookie },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("private-content");
    expect(text).not.toContain("private-notes");
    const matrix = JSON.parse(text);
    const headers = {
      Cookie: cookie,
      Origin: app.url,
      "Content-Type": "application/json",
      "X-Bev-Mutation": projects.mutationToken,
    };
    const reveal = {
      method: "POST",
      headers,
      body: JSON.stringify({
        environment: "dev",
        name: "TOKEN",
        fingerprint: matrix.fingerprint,
      }),
    };
    expect(
      (await (await fetch(app.url + "/api/reveal?project=0", reveal)).json())
        .value,
    ).toBe("private-content");
    expect(
      (
        await fetch(app.url + "/api/reveal?project=0", {
          ...reveal,
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(app.url + "/api/edit?project=0", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: app.url,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(app.url + "/api/matrix?project=/etc/passwd", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(app.url + "/api/edit?project=0", {
          method: "POST",
          headers,
          body: JSON.stringify({
            action: "set",
            fingerprint: matrix.fingerprint,
            name: "TOKEN",
            environment: "dev",
            versions: { dev: 1 },
            value: "new",
            path: "/tmp/evil",
          }),
        })
      ).status,
    ).toBe(400);
    const saved = await fetch(app.url + "/api/edit?project=0", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "set",
        fingerprint: matrix.fingerprint,
        name: "TOKEN",
        environment: "dev",
        versions: { dev: 1 },
        value: "new",
      }),
    });
    expect(saved.status).toBe(200);
    const stale = await fetch(app.url + "/api/edit?project=0", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "set",
        fingerprint: matrix.fingerprint,
        name: "TOKEN",
        environment: "dev",
        versions: { dev: 1 },
        value: "stale",
      }),
    });
    expect(stale.status).toBe(409);
  } finally {
    await app.close();
  }
});
