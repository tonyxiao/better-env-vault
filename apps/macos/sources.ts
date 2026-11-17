import type { DiscoveryOptions } from "../../packages/core/src/discovery.js";
import { keychainName } from "../../packages/core/src/keychain.js";
import type { AppConfiguration } from "./configuration.js";

export interface DesktopAccount {
  id: string;
  label: string;
}
export interface AppSource {
  id: string;
  label: string;
  schemas: string[];
  discovery?: DiscoveryOptions;
}
export function sourceId(config: AppConfiguration): string {
  if (config.schemas.length) return "schemas";
  const discovery = config.discovery;
  return discovery?.auth === "desktop"
    ? `desktop:${discovery.account ?? "auto"}`
    : `service:${discovery?.serviceAccountKeychain ?? "session"}`;
}
/** Metadata only. Never enumerate or serialize token values. */
export function appSources(
  config: AppConfiguration,
  names: string[],
  accounts: DesktopAccount[],
): AppSource[] {
  const sources: AppSource[] = [];
  const add = (source: AppSource) => {
    if (!sources.some((candidate) => candidate.id === source.id))
      sources.push(source);
  };
  if (config.schemas.length)
    add({ id: "schemas", label: "Project schemas", schemas: config.schemas });
  for (const name of [...new Set(names)]
    .filter((name) => keychainName.test(name))
    .sort(
      (a, b) =>
        Number(b === "better-env-vault") - Number(a === "better-env-vault") ||
        a.localeCompare(b),
    ))
    add({
      id: `service:${name}`,
      label:
        name === "better-env-vault"
          ? "Service Account · Default"
          : `Service Account · ${name}`,
      schemas: [],
      discovery: { auth: "service-account", serviceAccountKeychain: name },
    });
  for (const account of config.desktopAccounts ?? [])
    if (
      account.length <= 128 &&
      !/[\r\n\0]/.test(account) &&
      !account.startsWith("ops_") &&
      !account.startsWith("A3-")
    )
      add({
        id: `desktop:${account}`,
        label: `Desktop · ${account}`,
        schemas: [],
        discovery: { auth: "desktop", account },
      });
  for (const account of accounts)
    add({
      id: `desktop:${account.id}`,
      label: `Desktop · ${account.label}`,
      schemas: [],
      discovery: { auth: "desktop", account: account.id },
    });
  const selected = sourceId(config);
  if (selected.startsWith("service:")) {
    add({
      id: selected,
      label: config.discovery?.serviceAccountKeychain
        ? `Service Account · ${config.discovery.serviceAccountKeychain}`
        : "Service Account · Launch session",
      schemas: [],
      discovery: config.discovery,
    });
  }
  if (
    selected.startsWith("desktop:") ||
    (!accounts.length && !config.desktopAccounts?.length)
  )
    add({
      id: selected.startsWith("desktop:") ? selected : "desktop:auto",
      label:
        config.discovery?.auth === "desktop" && config.discovery.account
          ? `Desktop · ${config.discovery.account}`
          : "Desktop · Choose Account…",
      schemas: [],
      discovery: {
        auth: "desktop",
        ...(config.discovery?.auth === "desktop" ? config.discovery : {}),
      },
    });
  return sources;
}
