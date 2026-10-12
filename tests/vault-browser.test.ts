import { expect, it, vi } from "vitest";
import { startServer } from "../apps/web/src/server.js";
import { VaultBrowser } from "../apps/web/src/vault-browser.js";
import {
  connectDiscovery,
  discoverAccounts,
} from "../packages/core/src/discovery.js";
import { OnePasswordProvider } from "../packages/core/src/provider.js";
import { MemoryProvider, config } from "./helpers.js";

const dev = config.environments.dev.vault;
const prod = config.environments.prod.vault;
async function fixture() {
  const provider = new MemoryProvider();
  await provider.save(dev, "TOKEN", "dev-private", "private notes");
  await provider.save(prod, "TOKEN", "prod-private", "");
  return { provider, browser: new VaultBrowser({}, provider) };
}
it("discovers vault metadata without reading secrets and keeps environments independent", async () => {
  const { browser, provider } = await fixture();
  const read = vi.spyOn(provider, "readVault");
  const projects = await browser.projects();
  expect(projects).toHaveLength(3);
  expect(read).not.toHaveBeenCalled();
  const matrix = await browser.matrix(dev, false);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(dev);
  expect(matrix.mode).toBe("vault");
  expect(matrix.environments).toEqual(["vault"]);
  expect(matrix.resolutions[0].chain).toEqual([]);
  expect(matrix.resolutions[0].variables[0]).toMatchObject({
    sensitive: true,
    hasDefault: false,
    state: "explicit",
  });
  expect(JSON.stringify(matrix)).not.toMatch(
    /dev-private|prod-private|private notes/,
  );
  expect(
    await browser.reveal(dev, {
      environment: "vault",
      name: "TOKEN",
      fingerprint: matrix.fingerprint,
    }),
  ).toMatchObject({ value: "dev-private", notes: "private notes" });
  expect(
    (
      await browser.matrix(
        prod,
        true,
        (await browser.matrix(prod, false)).fingerprint,
      )
    ).resolutions[0].variables[0].value,
  ).toBe("prod-private");
  await expect(browser.matrix("unknown", false)).rejects.toThrow("accessible");
});
it("edits values and notes, rejects stale writes and schema actions, and scopes rename/delete to one vault", async () => {
  const { browser, provider } = await fixture();
  await browser.projects();
  let matrix = await browser.matrix(dev, false);
  const common = {
    name: "TOKEN",
    versions: matrix.versions.TOKEN,
    fingerprint: matrix.fingerprint,
  };
  await browser.edit(dev, {
    ...common,
    action: "set",
    environment: "vault",
    value: "",
  });
  expect(provider.vaults[dev][0]).toMatchObject({
    value: "",
    notes: "private notes",
  });
  expect(provider.vaults[prod][0].value).toBe("prod-private");
  await expect(
    browser.edit(dev, {
      ...common,
      action: "set",
      environment: "vault",
      value: "stale",
    }),
  ).rejects.toThrow("changed");
  await expect(
    browser.edit(dev, { ...common, action: "default", value: "no" }),
  ).rejects.toThrow("Schema operations");
  await expect(
    browser.edit(dev, {
      ...common,
      action: "set",
      environment: "prod",
      value: "no",
    }),
  ).rejects.toThrow("Invalid vault edit");
  matrix = await browser.matrix(dev, false);
  await browser.edit(dev, {
    action: "set",
    name: "TOKEN",
    environment: "vault",
    notes: "new notes",
    fingerprint: matrix.fingerprint,
    versions: matrix.versions.TOKEN,
  });
  matrix = await browser.matrix(dev, false);
  await browser.edit(dev, {
    action: "rename",
    name: "TOKEN",
    newName: "RENAMED",
    fingerprint: matrix.fingerprint,
    versions: matrix.versions.TOKEN,
  });
  expect(provider.vaults[dev][0].name).toBe("RENAMED");
  expect(provider.vaults[prod][0].name).toBe("TOKEN");
  matrix = await browser.matrix(dev, false);
  await expect(
    browser.edit(dev, {
      action: "delete",
      name: "RENAMED",
      confirmation: "wrong",
      fingerprint: matrix.fingerprint,
      versions: matrix.versions.RENAMED,
    }),
  ).rejects.toThrow("confirm");
  await browser.edit(dev, {
    action: "delete",
    name: "RENAMED",
    confirmation: "RENAMED",
    fingerprint: matrix.fingerprint,
    versions: matrix.versions.RENAMED,
  });
  expect(provider.vaults[dev]).toEqual([]);
  expect(provider.vaults[prod]).toHaveLength(1);
});
it("creates vault items and detects same-name recreation even when versions match", async () => {
  const { browser, provider } = await fixture();
  await browser.projects();
  let matrix = await browser.matrix(dev, false);
  await browser.edit(dev, {
    action: "add",
    name: "NEW",
    fingerprint: matrix.fingerprint,
    versions: { vault: null },
    initialValues: { vault: { value: "new value", notes: "notes" } },
  });
  matrix = await browser.matrix(dev, false);
  provider.vaults[dev][0].id = "recreated-item";
  await expect(
    browser.edit(dev, {
      action: "set",
      name: "TOKEN",
      fingerprint: matrix.fingerprint,
      versions: matrix.versions.TOKEN,
      environment: "vault",
      value: "unchecked",
    }),
  ).rejects.toThrow("changed");
  expect(provider.vaults[dev][0].value).toBe("dev-private");
});
it("preflights all bulk versions and restores removed items after a failed deletion", async () => {
  const { browser, provider } = await fixture();
  provider.restore = async (id, item) =>
    provider.save(id, item.name, item.value, item.notes);
  await provider.save(dev, "SECOND", "second", "");
  await browser.projects();
  const matrix = await browser.matrix(dev, false);
  const request = {
    names: ["TOKEN", "SECOND"],
    fingerprint: matrix.fingerprint,
    versions: matrix.versions,
    confirmation: "DELETE",
  };
  await expect(
    browser.deleteMany(dev, {
      ...request,
      versions: { ...matrix.versions, SECOND: { vault: 99 } },
    }),
  ).rejects.toThrow("changed");
  expect(provider.vaults[dev]).toHaveLength(2);
  provider.failAt = provider.calls + 2;
  await expect(browser.deleteMany(dev, request)).rejects.toThrow();
  expect(provider.vaults[dev].map((i) => i.name).sort()).toEqual([
    "SECOND",
    "TOKEN",
  ]);
  expect(provider.vaults[prod][0].value).toBe("prod-private");
  const refreshed = await browser.matrix(dev, false);
  await browser.deleteMany(dev, {
    ...request,
    fingerprint: refreshed.fingerprint,
    versions: refreshed.versions,
  });
  expect(provider.vaults[dev]).toEqual([]);
});
it("authenticates discovery API reads and mutations using the existing local session flow", async () => {
  const { provider } = await fixture();
  const app = await startServer({ schemas: [], discovery: {}, provider });
  try {
    expect((await fetch(app.url + "/api/projects")).status).toBe(401);
    const session = await fetch(app.url + "/api/session", {
      method: "POST",
      headers: { Origin: app.url, "Content-Type": "application/json" },
      body: JSON.stringify({ token: app.bootstrap }),
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const projects = await (
      await fetch(app.url + "/api/projects", { headers: { Cookie: cookie } })
    ).json();
    expect(projects.mode).toBe("vault");
    const endpoint = `/api/matrix?project=${dev}`;
    const masked = await (
      await fetch(app.url + endpoint, { headers: { Cookie: cookie } })
    ).json();
    expect(JSON.stringify(masked)).not.toContain("dev-private");
    const payload = JSON.stringify({ fingerprint: masked.fingerprint });
    expect(
      (
        await fetch(app.url + `/api/reveal-all?project=${dev}`, {
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
    const revealed = await (
      await fetch(app.url + `/api/reveal-all?project=${dev}`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: app.url,
          "Content-Type": "application/json",
          "X-Bev-Mutation": projects.mutationToken,
        },
        body: payload,
      })
    ).json();
    expect(revealed.resolutions[0].variables[0].value).toBe("dev-private");
  } finally {
    await app.close();
  }
});
it("discovers the selected account and refreshes provider routing after reconnecting", async () => {
  const provider = new MemoryProvider();
  const connect = vi
    .spyOn(OnePasswordProvider, "connect")
    .mockResolvedValue(provider as unknown as OnePasswordProvider);
  try {
    expect(await discoverAccounts("explicit-account")).toEqual([
      "explicit-account",
    ]);
    const discovered = await connectDiscovery({ account: "explicit-account" });
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "explicit-account",
        environments: {},
      }),
      true,
    );
    await expect(discovered.readVault(dev)).resolves.toEqual([]);
    delete provider.vaults[dev];
    await discovered.listVaults!();
    await expect(discovered.readVault(dev)).rejects.toThrow("accessible");
  } finally {
    connect.mockRestore();
  }
});
