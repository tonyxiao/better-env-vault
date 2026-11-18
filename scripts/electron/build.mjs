import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
const install = process.argv.includes("--install");

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
  osxSign: {
    identity,
    type: "development",
    continueOnError: false,
    batchCodesignCalls: true,
    hardenedRuntime: true,
    entitlements: baseEntitlements,
    preAutoEntitlements: false,
    optionsForFile(filePath) {
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
