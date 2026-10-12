import { expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startServer } from "../apps/web/src/server.js";
import { fixture, MemoryProvider } from "./helpers.js";

it.each(["vault", "schema"] as const)(
  "publishes %s launch mode and establishes the browser session without waiting on 1Password",
  async (mode) => {
    const schema = await fixture("# @optional\nTOKEN=\n");
    const directory = dirname(schema.path);
    await writeFile(
      join(directory, "index.html"),
      '<meta name="bev-mode" content="BEV_MODE"><div>BEV_LOADING_LABEL</div>',
    );
    const provider = new MemoryProvider();
    const vaults = vi.spyOn(provider, "listVaults");
    const reads = vi.spyOn(provider, "readVault");
    const app = await startServer({
      schemas: mode === "schema" ? [schema.path] : [],
      ...(mode === "vault" ? { discovery: {} } : {}),
      provider,
      staticDirectory: directory,
    });
    try {
      const page = await (await fetch(app.url)).text();
      expect(page).toContain(`content="${mode}"`);
      expect(page).toContain(
        mode === "vault"
          ? "Loading 1Password secrets"
          : "Loading schema workspace",
      );
      expect(page).not.toContain("BEV_MODE");
      expect((await fetch(app.url + "/api/session")).status).toBe(401);
      const session = await fetch(app.url + "/api/session", {
        method: "POST",
        headers: { Origin: app.url, "Content-Type": "application/json" },
        body: JSON.stringify({ token: app.bootstrap }),
      });
      const data = await session.json();
      expect(data).toMatchObject({ connected: true, mode });
      expect(data.mutationToken).toMatch(/^[a-f0-9]{64}$/);
      const cookie = session.headers.get("set-cookie")!.split(";")[0];
      const resumed = await (
        await fetch(app.url + "/api/session", { headers: { Cookie: cookie } })
      ).json();
      expect(resumed).toEqual(data);
      expect(vaults).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
