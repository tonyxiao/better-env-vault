import type { DiscoveryOptions } from "../../packages/core/src/discovery.js";
import { readServiceAccountToken } from "../../packages/core/src/keychain.js";

export const appKeychainEntry = "better-env-vault";
export interface AppConfiguration {
  schemas: string[];
  discovery?: DiscoveryOptions;
  configureServiceAccount?: boolean;
  useDataProtectionToken?: boolean;
}

/** Prefer configured credentials, then saved credentials, then desktop auth. */
export async function appConfiguration(
  config: AppConfiguration,
  options: {
    environmentTokenAvailable?: boolean;
    dataProtectionTokenAvailable?: boolean;
    readToken?: typeof readServiceAccountToken;
  } = {},
): Promise<AppConfiguration> {
  const environmentTokenAvailable =
    options.environmentTokenAvailable ?? !!process.env.OP_SERVICE_ACCOUNT_TOKEN;
  const dataProtectionTokenAvailable =
    options.dataProtectionTokenAvailable ??
    !!process.env.BEV_DATA_PROTECTION_SERVICE_ACCOUNT_TOKEN;
  if (config.schemas.length)
    return {
      schemas: config.schemas,
      useDataProtectionToken:
        !environmentTokenAvailable && dataProtectionTokenAvailable,
    };
  const discovery = { ...config.discovery };
  if (config.configureServiceAccount) {
    discovery.auth = "service-account";
    discovery.serviceAccountKeychain ??= appKeychainEntry;
    return { ...config, discovery };
  }
  // An explicit selection must never silently switch identities on failure.
  if (discovery.auth === "desktop" || discovery.serviceAccountKeychain)
    return {
      ...config,
      discovery: {
        ...discovery,
        auth: discovery.auth ?? "service-account",
      },
    };
  if (environmentTokenAvailable)
    return { ...config, discovery: { ...discovery, auth: "service-account" } };
  try {
    await (options.readToken ?? readServiceAccountToken)(appKeychainEntry);
    return {
      ...config,
      discovery: {
        ...discovery,
        auth: "service-account",
        serviceAccountKeychain: appKeychainEntry,
      },
    };
  } catch {
    // No usable saved app credential: try the existing Data Protection item.
  }
  if (dataProtectionTokenAvailable)
    return {
      ...config,
      discovery: { ...discovery, auth: "service-account" },
      useDataProtectionToken: true,
    };
  return {
    ...config,
    discovery:
      discovery.auth === "service-account"
        ? { ...discovery, serviceAccountKeychain: appKeychainEntry }
        : { ...discovery, auth: "desktop" },
  };
}

/** Reading credentials uses the same native Keychain API as envault auth. */
export async function needsServiceAccountSetup(
  config: AppConfiguration,
  readToken = readServiceAccountToken,
): Promise<boolean> {
  if (config.schemas.length || config.discovery?.auth !== "service-account")
    return false;
  if (config.configureServiceAccount) return true;
  const name = config.discovery.serviceAccountKeychain;
  if (!name) return false;
  try {
    await readToken(name);
    return false;
  } catch {
    return true;
  }
}
