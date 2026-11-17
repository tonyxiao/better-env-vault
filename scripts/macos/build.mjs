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
if (
  !run("security", ["find-identity", "-v", "-p", "codesigning"]).includes(
    `"${identity}"`,
  )
)
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
run("codesign", [
  "--force",
  "--sign",
  identity,
  "--options",
  "runtime",
  "--identifier",
  identifier,
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
