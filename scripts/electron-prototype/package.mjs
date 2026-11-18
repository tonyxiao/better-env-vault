import { packager } from "@electron/packager";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve("tmp/electron-prototype");
const stage = resolve(root, "stage");
const output = resolve(root, "out");
const appName = "Better Env Vault Electron Prototype";
const identity = "Apple Development: Tony Xiao (9QULCFJ59K)";
const baseEntitlements = resolve("apps/electron-prototype/entitlements.plist");
const utilityEntitlements = resolve(
  "apps/electron-prototype/entitlements-utility.plist",
);

await rm(root, { recursive: true, force: true });
await mkdir(resolve(stage, "node_modules/@1password"), { recursive: true });
for (const file of ["main.mjs", "preload.cjs", "renderer.html", "utility.mjs"])
  await cp(resolve("apps/electron-prototype", file), resolve(stage, file));
for (const dependency of ["sdk", "sdk-core"])
  await cp(
    resolve("node_modules/@1password", dependency),
    resolve(stage, "node_modules/@1password", dependency),
    { recursive: true },
  );
await writeFile(
  resolve(stage, "package.json"),
  JSON.stringify({
    name: "better-env-vault-electron-prototype",
    productName: appName,
    version: "0.1.0",
    private: true,
    type: "module",
    main: "main.mjs",
  }),
);

const [directory] = await packager({
  dir: stage,
  out: output,
  overwrite: true,
  prune: false,
  platform: "darwin",
  arch: process.arch,
  electronVersion: "45.3.4",
  name: appName,
  appBundleId: "com.txlforge.better-env-vault",
  osxSign: {
    identity,
    type: "development",
    batchCodesignCalls: true,
    hardenedRuntime: true,
    entitlements: baseEntitlements,
    preAutoEntitlements: false,
    optionsForFile(filePath) {
      if (/ Helper\.app$/.test(filePath))
        return { entitlements: utilityEntitlements };
      return null;
    },
  },
});
const app = resolve(directory, `${appName}.app`);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
  stdio: "inherit",
});
console.log(app);
