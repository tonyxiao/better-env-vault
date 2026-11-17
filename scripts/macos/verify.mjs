// Runs the installed WebKit app. All browser payloads remain inside WebKit.
import { spawn, execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const bundle = join(homedir(), "Applications/Better Env Vault.app");
const identifier = "com.txlforge.better-env-vault";
const storage = [
  `WebKit/${identifier}`,
  `HTTPStorages/${identifier}`,
  `Caches/${identifier}`,
  `Saved Application State/${identifier}.savedState`,
  `Containers/${identifier}`,
  `Preferences/${identifier}.plist`,
].map((path) => join(homedir(), "Library", path));
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
for (const path of storage)
  if (await exists(path))
    throw new Error(
      "App storage exists before verification; review it before running the privacy check.",
    );
execFileSync("codesign", ["--verify", "--deep", "--strict", bundle], {
  stdio: "ignore",
});
// LaunchServices provides the real GUI security session. Direct execution over
// SSH can be denied access to the user's login keychain despite a working GUI.
// The status artifact contains only fixed enums and a PID, never browser data.
const statusDirectory = resolve("tmp/macos");
await mkdir(statusDirectory, { recursive: true, mode: 0o700 });
const statusPath = join(
  statusDirectory,
  `verify-${randomBytes(6).toString("hex")}.status`,
);
await writeFile(statusPath, "", { mode: 0o600 });
// Local inherited-session verification uses the same GUI user's security context.
// op-agent supplies the token in memory; never put it in launch arguments/files.
const inheritedSession = process.argv.includes("--inherited-session");
if (inheritedSession && !process.env.OP_SERVICE_ACCOUNT_TOKEN)
  throw new Error("Inherited-session verification requires op-agent run.");
const args = process.argv
  .slice(2)
  .filter((arg) => arg !== "--inherited-session");
const statusFile = inheritedSession ? await open(statusPath, "w") : undefined;
const child = inheritedSession
  ? spawn(
      join(bundle, "Contents/MacOS/BetterEnvVault"),
      ["--verify", ...args],
      {
        stdio: ["ignore", statusFile.fd, "ignore"],
      },
    )
  : spawn(
      "/usr/bin/open",
      [
        "-n",
        "-W",
        "--stdout",
        statusPath,
        "--stderr",
        "/dev/null",
        bundle,
        "--args",
        "--verify",
        ...args,
      ],
      { stdio: "ignore" },
    );
await statusFile?.close();

let marker = "";
let nativePid;
let ended = false;
child.once("exit", () => {
  ended = true;
});
child.once("error", () => {
  ended = true;
});
const serverPids = new Set();
const ports = new Set();
const deadline = Date.now() + 100_000;
while (Date.now() < deadline) {
  marker = (await readFile(statusPath, "utf8")).slice(0, 2048);
  nativePid = marker.match(/^APP_VERIFICATION_PID (\d+)$/m)?.[1];
  if (ended) break;
  if (!nativePid) {
    await delay(200);
    continue;
  }
  try {
    const pids = execFileSync("pgrep", ["-P", nativePid], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\s+/);
    for (const pid of pids) {
      serverPids.add(pid);
      try {
        const listeners = execFileSync(
          "lsof",
          ["-nP", "-a", "-p", pid, "-iTCP", "-sTCP:LISTEN", "-Fn"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        for (const line of listeners
          .split("\n")
          .filter((line) => line.startsWith("n"))) {
          if (!/^n127\.0\.0\.1:\d+$/.test(line))
            throw new Error(
              "Server listener is not restricted to IPv4 loopback.",
            );
          ports.add(Number(line.slice(line.lastIndexOf(":") + 1)));
        }
      } catch (error) {
        if (!error.status) throw error;
      }
    }
  } catch (error) {
    if (!error.status) throw error;
  }
  await delay(200);
}
if (!ended) {
  if (nativePid) {
    try {
      process.kill(Number(nativePid), "SIGTERM");
    } catch {}
  }
  child.kill("SIGTERM");
  await unlink(statusPath).catch(() => {});
  throw new Error("Installed application verification timed out.");
}
marker = (await readFile(statusPath, "utf8"))
  .replace(/^APP_VERIFICATION_PID \d+\s*$/m, "")
  .trim();
await unlink(statusPath);
if (!nativePid)
  throw new Error("The installed app did not start in the GUI session.");
for (const pid of serverPids) {
  let running = false;
  try {
    process.kill(Number(pid), 0);
    running = true;
  } catch {
    /* Reaped. */
  }
  if (running) throw new Error("The embedded server survived app exit.");
}
for (const port of ports) {
  const listening = await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
  if (listening)
    throw new Error("The app loopback port remained open after exit.");
}
if (
  !ports.size &&
  !/^APP_VERIFICATION_FAILED: (SERVICE_ACCOUNT_REQUIRED|DESKTOP_ACCOUNT_REQUIRED)$/.test(
    marker,
  )
)
  throw new Error("No embedded loopback listener was observed.");
for (const path of storage)
  if (await exists(path))
    throw new Error("App-specific persistent storage was created.");
console.log(
  ports.size
    ? "SIGNATURE_LOOPBACK_SHUTDOWN_AND_STORAGE_OK"
    : "SIGNATURE_SETUP_SHUTDOWN_AND_STORAGE_OK",
);
if (
  marker.split("\n").includes("UI_AND_AUTHENTICATED_INVENTORY_OK") &&
  marker
    .split("\n")
    .every((line) =>
      [
        "UI_AND_AUTHENTICATED_INVENTORY_OK",
        "SOURCE_SWITCHING_OK",
        "WARM_WORKSPACE_REUSE_OK",
        "",
      ].includes(line),
    )
) {
  console.log("UI_AND_AUTHENTICATED_INVENTORY_OK");
  if (marker.includes("WARM_WORKSPACE_REUSE_OK"))
    console.log("WARM_WORKSPACE_REUSE_OK");
  if (marker.includes("SOURCE_SWITCHING_OK"))
    console.log("SOURCE_SWITCHING_OK");
} else {
  // Only permit fixed diagnostic enums, never arbitrary application output.
  const state = marker.match(
    /^APP_VERIFICATION_FAILED: (CATALOG_LOADING|CATALOG_UNAVAILABLE|DESKTOP_ACCOUNT_REQUIRED|WARM_REUSE_FAILED|STARTUP|SOURCE_SELECTOR_UNAVAILABLE|SOURCE_SWITCH_FAILED|SERVICE_ACCOUNT_REQUIRED|SESSION_UNAVAILABLE|INVENTORY_UNAVAILABLE|INVENTORY_EMPTY|UI_UNAVAILABLE|REQUEST_FAILED|JAVASCRIPT_FAILED)\s*$/,
  )?.[1];
  console.log(`APP_VERIFICATION_FAILED: ${state ?? "UNAVAILABLE"}`);
  process.exitCode = 1;
}
