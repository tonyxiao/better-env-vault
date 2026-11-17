import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

const identity = "Apple Development: Tony Xiao (9QULCFJ59K)";
const identifier = "com.txlforge.better-env-vault";
const root = resolve(import.meta.dirname, "../..");
const output = join(root, ".local/macos");
const bundle = join(output, "Better Env Vault.app");
const contents = join(bundle, "Contents");
const resources = join(contents, "Resources");
const app = join(resources, "app");
function run(command, args, options = {}) {
  return (
    execFileSync(command, args, {
      cwd: root,
      stdio: "pipe",
      ...options,
    })?.toString() ?? ""
  );
}
if (process.platform !== "darwin")
  throw new Error("macOS is required to build and sign the app.");
const identities = run("security", [
  "find-identity",
  "-v",
  "-p",
  "codesigning",
]);
const certificateSha1 = identities
  .split("\n")
  .find((line) => line.includes(`"${identity}"`))
  ?.match(/[A-F0-9]{40}/)?.[0];
if (!certificateSha1)
  throw new Error(
    `Required signing identity unavailable: ${identity}. No ad-hoc fallback is permitted.`,
  );
if (!["arm64", "x64"].includes(process.arch))
  throw new Error("Unsupported macOS architecture.");
const version = "24.22.3";
const checksums = {
  arm64: "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
  x64: "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7",
};
const archiveName = `node-v${version}-darwin-${process.arch}`;
await mkdir(output, { recursive: true });
const archive = join(output, `${archiveName}.tar.gz`);
try {
  if (
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex") !== checksums[process.arch]
  )
    await rm(archive);
} catch {
  /* Download a clean, pinned runtime below. */
}
try {
  await readFile(archive);
} catch {
  run("/usr/bin/curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--connect-timeout",
    "20",
    "--max-time",
    "180",
    "--retry",
    "2",
    "--output",
    archive,
    `https://nodejs.org/dist/v${version}/${archiveName}.tar.gz`,
  ]);
}
if (
  createHash("sha256")
    .update(await readFile(archive))
    .digest("hex") !== checksums[process.arch]
)
  throw new Error("Node runtime checksum mismatch.");
run("npm", ["run", "build"], { stdio: "inherit" });
await rm(bundle, { recursive: true, force: true });
await mkdir(join(contents, "MacOS"), { recursive: true });
await mkdir(app, { recursive: true });
run("tar", [
  "-xzf",
  archive,
  "-C",
  output,
  `${archiveName}/bin/node`,
  `${archiveName}/LICENSE`,
]);
await cp(join(output, archiveName), join(resources, "runtime"), {
  recursive: true,
});
await rm(join(output, archiveName), { recursive: true });
for (const path of [
  "dist/packages",
  "dist/apps/web/src",
  "dist/apps/macos",
  "apps/web/dist",
])
  await cp(join(root, path), join(app, path), { recursive: true });
for (const path of ["package.json", "package-lock.json"])
  await cp(join(root, path), join(app, path));
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
  { cwd: app, stdio: "inherit" },
);
await writeFile(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>Better Env Vault</string>
<key>CFBundleDisplayName</key><string>Better Env Vault</string>
<key>CFBundleExecutable</key><string>BetterEnvVault</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSQuitAlwaysKeepsWindows</key><false/>
</dict></plist>`,
);
const executable = join(contents, "MacOS/BetterEnvVault");
run("xcrun", [
  "swiftc",
  "-O",
  "-target",
  `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`,
  "-framework",
  "AppKit",
  "-framework",
  "WebKit",
  join(root, "apps/macos/BetterEnvVault.swift"),
  "-o",
  executable,
]);
const entitlements = join(output, "node-entitlements.plist");
await writeFile(
  entitlements,
  `<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>`,
);
const nativeFiles = [];
async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) await visit(target);
    else if (entry.isFile()) {
      const handle = await open(target, "r");
      const magic = Buffer.alloc(4);
      await handle.read(magic, 0, 4, 0);
      await handle.close();
      if (
        ["cffaedfe", "cefaedfe", "cafebabe", "bebafeca"].includes(
          magic.toString("hex"),
        )
      )
        nativeFiles.push(target);
    }
  }
}
await visit(resources);
for (const path of nativeFiles) {
  const args = ["--force", "--sign", identity, "--options", "runtime"];
  if (path === join(resources, "runtime/bin/node"))
    args.push("--entitlements", entitlements);
  run("codesign", [...args, path]);
}
// The standard build uses envault's existing Keychain implementation and is
// portable across Macs. Shared Data Protection access is an optional capability
// that requires an Apple profile covering every deployment device.
const sharedKeychain = process.argv.includes("--shared-keychain");
const appEntitlements = join(output, "app-entitlements.plist");
if (sharedKeychain) {
  // A development profile authorizes Data Protection Keychain access on this Mac.
  // Reuse the installed wildcard profile, never the helper executable or credentials.
  const argument = (name) => {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    if (!process.argv[index + 1]) throw new Error(`Missing value for ${name}.`);
    return resolve(process.argv[index + 1]);
  };
  const requestedProfile = argument("--profile");
  const profileCandidates = requestedProfile
    ? [requestedProfile]
    : [join(output, "all-macs.provisionprofile")];

  for (const directory of [
    join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles"),
    join(homedir(), "Library/MobileDevice/Provisioning Profiles"),
  ]) {
    try {
      for (const name of await readdir(directory))
        if (/\.(provisionprofile|mobileprovision)$/.test(name))
          if (!requestedProfile) profileCandidates.push(join(directory, name));
    } catch {
      /* Some Xcode installations have only one profile directory. */
    }
  }
  if (!requestedProfile)
    profileCandidates.push(
      join(
        homedir(),
        "Applications/Codex Keychain Helper.app/Contents/embedded.provisionprofile",
      ),
    );
  const profiles = [];
  for (const candidate of profileCandidates) {
    try {
      const xml = run("security", ["cms", "-D", "-i", candidate]);
      const extract = (key, format) =>
        run("plutil", ["-extract", key, format, "-o", "-", "--", "-"], {
          input: xml,
        });
      const ent = JSON.parse(
        run("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
          input: extract("Entitlements", "xml1"),
        }),
      );
      const deviceXML = extract("ProvisionedDevices", "xml1");
      const devices = [...deviceXML.matchAll(/<string>([^<]+)<\/string>/g)].map(
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
      profiles.push({
        path: candidate,
        applicationIdentifier: ent["com.apple.application-identifier"],
        keychainGroups: ent["keychain-access-groups"] ?? [],
        expiresAt: extract("ExpirationDate", "raw").trim(),
        devices,
        allDevices: /<key>ProvisionsAllDevices<\/key>\s*<true\s*\/>/.test(xml),
        certificateSha1s: certificates,
      });
    } catch {
      /* Ignore invalid or unrelated profiles. */
    }
  }
  const currentDevice = run("ioreg", [
    "-rd1",
    "-c",
    "IOPlatformExpertDevice",
  ]).match(/"IOPlatformUUID" = "([^"]+)"/)?.[1];
  if (!currentDevice)
    throw new Error(
      "Could not identify this Mac for provisioning verification.",
    );
  const requiredDevices = [currentDevice];
  const explicitDevicesFile = argument("--devices-file");
  const deploymentInventory = join(output, "deployment-devices.json");
  let targets = [];
  try {
    targets = JSON.parse(
      await readFile(explicitDevicesFile ?? deploymentInventory, "utf8"),
    );
  } catch (error) {
    if (explicitDevicesFile || error.code !== "ENOENT") throw error;
  }
  for (const target of targets) {
    if (!target.udid)
      throw new Error("Every target Mac must have a known hardware UUID.");
    requiredDevices.push(target.udid);
  }
  const { selectProfile } = await import("../../dist/scripts/macos/profile.js");
  const profile = selectProfile(profiles, requiredDevices, certificateSha1);
  if (!profile)
    throw new Error(
      "No valid provisioning profile covers every target Mac, the required signing certificate, and the app's Keychain groups. Download an updated profile and pass --profile <path> with --devices-file <inventory.json>.",
    );
  await cp(profile.path, join(contents, "embedded.provisionprofile"));
  if (explicitDevicesFile)
    await writeFile(
      deploymentInventory,
      JSON.stringify(targets, null, 2) + "\n",
    );
  const cachedProfile = join(output, "all-macs.provisionprofile");
  if (requestedProfile && resolve(profile.path) !== cachedProfile)
    await cp(profile.path, cachedProfile);
  console.log(
    `Verified provisioning coverage for ${new Set(requiredDevices).size} target Mac(s); profile covers ${profile.devices.length} Mac(s).`,
  );
  await writeFile(
    appEntitlements,
    `<?xml version="1.0"?><plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>H82Z395PDV.${identifier}</string>
<key>com.apple.developer.team-identifier</key><string>H82Z395PDV</string>
<key>keychain-access-groups</key><array>
<string>H82Z395PDV.${identifier}</string>
<string>H82Z395PDV.com.tonyxiao.codex-keychain-helper</string>
</array></dict></plist>`,
  );
} else {
  await writeFile(
    appEntitlements,
    '<?xml version="1.0"?><plist version="1.0"><dict/></plist>',
  );
}
run("codesign", [
  "--force",
  "--sign",
  identity,
  "--options",
  "runtime",
  "--identifier",
  identifier,
  "--entitlements",
  appEntitlements,
  bundle,
]);
// Verify the explicit identity certificate, designated requirement and hardened runtime.
run("codesign", ["--verify", "--deep", "--strict", bundle]);
run("codesign", [
  "--verify",
  "-R",
  `=identifier "${identifier}" and anchor apple generic and certificate leaf[subject.CN] = "${identity}"`,
  bundle,
]);
for (const path of nativeFiles) run("codesign", ["--verify", "--strict", path]);
if (process.argv.includes("--install")) {
  const destination = join(homedir(), "Applications/Better Env Vault.app");
  await mkdir(join(homedir(), "Applications"), { recursive: true });
  // Preserve any existing installation until the new signed build has passed verification.
  const staging = join(
    homedir(),
    "Applications/Better Env Vault.installing.app",
  );
  await rm(staging, { recursive: true, force: true });
  run("/usr/bin/ditto", [bundle, staging]);
  run("codesign", ["--verify", "--deep", "--strict", staging]);
  await rm(destination, { recursive: true, force: true });
  run("mv", [staging, destination]);
  run("codesign", ["--verify", "--deep", "--strict", destination]);
  console.log(`Installed signed app: ${destination}`);
} else console.log(`Built signed app: ${bundle}`);
