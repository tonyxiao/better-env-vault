import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const executableArgument = process.argv
  .find((value) => value.startsWith("--executable="))
  ?.slice("--executable=".length);
const electron = executableArgument
  ? resolve(executableArgument)
  : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const entry = executableArgument
  ? undefined
  : resolve("apps/electron-prototype");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForExit(pid) {
  const deadline = Date.now() + 5_000;
  while (alive(pid) && Date.now() < deadline) await delay(50);
  return !alive(pid);
}

async function lifecycle(mode) {
  const directory = await mkdtemp(join(tmpdir(), "bev-electron-"));
  const status = join(directory, "status.json");
  const args = [
    ...(entry ? [entry] : []),
    `--lifecycle-test=${mode}`,
    `--status-file=${status}`,
  ];
  const main = spawn(electron, args, {
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== "ELECTRON_RUN_AS_NODE",
      ),
    ),
    stdio: "ignore",
  });
  try {
    const record = await waitForFile(status);
    if (mode === "forced") process.kill(record.mainPid, "SIGKILL");
    if (!(await waitForExit(record.utilityPid)))
      throw new Error(
        `${mode} exit orphaned utility process ${record.utilityPid}`,
      );
    return { mode, utilityPid: record.utilityPid, closed: true };
  } finally {
    if (alive(main.pid)) main.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

const results = [await lifecycle("normal"), await lifecycle("forced")];
console.log(JSON.stringify(results));
