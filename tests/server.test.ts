import { it, expect } from "vitest";
import { request as httpRequest } from "node:http";
import { startServer } from "../apps/web/src/server.js";
import { fixture, MemoryProvider, config } from "./helpers.js";

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
