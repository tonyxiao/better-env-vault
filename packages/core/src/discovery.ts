import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  OnePasswordProvider,
  type Provider,
  type VaultItem,
  type VaultInfo,
} from "./provider.js";
import { VaultError } from "./errors.js";

export interface DiscoveryOptions {
  auth?: "desktop" | "service-account";
  account?: string;
  serviceAccountKeychain?: string;
}

/** Discover account metadata only; tokens and secret values never pass through op. */
export async function discoverAccounts(account?: string): Promise<string[]> {
  if (account) return [account];
  if (process.env.OP_ACCOUNT) return [process.env.OP_ACCOUNT];
  try {
    const { stdout } = await promisify(execFile)(
      "op",
      ["account", "list", "--format", "json"],
      { timeout: 10_000, maxBuffer: 256_000 },
    );
    const accounts: unknown = JSON.parse(stdout);
    if (Array.isArray(accounts)) {
      const ids = accounts
        .map((a) => a?.account_uuid)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length) return [...new Set(ids)];
    }
  } catch {
    /* Give a stable error without account CLI diagnostics. */
  }
  throw new VaultError(
    "Select a 1Password account with --account <account-uuid>, or install the 1Password CLI for automatic account discovery.",
  );
}

export async function connectDiscovery(
  options: DiscoveryOptions,
): Promise<Provider> {
  if (options.auth === "desktop" && options.serviceAccountKeychain)
    throw new VaultError(
      "Choose desktop authentication or a service-account Keychain entry.",
    );
  const serviceAccount = options.auth
    ? options.auth === "service-account"
    : !!options.serviceAccountKeychain ||
      !!process.env.OP_SERVICE_ACCOUNT_TOKEN;
  const accounts = serviceAccount
    ? [options.account ?? "service-account"]
    : await discoverAccounts(options.account);
  const providers: { account: string; provider: OnePasswordProvider }[] = [];
  for (const account of accounts) {
    const provider = await OnePasswordProvider.connect(
      {
        version: 1,
        provider: "1password",
        account,
        auth: serviceAccount ? "service-account" : "desktop",
        environments: {},
        ...(options.serviceAccountKeychain
          ? { serviceAccountKeychain: options.serviceAccountKeychain }
          : {}),
      },
      true,
    );
    providers.push({ account, provider });
  }
  const owners = new Map<string, Provider>();
  function owner(id: string) {
    const provider = owners.get(id);
    if (!provider) throw new VaultError("Select an accessible vault.");
    return provider;
  }
  const discovered: Provider = {
    async listVaults(): Promise<VaultInfo[]> {
      const vaults: VaultInfo[] = [];
      for (const { account, provider } of providers) {
        for (const vault of await provider.listVaults()) {
          owners.set(vault.id, provider);
          vaults.push({ ...vault, account });
        }
      }
      const accessible = new Set(vaults.map((v) => v.id));
      for (const id of owners.keys())
        if (!accessible.has(id)) owners.delete(id);
      return vaults;
    },
    readVault: async (id) => owner(id).readVault(id),
    readItem: async (id, itemId) => owner(id).readItem!(id, itemId),
    save: async (id, name, value, notes, previous) =>
      owner(id).save(id, name, value, notes, previous),
    remove: async (id, previous) => owner(id).remove(id, previous),
    rename: async (id, previous, name) => owner(id).rename(id, previous, name),
    restore: async (id: string, previous: VaultItem) =>
      owner(id).restore!(id, previous),
  };
  await discovered.listVaults!();
  return discovered;
}
