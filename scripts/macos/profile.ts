/** Public signing metadata only: never credentials, keys, or vault contents. */
export interface ProvisioningProfile {
  path: string;
  applicationIdentifier: string;
  keychainGroups: string[];
  expiresAt: string;
  devices: string[];
  allDevices: boolean;
  certificateSha1s: string[];
}

const team = "H82Z395PDV";
const identifier = "com.txlforge.better-env-vault";
const requiredGroups = [
  `${team}.${identifier}`,
  `${team}.com.tonyxiao.codex-keychain-helper`,
];
export function selectProfile(
  profiles: ProvisioningProfile[],
  requiredDevices: string[],
  certificateSha1: string,
  now = Date.now(),
): ProvisioningProfile | undefined {
  const normalizedDevices = requiredDevices.map((id) => id.toUpperCase());
  return profiles
    .filter(
      (profile) =>
        [`${team}.*`, `${team}.${identifier}`].includes(
          profile.applicationIdentifier,
        ) &&
        (profile.keychainGroups.includes(`${team}.*`) ||
          requiredGroups.every((group) =>
            profile.keychainGroups.includes(group),
          )) &&
        Date.parse(profile.expiresAt) > now &&
        profile.certificateSha1s.some(
          (fingerprint) =>
            fingerprint.toUpperCase() === certificateSha1.toUpperCase(),
        ) &&
        (profile.allDevices ||
          normalizedDevices.every((id) =>
            profile.devices.some((device) => device.toUpperCase() === id),
          )),
    )
    .sort(
      (a, b) =>
        Number(b.allDevices) - Number(a.allDevices) ||
        b.devices.length - a.devices.length ||
        Date.parse(b.expiresAt) - Date.parse(a.expiresAt),
    )[0];
}
