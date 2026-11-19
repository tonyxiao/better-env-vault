import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";

const bundle = join(homedir(), "Applications/Better Env Vault.app");
const executable = join(bundle, "Contents/MacOS/Better Env Vault");
const scratch = resolve("tmp/electron-verify");
await mkdir(scratch, { recursive: true, mode: 0o700 });
const argument = (name) => {
  const equals = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const expectedSource = argument("verify-source");
const requireOpAgentBackend = process.argv.includes(
  "--require-op-agent-backend",
);

function existsProcess(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitForFile(path, timeout = 100_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(path, "utf8");
      if (content) return JSON.parse(content);
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for Electron verification.");
}
async function fresh(name) {
  const path = join(scratch, `${name}-${randomBytes(6).toString("hex")}.json`);
  return path;
}

await access(executable);
execFileSync("codesign", ["--verify", "--deep", "--strict", bundle]);
const statusPath = await fresh("live");
const args = [
  "-n",
  "-W",
  bundle,
  "--args",
  `--verify-status=${statusPath}`,
  ...process.argv.slice(2),
];
const launchEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => name !== "ELECTRON_RUN_AS_NODE",
  ),
);
const opened = spawn("/usr/bin/open", args, {
  env: launchEnvironment,
  stdio: "ignore",
});
await new Promise((resolvePromise, reject) => {
  opened.once("error", reject);
  opened.once("exit", resolvePromise);
});
const result = await waitForFile(statusPath, 2_000);
await unlink(statusPath);
if (result.status !== "ok")
  throw new Error(`Electron inventory verification failed: ${result.detail}`);
if (expectedSource && result.selectedSource !== expectedSource)
  throw new Error(
    `Expected Electron source ${expectedSource}, got ${result.selectedSource ?? "none"}.`,
  );
if (requireOpAgentBackend && result.opAgentBackend !== true)
  throw new Error("Electron did not use the op-agent backend broker.");
for (const pid of result.utilityPids ?? [])
  if (existsProcess(pid))
    throw new Error(`Utility process ${pid} survived normal app quit.`);
for (const pid of result.backendPids ?? [])
  if (existsProcess(pid))
    throw new Error(`Token-bearing backend ${pid} survived normal app quit.`);

const lifecyclePath = await fresh("lifecycle");
const main = spawn(executable, [`--lifecycle-status=${lifecyclePath}`], {
  env: launchEnvironment,
  stdio: "ignore",
});
const lifecycle = await waitForFile(lifecyclePath, 10_000);
process.kill(lifecycle.mainPid, "SIGKILL");
const deadline = Date.now() + 5_000;
while (
  (existsProcess(lifecycle.brokerPid) || existsProcess(lifecycle.backendPid)) &&
  Date.now() < deadline
)
  await delay(50);
await unlink(lifecyclePath);
if (existsProcess(lifecycle.brokerPid))
  throw new Error(
    `op-agent broker ${lifecycle.brokerPid} survived forced main-process death.`,
  );
if (existsProcess(lifecycle.backendPid))
  throw new Error(
    `Token-bearing backend ${lifecycle.backendPid} survived forced main-process death.`,
  );
if (existsProcess(main.pid)) main.kill("SIGKILL");

const settingsDirectory = join(
  homedir(),
  "Library/Application Support/Better Env Vault",
);
const entries = await readdir(settingsDirectory).catch(() => []);
const allowedMetadata = new Set(["settings.json", "desktop-accounts.json"]);
if (entries.some((entry) => !allowedMetadata.has(entry)))
  throw new Error("Unexpected persistent Electron browser storage exists.");

console.log("ELECTRON_SIGNATURE_INVENTORY_LIFECYCLE_AND_STORAGE_OK");
