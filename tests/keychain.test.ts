import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config } from "./helpers.js";

const mock = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  fail: false,
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    key: string;
    constructor(service: string, name: string) {
      this.key = service + ":" + name;
    }
    async setPassword(token: string) {
      if (mock.fail) throw Error("ops_sensitive_error");
      mock.entries.set(this.key, token);
    }
    async getPassword() {
      if (mock.fail) throw Error("ops_sensitive_error");
      return mock.entries.get(this.key);
    }
    async deleteCredential() {
      if (mock.fail) throw Error("ops_sensitive_error");
      return mock.entries.delete(this.key);
    }
  },
}));
vi.mock("@1password/sdk", async (original) => ({
  ...(await original<typeof import("@1password/sdk")>()),
  createClient: vi.fn(),
}));
import { createClient } from "@1password/sdk";
import {
  readServiceAccountToken,
  storeServiceAccountToken,
  removeServiceAccountToken,
} from "../packages/core/src/keychain.js";
import { configSchema } from "../packages/core/src/schema.js";
import { OnePasswordProvider } from "../packages/core/src/provider.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  mock.entries.clear();
  mock.fail = false;
  vi.mocked(createClient).mockReset();
  vi.mocked(createClient).mockResolvedValue({
    vaults: {
      list: async () =>
        Object.values(config.environments).map((environment) => ({
          id: environment.vault,
        })),
    },
  } as any);
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
});

it("stores and reads a named credential in the envault namespace and removes only that entry", async () => {
  await storeServiceAccountToken("test", "ops_non_secret_fixture");
  await storeServiceAccountToken("other", "ops_other_fixture");
  expect(await readServiceAccountToken("test")).toBe("ops_non_secret_fixture");
  expect(await removeServiceAccountToken("test")).toBe(true);
  expect(await removeServiceAccountToken("test")).toBe(false);
  expect(await readServiceAccountToken("other")).toBe("ops_other_fixture");
  await expect(readServiceAccountToken("test")).rejects.toThrow(
    "No service-account token",
  );
});
it("uses an explicit schema Keychain reference rather than an unrelated environment token", async () => {
  vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "ops_unrelated_fixture");
  await storeServiceAccountToken("testing", "ops_scoped_fixture");
  await OnePasswordProvider.connect({
    ...config,
    auth: "service-account",
    serviceAccountKeychain: "testing",
  });
  expect(vi.mocked(createClient).mock.calls[0][0].auth).toBe(
    "ops_scoped_fixture",
  );
});
it("retains environment-token authentication and never falls back to desktop or another credential", async () => {
  vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "ops_env_fixture");
  await OnePasswordProvider.connect({ ...config, auth: "service-account" });
  expect(vi.mocked(createClient).mock.calls[0][0].auth).toBe("ops_env_fixture");
  vi.mocked(createClient).mockClear();
  await expect(
    OnePasswordProvider.connect({
      ...config,
      auth: "service-account",
      serviceAccountKeychain: "missing",
    }),
  ).rejects.toThrow("No service-account token");
  expect(createClient).not.toHaveBeenCalled();
});
it("rejects invalid references, desktop/Keychain combinations, and malformed token input", async () => {
  expect(() =>
    configSchema.parse({ ...config, serviceAccountKeychain: "test" }),
  ).toThrow();
  await expect(readServiceAccountToken("../other")).rejects.toThrow(
    "Invalid Keychain entry",
  );
  await expect(storeServiceAccountToken("test", "invalid")).rejects.toThrow(
    "valid 1Password",
  );
  await expect(
    storeServiceAccountToken("test", "ops_first\nsecond"),
  ).rejects.toThrow("valid 1Password");
  expect(mock.entries.size).toBe(0);
});
it("reports missing platform support and masks native credential errors", async () => {
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
  await expect(readServiceAccountToken("test")).rejects.toThrow(
    "require macOS",
  );
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  mock.fail = true;
  for (const action of [
    () => readServiceAccountToken("test"),
    () => storeServiceAccountToken("test", "ops_fixture"),
    () => removeServiceAccountToken("test"),
  ]) {
    try {
      await action();
      throw Error("Expected Keychain failure");
    } catch (error) {
      expect((error as Error).message).not.toContain("ops_");
      expect((error as Error).message).toContain("Keychain");
    }
  }
});
