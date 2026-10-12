import { expect, it, vi } from "vitest";
import { VaultBrowser } from "../apps/web/src/vault-browser.js";
import {
  catalogRows,
  filterVaultRows,
  maskCatalog,
  type VaultCatalog,
} from "../apps/web/src/vault-model.js";
import { connectDiscovery } from "../packages/core/src/discovery.js";
import { OnePasswordProvider } from "../packages/core/src/provider.js";
import { MemoryProvider, config } from "./helpers.js";

const [dev, staging, prod] = Object.values(config.environments).map(
  (e) => e.vault,
);
async function fixture() {
  const provider = new MemoryProvider();
  provider.listVaults = async () => [
    { id: dev, name: "Development" },
    { id: staging, name: "Staging" },
    { id: prod, name: "Production" },
  ];
  await provider.save(dev, "TOKEN", "private-dev", "");
  await provider.save(prod, "TOKEN", "private-prod", "");
  await provider.save(prod, "DATABASE_URL", "private-url", "");
  return { provider, browser: new VaultBrowser({}, provider) };
}
it("combines every environment, keeps duplicate secret names separate, and never exposes masked values", async () => {
  const { browser } = await fixture();
  const catalog = (await browser.catalog()) as VaultCatalog;
  expect(catalog.environments).toHaveLength(3);
  const rows = catalogRows(catalog);
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  expect(
    rows
      .filter((r) => r.variable.name === "TOKEN")
      .map((r) => r.environment.name),
  ).toEqual(["Development", "Production"]);
  expect(JSON.stringify(catalog)).not.toMatch(
    /private-dev|private-prod|private-url/,
  );
  expect(
    catalog.matrices.find((m) => m.id === staging)?.matrix.resolutions[0]
      .variables,
  ).toEqual([]);
  expect(filterVaultRows(rows, "token", new Set())).toHaveLength(2);
  expect(filterVaultRows(rows, "production token", new Set())).toHaveLength(1);
  expect(filterVaultRows(rows, "", new Set([dev, prod]))).toHaveLength(3);
  expect(filterVaultRows(rows, "token", new Set([dev]))[0].vaultId).toBe(dev);
  expect(filterVaultRows(rows, "private-prod", new Set())).toEqual([]);
});
it("reveals selected environments only and clears all values when masked again", async () => {
  const { browser } = await fixture();
  const masked = await browser.catalog();
  const entry = masked.matrices.find((m) => m.id === prod)!;
  const revealed = (await browser.catalog(false, {
    [prod]: entry.matrix.fingerprint,
  })) as VaultCatalog;
  expect(
    revealed.matrices.find((m) => m.id === prod)?.matrix.resolutions[0]
      .variables[1].value,
  ).toBe("private-prod");
  expect(
    revealed.matrices.find((m) => m.id === dev)?.matrix.resolutions[0]
      .variables[0].value,
  ).toBeUndefined();
  expect(JSON.stringify(maskCatalog(revealed))).not.toMatch(
    /private-dev|private-prod|private-url/,
  );
  await expect(browser.catalog(false, { [prod]: "stale" })).rejects.toThrow(
    "changed",
  );
});
it("refreshes all environments and isolates a malformed vault", async () => {
  const { browser, provider } = await fixture();
  await browser.catalog();
  await provider.save(dev, "NEW", "private-new", "");
  expect(catalogRows((await browser.catalog()) as VaultCatalog)).toHaveLength(
    3,
  );
  expect(
    catalogRows((await browser.catalog(true)) as VaultCatalog),
  ).toHaveLength(4);
  provider.vaults[staging].push({
    id: "bad",
    name: "bad name",
    value: "hidden",
    notes: "",
    version: 1,
  });
  const catalog = await browser.catalog(true);
  expect(catalog.errors[0]).toMatchObject({ id: staging, name: "Staging" });
  expect(catalog.matrices).toHaveLength(2);
  expect(JSON.stringify(catalog)).not.toContain("hidden");
});
it("explicit desktop authentication overrides an ambient token; service-account mode uses token scope", async () => {
  const provider = new MemoryProvider();
  const connect = vi
    .spyOn(OnePasswordProvider, "connect")
    .mockResolvedValue(provider as unknown as OnePasswordProvider);
  vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "test-token");
  try {
    await connectDiscovery({ auth: "desktop", account: "example" });
    expect(connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: "desktop", account: "example" }),
      true,
    );
    await connectDiscovery({ auth: "service-account" });
    expect(connect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auth: "service-account",
        account: "service-account",
      }),
      true,
    );
  } finally {
    connect.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("reveals one credential after vault snapshots expire without rereading the entire vault", async () => {
  vi.useFakeTimers();
  try {
    const { browser, provider } = await fixture();
    const catalog = await browser.catalog();
    const row = catalogRows(catalog as VaultCatalog).find(
      (r) => r.vaultId === dev,
    )!;
    const readVault = vi.spyOn(provider, "readVault");
    const readItem = vi.spyOn(provider, "readItem");
    await vi.advanceTimersByTimeAsync(30_001);
    const request = {
      environment: "vault",
      name: row.variable.name,
      fingerprint: row.matrix.fingerprint,
      itemId: row.variable.itemId,
      version: row.variable.explicit!.version,
    };
    const [first, second] = await Promise.all([
      browser.reveal(dev, request),
      browser.reveal(dev, request),
    ]);
    expect(first.value).toBe("private-dev");
    expect(second.value).toBe("private-dev");
    expect(readVault).not.toHaveBeenCalled();
    expect(readItem).toHaveBeenCalledTimes(1);
    expect(readItem).toHaveBeenCalledWith(dev, row.variable.itemId);
    await vi.advanceTimersByTimeAsync(30_001);
    provider.vaults[dev][0].version++;
    await expect(browser.reveal(dev, request)).rejects.toThrow("changed");
    expect(readVault).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps opened-cell values scoped to item identity/version and rejects late cache repopulation", async () => {
  const { VaultValueCache } = await import("../apps/web/src/vault-model.js");
  const { browser } = await fixture();
  const rows = catalogRows((await browser.catalog()) as VaultCatalog);
  const row = rows.find((r) => r.vaultId === dev)!;
  const other = rows.find(
    (r) => r.vaultId === prod && r.variable.name === "TOKEN",
  )!;
  const cache = new VaultValueCache();
  const value = {
    value: "private",
    editableValue: "private",
    explicitValue: "private",
    notes: "notes",
  };
  const load = vi.fn(async () => value);
  await cache.get(row, load);
  await cache.get(row, load);
  expect(load).toHaveBeenCalledTimes(1);
  expect(cache.peek(row)).toEqual(value);
  expect(cache.peek(other)).toBeUndefined();
  const next = {
    ...row,
    variable: {
      ...row.variable,
      explicit: {
        ...row.variable.explicit!,
        version: row.variable.explicit!.version + 1,
      },
    },
  };
  expect(cache.peek(next)).toBeUndefined();
  cache.reconcile([next]);
  expect(cache.peek(row)).toBeUndefined();
  let resolve!: (result: typeof value) => void;
  const pending = cache.get(row, () => new Promise((done) => (resolve = done)));
  await Promise.resolve();
  cache.clear();
  resolve(value);
  await pending;
  expect(cache.peek(row)).toBeUndefined();
});
