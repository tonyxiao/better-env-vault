// Runs the installed WebKit app. All browser payloads remain inside WebKit.
import { spawn, execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
const child = spawn(
  join(bundle, "Contents/MacOS/BetterEnvVault"),
  ["--verify", ...process.argv.slice(2)],
  {
    stdio: ["ignore", "pipe", "ignore"],
  },
);
let marker = "";
child.stdout.on("data", (data) => {
  if (marker.length < 1024) marker += data.toString();
});
let exitCode;
let ended = false;
child.once("exit", (code) => {
  exitCode = code;
  ended = true;
});
child.once("error", () => {
  ended = true;
  exitCode = 1;
});
const serverPids = new Set();
const ports = new Set();
const deadline = Date.now() + 100_000;
while (!ended && Date.now() < deadline) {
  try {
    const pids = execFileSync("pgrep", ["-P", String(child.pid)], {
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
  child.kill("SIGTERM");
  throw new Error("Installed application verification timed out.");
}
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
if (!ports.size) throw new Error("No embedded loopback listener was observed.");
for (const path of storage)
  if (await exists(path))
    throw new Error("App-specific persistent storage was created.");
console.log(
  ports.size
    ? "SIGNATURE_LOOPBACK_SHUTDOWN_AND_STORAGE_OK"
    : "SIGNATURE_SETUP_SHUTDOWN_AND_STORAGE_OK",
);
if (exitCode === 0 && marker.trim() === "UI_AND_AUTHENTICATED_INVENTORY_OK") {
  console.log("UI_AND_AUTHENTICATED_INVENTORY_OK");
} else {
  // Only permit fixed diagnostic enums, never arbitrary application output.
  const state = marker.match(
    /^APP_VERIFICATION_FAILED: (STARTUP|SERVICE_ACCOUNT_REQUIRED|SESSION_UNAVAILABLE|INVENTORY_UNAVAILABLE|INVENTORY_EMPTY|UI_UNAVAILABLE|REQUEST_FAILED|JAVASCRIPT_FAILED)\s*$/,
  )?.[1];
  console.log(`APP_VERIFICATION_FAILED: ${state ?? "UNAVAILABLE"}`);
  process.exitCode = 1;
}
