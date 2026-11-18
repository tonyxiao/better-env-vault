import { expect, it, vi } from "vitest";
import {
  appConfiguration,
  appKeychainEntry,
  needsServiceAccountSetup,
} from "../apps/macos/configuration.js";

const missing = () => Promise.reject(new Error("Credential unavailable"));
const defaults = {
  environmentTokenAvailable: false,
  dataProtectionTokenAvailable: false,
  readToken: missing,
};
it("uses desktop authentication when no service-account credential is available", async () => {
  const config = await appConfiguration({ schemas: [] }, defaults);
  expect(config.discovery).toEqual({ auth: "desktop" });
  expect(await needsServiceAccountSetup(config)).toBe(false);
});
it("prefers the supplied environment credential without reading saved credentials", async () => {
  const readToken = vi.fn(missing);
  const config = await appConfiguration(
    { schemas: [] },
    {
      ...defaults,
      readToken,
      environmentTokenAvailable: true,
      dataProtectionTokenAvailable: true,
    },
  );
  expect(config.discovery).toEqual({ auth: "service-account" });
  expect(config.useDataProtectionToken).toBeUndefined();
  expect(readToken).not.toHaveBeenCalled();
});
it("uses the shared Data Protection credential before a duplicate app credential", async () => {
  const readToken = vi.fn(async () => "ops_non_secret_fixture");
  const config = await appConfiguration(
    { schemas: [] },
    { ...defaults, readToken, dataProtectionTokenAvailable: true },
  );
  expect(readToken).not.toHaveBeenCalled();
  expect(config.discovery).toEqual({ auth: "service-account" });
  expect(config.useDataProtectionToken).toBe(true);
});
it("uses the existing Data Protection credential without desktop authentication or a token copy", async () => {
  const config = await appConfiguration(
    { schemas: [] },
    { ...defaults, dataProtectionTokenAvailable: true },
  );
  expect(config.discovery).toEqual({ auth: "service-account" });
  expect(config.useDataProtectionToken).toBe(true);
  expect(await needsServiceAccountSetup(config)).toBe(false);
});
it("honors explicit desktop and named Keychain choices without silently changing authentication", async () => {
  const readToken = vi.fn(missing);
  const options = {
    ...defaults,
    readToken,
    environmentTokenAvailable: true,
    dataProtectionTokenAvailable: true,
  };
  expect(
    (
      await appConfiguration(
        { schemas: [], discovery: { auth: "desktop", account: "selected" } },
        options,
      )
    ).discovery,
  ).toEqual({ auth: "desktop", account: "selected" });
  const named = await appConfiguration(
    { schemas: [], discovery: { serviceAccountKeychain: "selected" } },
    options,
  );
  expect(named.discovery).toEqual({
    auth: "service-account",
    serviceAccountKeychain: "selected",
  });
  expect(readToken).not.toHaveBeenCalled();
  expect(await needsServiceAccountSetup(named, readToken)).toBe(true);
  expect(readToken).toHaveBeenCalledWith("selected");
});
it("opens secure setup for an explicit service-account choice when no token exists", async () => {
  const config = await appConfiguration(
    { schemas: [], discovery: { auth: "service-account" } },
    defaults,
  );
  expect(config.discovery).toEqual({
    auth: "service-account",
    serviceAccountKeychain: appKeychainEntry,
  });
  expect(await needsServiceAccountSetup(config, missing)).toBe(true);
});
it("allows replacing an app credential even when another credential is available", async () => {
  const readToken = vi.fn(missing);
  const config = await appConfiguration(
    { schemas: [], configureServiceAccount: true },
    {
      ...defaults,
      readToken,
      environmentTokenAvailable: true,
      dataProtectionTokenAvailable: true,
    },
  );
  expect(config.discovery).toEqual({
    auth: "service-account",
    serviceAccountKeychain: appKeychainEntry,
  });
  expect(await needsServiceAccountSetup(config, readToken)).toBe(true);
  expect(readToken).not.toHaveBeenCalled();
});
it("preserves schema authentication settings while making an existing headless token available", async () => {
  const readToken = vi.fn(missing);
  const config = await appConfiguration(
    { schemas: ["/project/.env.schema"], sourceNames: ["work"] },
    { ...defaults, readToken, dataProtectionTokenAvailable: true },
  );
  expect(config).toEqual({
    schemas: ["/project/.env.schema"],
    sourceNames: ["work"],
    useDataProtectionToken: true,
  });
  expect(await needsServiceAccountSetup(config, readToken)).toBe(false);
  expect(readToken).not.toHaveBeenCalled();
});
