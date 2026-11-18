import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const identity = "Apple Development: Tony Xiao (9QULCFJ59K)";
const output = join(root, ".local/electron");
const scratch = join(root, "tmp/electron-build");
const stage = join(scratch, "stage");
const packageOutput = join(scratch, "out");
const appName = "Better Env Vault";
const installed = join(homedir(), "Applications/Better Env Vault.app");
const appBundle = join(output, `${appName}.app`);
const baseEntitlements = join(root, "apps/electron/entitlements.plist");
const utilityEntitlements = join(
  root,
  "apps/electron/entitlements-utility.plist",
);
const credentialEntitlements = join(
  root,
  "apps/electron/entitlements-credential.plist",
);
const install = process.argv.includes("--install");

const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1]) throw new Error(`Missing value for ${name}.`);
  return resolve(process.argv[index + 1]);
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
}

if (process.platform !== "darwin")
  throw new Error(
    "This build command currently packages the macOS Electron app.",
  );
const identities = execFileSync(
  "security",
  ["find-identity", "-v", "-p", "codesigning"],
  { encoding: "utf8" },
);
if (!identities.includes(`"${identity}"`))
  throw new Error(`Required signing identity unavailable: ${identity}`);
const identityMatch = identities
  .split("\n")
  .find((line) => line.includes(`"${identity}"`))
  ?.match(/\b([A-F0-9]{40})\b/);
if (!identityMatch) throw new Error("Could not resolve signing certificate.");
const certificateSha1 = identityMatch[1].toLowerCase();

const requestedProfile = argument("--profile");
const profileCandidates = requestedProfile
  ? [requestedProfile]
  : [join(output, "all-macs.provisionprofile")];
for (const directory of [
  join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles"),
  join(homedir(), "Library/MobileDevice/Provisioning Profiles"),
])
  try {
    for (const name of await readdir(directory))
      if (/\.(provisionprofile|mobileprovision)$/.test(name))
        profileCandidates.push(join(directory, name));
  } catch {
    /* Xcode may not have created both profile directories. */
  }

const profileRecords = [];
for (const path of profileCandidates)
  try {
    const xml = execFileSync("security", ["cms", "-D", "-i", path], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const extract = (key, format = "raw") =>
      execFileSync("plutil", ["-extract", key, format, "-o", "-", "--", "-"], {
        input: xml,
        encoding: "utf8",
      });
    const list = (key) =>
      [...extract(key, "xml1").matchAll(/<string>([^<]+)<\/string>/g)].map(
        (match) => match[1],
      );
    const certificates = [
      ...extract("DeveloperCertificates", "xml1").matchAll(
        /<data>([\s\S]*?)<\/data>/g,
      ),
    ].map((match) =>
      createHash("sha1")
        .update(Buffer.from(match[1].replace(/\s/g, ""), "base64"))
        .digest("hex"),
    );
    const entitlements = JSON.parse(
      execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
        input: extract("Entitlements", "xml1"),
        encoding: "utf8",
      }),
    );
    profileRecords.push({
      path,
      applicationIdentifier:
        entitlements["com.apple.application-identifier"] ?? "",
      keychainGroups: entitlements["keychain-access-groups"] ?? [],
      platforms: list("Platform"),
      devices: list("ProvisionedDevices"),
      expiresAt: new Date(extract("ExpirationDate").trim()),
      certificates,
    });
  } catch {
    /* Ignore unrelated or invalid profiles. */
  }

const hardware = JSON.parse(
  execFileSync("system_profiler", ["SPHardwareDataType", "-json"], {
    encoding: "utf8",
  }),
).SPHardwareDataType?.[0];
const currentDevice = hardware?.provisioning_UDID;
if (!currentDevice)
  throw new Error("Could not identify this Mac's Provisioning UDID.");
const requiredDevices = [currentDevice];
const devicesFile = argument("--devices-file");
if (devicesFile) {
  const targets = JSON.parse(await readFile(devicesFile, "utf8"));
  for (const target of targets) {
    if (!target.udid)
      throw new Error("Every target Mac must have a Provisioning UDID.");
    requiredDevices.push(target.udid);
  }
}
const covers = (pattern, value) =>
  pattern === value ||
  (pattern.endsWith("*") && value.startsWith(pattern.slice(0, -1)));
const profile = profileRecords
  .filter(
    (candidate) =>
      candidate.expiresAt > new Date() &&
      candidate.platforms.includes("OSX") &&
      candidate.certificates.includes(certificateSha1) &&
      covers(
        candidate.applicationIdentifier,
        "H82Z395PDV.com.txlforge.better-env-vault",
      ) &&
      candidate.keychainGroups.some((group) =>
        covers(group, "H82Z395PDV.com.tonyxiao.codex-keychain-helper"),
      ) &&
      requiredDevices.every((device) => candidate.devices.includes(device)),
  )
  .sort((left, right) => right.expiresAt - left.expiresAt)[0];
if (!profile)
  throw new Error(
    `No Mac provisioning profile authorizes the shared Data Protection Keychain group for ${new Set(requiredDevices).size} required device(s).`,
  );
await mkdir(output, { recursive: true });
if (requestedProfile)
  await cp(profile.path, join(output, "all-macs.provisionprofile"));
console.log(
  `Shared Data Protection profile covers ${profile.devices.length} Mac(s).`,
);

run("npm", ["run", "build"]);
await rm(scratch, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const source of [
  "dist/packages",
  "dist/apps/web/src",
  "dist/apps/macos/configuration.js",
  "dist/apps/macos/sources.js",
  "dist/apps/electron",
  "apps/web/dist",
])
  await cp(join(root, source), join(stage, source), { recursive: true });
await mkdir(join(stage, "apps/electron"), { recursive: true });
for (const file of ["preload.cjs", "prompt-preload.cjs", "prompt.html"])
  await cp(
    join(root, "apps/electron", file),
    join(stage, "apps/electron", file),
  );
for (const file of ["package.json", "package-lock.json"])
  await cp(join(root, file), join(stage, file));
run(
  "npm",
  [
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--workspaces=false",
    "--no-audit",
    "--no-fund",
  ],
  { cwd: stage },
);
const rootPackage = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
await writeFile(
  join(stage, "package.json"),
  JSON.stringify({
    name: "better-env-vault",
    productName: appName,
    version: rootPackage.version,
    private: true,
    type: "module",
    main: "dist/apps/electron/main.js",
    dependencies: rootPackage.dependencies,
  }),
);

const iconset = join(scratch, "AppIcon.iconset");
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    run("sips", [
      "-z",
      String(size * scale),
      String(size * scale),
      join(root, "apps/macos/assets/AppIcon.png"),
      "--out",
      join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
    ]);
const icon = join(scratch, "AppIcon.icns");
run("iconutil", ["-c", "icns", iconset, "-o", icon]);
const credentialBundle = join(scratch, "DataProtectionCredential.app");
const credentialContents = join(credentialBundle, "Contents");
const credentialMacOS = join(credentialContents, "MacOS");
const credentialReader = join(credentialMacOS, "DataProtectionCredential");
await mkdir(credentialMacOS, { recursive: true });
run("xcrun", [
  "swiftc",
  "-O",
  "-framework",
  "Security",
  join(root, "apps/electron/DataProtectionCredential.swift"),
  "-o",
  credentialReader,
]);
await cp(profile.path, join(credentialContents, "embedded.provisionprofile"));
await writeFile(
  join(credentialContents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>DataProtectionCredential</string>
<key>CFBundleIdentifier</key><string>com.txlforge.better-env-vault.credential</string>
<key>CFBundleName</key><string>DataProtectionCredential</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${rootPackage.version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>`,
);

const [directory] = await packager({
  dir: stage,
  out: packageOutput,
  overwrite: true,
  prune: false,
  platform: "darwin",
  arch: process.arch,
  electronVersion: "45.3.4",
  name: appName,
  appBundleId: "com.txlforge.better-env-vault",
  icon,
  appVersion: rootPackage.version,
  buildVersion: "3",
  extraResource: [credentialBundle],
  osxSign: {
    identity,
    type: "development",
    continueOnError: false,
    batchCodesignCalls: true,
    hardenedRuntime: true,
    entitlements: baseEntitlements,
    provisioningProfile: profile.path,
    preAutoEntitlements: false,
    optionsForFile(filePath) {
      if (filePath.includes("/DataProtectionCredential.app"))
        return { entitlements: credentialEntitlements, timestamp: "none" };
      if (/ Helper\.app$/.test(filePath))
        return { entitlements: utilityEntitlements, timestamp: "none" };
      return { timestamp: "none" };
    },
  },
});
const packaged = join(directory, `${appName}.app`);
run("codesign", ["--verify", "--deep", "--strict", packaged]);
await mkdir(output, { recursive: true });
await rm(appBundle, { recursive: true, force: true });
await rename(packaged, appBundle);

if (install) {
  for (const processName of [appName, "BetterEnvVault"])
    try {
      run("/usr/bin/killall", [processName], { stdio: "ignore" });
    } catch {
      /* The corresponding old or new shell is not running. */
    }
  await mkdir(dirname(installed), { recursive: true });
  const backup = join(output, "previous.app");
  const fresh = join(output, "fresh-install.app");
  await rm(backup, { recursive: true, force: true });
  await rm(fresh, { recursive: true, force: true });
  run("ditto", [appBundle, fresh]);
  run("codesign", ["--verify", "--deep", "--strict", fresh]);
  try {
    await rename(installed, backup);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rename(fresh, installed);
  run("codesign", ["--verify", "--deep", "--strict", installed]);
  run(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", installed],
  );
}

console.log(install ? installed : appBundle);
