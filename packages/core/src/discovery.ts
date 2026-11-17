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

export interface DesktopAccount {
  id: string;
  label: string;
}

/** Cached account metadata only; never authenticate or read vault contents. */
export async function desktopAccounts(): Promise<DesktopAccount[]> {
  try {
    const env = { ...process.env };
    delete env.OP_SERVICE_ACCOUNT_TOKEN;
    const { stdout } = await promisify(execFile)(
      "op",
      ["account", "list", "--format", "json"],
      { timeout: 10_000, maxBuffer: 256_000, env },
    );
    return parseDesktopAccounts(JSON.parse(stdout));
  } catch {
    return [];
  }
}
export function parseDesktopAccounts(value: unknown): DesktopAccount[] {
  if (!Array.isArray(value)) return [];
  const accounts = new Map<string, DesktopAccount>();
  for (const account of value) {
    if (
      typeof account?.account_uuid !== "string" ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(account.account_uuid)
    )
      continue;
    let domain = "";
    try {
      domain = new URL(
        account.url.includes("://") ? account.url : "https://" + account.url,
      ).hostname;
    } catch {
      /* Optional metadata. */
    }
    const email =
      typeof account.email === "string" ? account.email.slice(0, 160) : "";
    accounts.set(account.account_uuid, {
      id: account.account_uuid,
      label:
        [domain, email].filter(Boolean).join(" · ") || account.account_uuid,
    });
  }
  return [...accounts.values()];
}

export async function discoverAccounts(account?: string): Promise<string[]> {
  if (account) return [account];
  if (process.env.OP_ACCOUNT) return [process.env.OP_ACCOUNT];
  const accounts = await desktopAccounts();
  if (accounts.length) return accounts.map((account) => account.id);
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
  let initialVaults: VaultInfo[] | undefined;
  function owner(id: string) {
    initialVaults = undefined;
    const provider = owners.get(id);
    if (!provider) throw new VaultError("Select an accessible vault.");
    return provider;
  }
  const discovered: Provider = {
    takeInitialVaults() {
      const vaults = initialVaults;
      initialVaults = undefined;
      return vaults;
    },
    async listVaults(): Promise<VaultInfo[]> {
      initialVaults = undefined;
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
    diagnostics: (id) => owner(id).diagnostics?.(id) ?? [],
    readVault: async (id) => owner(id).readVault(id),
    readItem: async (id, itemId) => owner(id).readItem!(id, itemId),
    save: async (id, name, value, notes, previous) =>
      owner(id).save(id, name, value, notes, previous),
    remove: async (id, previous) => owner(id).remove(id, previous),
    rename: async (id, previous, name) => owner(id).rename(id, previous, name),
    restore: async (id: string, previous: VaultItem) =>
      owner(id).restore!(id, previous),
  };
  initialVaults = await discovered.listVaults!();
  return discovered;
}
