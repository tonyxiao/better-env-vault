import { it, expect, vi } from "vitest";
vi.mock("@1password/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@1password/sdk")>()),
  createClient: vi.fn(),
}));
import { createClient, type Client } from "@1password/sdk";
import { connectDiscovery } from "../packages/core/src/discovery.js";
import { VaultBrowser } from "../apps/web/src/vault-browser.js";
import { config } from "./helpers.js";

it("reuses validated discovery metadata during startup and re-lists on an explicit refresh", async () => {
  const id = config.environments.dev.vault;
  const list = vi.fn(async () => [{ id, title: "Development" }]);
  const client = { vaults: { list } } as unknown as Client;
  vi.mocked(createClient).mockResolvedValue(client);
  vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "synthetic-token");
  try {
    const provider = await connectDiscovery({ auth: "service-account" });
    expect(list).toHaveBeenCalledTimes(1);
    const browser = new VaultBrowser({ auth: "service-account" }, provider);
    expect(await browser.projects()).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(1);
    await browser.projects();
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllEnvs();
    vi.mocked(createClient).mockReset();
  }
});
