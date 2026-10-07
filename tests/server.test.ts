import { it, expect } from "vitest";
import { request as httpRequest } from "node:http";
import { startServer } from "../apps/web/src/server.js";
import { fixture, MemoryProvider, config } from "./helpers.js";
import { OnePasswordProvider } from "../packages/core/src/provider.js";
import { VaultError } from "../packages/core/src/errors.js";
import { vi } from "vitest";

it("reveals all declared values in one protected snapshot without exposing unmanaged items", async () => {
  const schema = await fixture(
    "# @optional\nTOKEN=\n\n# @public\nLABEL=base\n\n# @public @type=number\nCOUNT=1\n",
  );
  const provider = new MemoryProvider();
  await provider.save(config.environments.dev.vault, "COUNT", "001", "");
  await provider.save(
    config.environments.dev.vault,
    "TOKEN",
    "private-dev",
    "",
  );
  await provider.save(
    config.environments.prod.vault,
    "TOKEN",
    "private-prod",
    "",
  );
  await provider.save(
    config.environments.dev.vault,
    "UNMANAGED",
    "must-stay-unmanaged",
    "",
  );
  const app = await startServer({ schemas: [schema.path], provider });
  try {
    expect(
      (
        await fetch(app.url + "/api/reveal-all?project=0", {
          method: "POST",
          headers: { Origin: app.url, "Content-Type": "application/json" },
          body: JSON.stringify({ fingerprint: schema.fingerprint }),
        })
      ).status,
    ).toBe(401);
    const session = await fetch(app.url + "/api/session", {
      method: "POST",
      headers: { Origin: app.url, "Content-Type": "application/json" },
      body: JSON.stringify({ token: app.bootstrap }),
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const projects = await (
      await fetch(app.url + "/api/projects", { headers: { Cookie: cookie } })
    ).json();
    const headers = {
      Cookie: cookie,
      Origin: app.url,
      "Content-Type": "application/json",
      "X-Bev-Mutation": projects.mutationToken,
    };
    const payload = JSON.stringify({ fingerprint: schema.fingerprint });
    const masked = await (
      await fetch(app.url + "/api/matrix?project=0", {
        headers: { Cookie: cookie },
      })
    ).text();
    expect(masked).not.toContain("private-dev");
    expect(
      (
        await fetch(app.url + "/api/reveal-all?project=0", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: app.url,
            "Content-Type": "application/json",
          },
          body: payload,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(app.url + "/api/reveal-all?project=0", {
          method: "POST",
          headers,
          body: JSON.stringify({ fingerprint: "stale" }),
        })
      ).status,
    ).toBe(409);
    const response = await fetch(app.url + "/api/reveal-all?project=0", {
      method: "POST",
      headers,
      body: payload,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const all = await response.json();
    expect(all.editableValues.dev.COUNT).toBe("001");
    expect(
      all.resolutions
        .find((r: any) => r.environment === "dev")
        .variables.find((v: any) => v.name === "COUNT").value,
    ).toBe("1");
    expect(
      all.resolutions
        .find((r: any) => r.environment === "staging")
        .variables.find((v: any) => v.name === "TOKEN"),
    ).toMatchObject({ value: "private-dev", source: "dev" });
    expect(
      all.resolutions
        .find((r: any) => r.environment === "prod")
        .variables.find((v: any) => v.name === "TOKEN"),
    ).toMatchObject({ value: "private-prod", state: "explicit" });
    expect(JSON.stringify(all)).not.toContain("must-stay-unmanaged");
    const hiddenAgain = await (
      await fetch(app.url + "/api/matrix?project=0", {
        headers: { Cookie: cookie },
      })
    ).text();
    expect(hiddenAgain).not.toContain("private-dev");
    expect(hiddenAgain).not.toContain("private-prod");
    expect(JSON.parse(hiddenAgain)).not.toHaveProperty("editableValues");
  } finally {
    await app.close();
  }
});

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

it("caches UI reads, bypasses on refresh, and invalidates after edits while masking secrets", async () => {
  const schema = await fixture("# @optional\nTOKEN=\n");
  const provider = new MemoryProvider();
  await provider.save(
    config.environments.dev.vault,
    "TOKEN",
    "fixture-before",
    "",
  );
  let reads = 0;
  const readVault = provider.readVault.bind(provider);
  provider.readVault = async (vault) => {
    reads++;
    return readVault(vault);
  };
  const app = await startServer({ schemas: [schema.path], provider });
  try {
    const session = await fetch(app.url + "/api/session", {
      method: "POST",
      headers: { Origin: app.url, "Content-Type": "application/json" },
      body: JSON.stringify({ token: app.bootstrap }),
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const projects = await (
      await fetch(app.url + "/api/projects", { headers: { Cookie: cookie } })
    ).json();
    const headers = {
      Cookie: cookie,
      Origin: app.url,
      "Content-Type": "application/json",
      "X-Bev-Mutation": projects.mutationToken,
    };
    const matrix = () => fetch(app.url + "/api/matrix?project=0", { headers });
    const initial = await (await matrix()).json();
    expect(reads).toBe(3);
    const revealed = await (
      await fetch(app.url + "/api/reveal-all?project=0", {
        method: "POST",
        headers,
        body: JSON.stringify({ fingerprint: initial.fingerprint }),
      })
    ).text();
    expect(revealed).toContain("fixture-before");
    expect(reads).toBe(3);
    expect(await (await matrix()).text()).not.toContain("fixture-before");
    expect(reads).toBe(3);
    await fetch(app.url + "/api/matrix?project=0&fresh=1", { headers });
    expect(reads).toBe(6);
    const edited = await fetch(app.url + "/api/edit?project=0", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "set",
        name: "TOKEN",
        environment: "dev",
        value: "fixture-after",
        fingerprint: initial.fingerprint,
        versions: initial.versions.TOKEN,
      }),
    });
    expect(edited.status).toBe(200);
    const afterValidation = reads;
    expect(await (await matrix()).text()).not.toContain("fixture-after");
    expect(reads).toBe(afterValidation + 3);
    const updated = await (
      await fetch(app.url + "/api/reveal-all?project=0", {
        method: "POST",
        headers,
        body: JSON.stringify({ fingerprint: initial.fingerprint }),
      })
    ).text();
    expect(updated).toContain("fixture-after");
    expect(updated).not.toContain("fixture-before");
  } finally {
    await app.close();
  }
});

it("uses a fresh style nonce for Radix styles without allowing inline scripts", async () => {
  const schema = await fixture("# @optional\nTOKEN=\n");
  const { writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const directory = dirname(schema.path);
  await writeFile(
    join(directory, "index.html"),
    '<meta name="bev-style-nonce" content="BEV_STYLE_NONCE" />',
  );
  const app = await startServer({
    schemas: [schema.path],
    provider: new MemoryProvider(),
    staticDirectory: directory,
  });
  try {
    const first = await fetch(app.url);
    const html = await first.text();
    const nonce = html.match(/content="([^"]+)"/)![1];
    const csp = first.headers.get("content-security-policy")!;
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain("unsafe-inline");
    const second = await (await fetch(app.url)).text();
    expect(second).not.toBe(html);
  } finally {
    await app.close();
  }
});
