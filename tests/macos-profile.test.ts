import { expect, it } from "vitest";
import {
  selectProfile,
  type ProvisioningProfile,
} from "../scripts/macos/profile.js";

const now = Date.parse("2026-11-18T00:00:00Z");
const profile: ProvisioningProfile = {
  path: "/profiles/all-macs.provisionprofile",
  applicationIdentifier: "H82Z395PDV.*",
  keychainGroups: ["H82Z395PDV.*"],
  expiresAt: "2027-11-18T00:00:00Z",
  devices: ["studio", "m5", "mba", "mini"],
  allDevices: false,
  certificateSha1s: ["required-certificate"],
};
const select = (profiles: ProvisioningProfile[]) =>
  selectProfile(
    profiles,
    ["studio", "m5", "mba", "mini"],
    "required-certificate",
    now,
  );

it("rejects a single-Mac profile when any requested Mac is missing", () => {
  expect(select([{ ...profile, devices: ["studio"] }])).toBeUndefined();
  expect(select([profile])).toBe(profile);
});
it("prefers a profile covering more devices rather than the first matching file", () => {
  const single = { ...profile, path: "/profiles/single", devices: ["studio"] };
  expect(
    selectProfile([single, profile], ["studio"], "required-certificate", now),
  ).toBe(profile);
});
it("requires the actual signing certificate and an unexpired profile", () => {
  expect(
    select([{ ...profile, certificateSha1s: ["another-certificate"] }]),
  ).toBeUndefined();
  expect(
    select([{ ...profile, expiresAt: "2026-01-01T00:00:00Z" }]),
  ).toBeUndefined();
});
it("requires the app identifier and both Keychain access groups", () => {
  expect(
    select([{ ...profile, applicationIdentifier: "ANOTHERTEAM.*" }]),
  ).toBeUndefined();
  expect(
    select([
      {
        ...profile,
        keychainGroups: ["H82Z395PDV.com.txlforge.better-env-vault"],
      },
    ]),
  ).toBeUndefined();
  expect(
    select([
      {
        ...profile,
        applicationIdentifier: "H82Z395PDV.com.txlforge.better-env-vault",
        keychainGroups: [
          "H82Z395PDV.com.txlforge.better-env-vault",
          "H82Z395PDV.com.tonyxiao.codex-keychain-helper",
        ],
      },
    ]),
  ).toBeDefined();
});
it("normalizes certificate and device identifiers and supports all-device profiles", () => {
  expect(
    selectProfile([profile], ["STUDIO", "M5"], "REQUIRED-CERTIFICATE", now),
  ).toBe(profile);
  expect(select([{ ...profile, allDevices: true, devices: [] }])).toBeDefined();
});
