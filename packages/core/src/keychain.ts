import { VaultError } from "./errors.js";

export const keychainService = "com.envault.1password.service-account";
export const keychainName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

async function entry(name: string) {
  if (!keychainName.test(name))
    throw new VaultError("Invalid Keychain entry name.");
  if (process.platform !== "darwin")
    throw new VaultError(
      "Keychain credentials require macOS. Use OP_SERVICE_ACCOUNT_TOKEN on other platforms.",
    );
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(keychainService, name);
  } catch {
    throw new VaultError(
      "Could not initialize macOS Keychain access.",
      "authentication",
      502,
    );
  }
}

export async function readServiceAccountToken(name: string): Promise<string> {
  const credential = await entry(name);
  let token: string | undefined;
  try {
    token = await credential.getPassword();
  } catch {
    throw new VaultError(
      "Could not read the service-account token. Unlock macOS Keychain and allow envault to access it.",
      "authentication",
      502,
    );
  }
  if (!token)
    throw new VaultError(
      `No service-account token is stored for Keychain entry ${name}. Use envault auth store ${name}.`,
      "authentication",
      502,
    );
  return token;
}

export async function storeServiceAccountToken(name: string, token: string) {
  if (
    !token.startsWith("ops_") ||
    token.length > 65536 ||
    /[\r\n\0]/.test(token)
  )
    throw new VaultError(
      "Pass a valid 1Password service-account token on standard input.",
    );
  const credential = await entry(name);
  try {
    await credential.setPassword(token);
  } catch {
    throw new VaultError(
      "Could not store the service-account token in macOS Keychain. Unlock it and try again.",
      "authentication",
      502,
    );
  }
}

export async function removeServiceAccountToken(name: string) {
  const credential = await entry(name);
  try {
    return await credential.deleteCredential();
  } catch {
    throw new VaultError(
      "Could not remove the service-account token from macOS Keychain.",
      "authentication",
      502,
    );
  }
}
