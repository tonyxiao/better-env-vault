import electron from "electron";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { app, BrowserWindow, ipcMain, utilityProcess } = electron;
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const lifecycleTest = argument("lifecycle-test");
const statusFile = argument("status-file");
const sdkAccount = argument("sdk-account");
let worker;

function spawnUtility(mode, account) {
  const child = utilityProcess.fork(
    join(here, "utility.mjs"),
    [mode, account ?? ""],
    {
      serviceName: "Better Env Vault 1Password",
      stdio: "pipe",
    },
  );
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  return child;
}

async function lifecycleProbe() {
  await writeFile(
    statusFile,
    JSON.stringify({ stage: "starting", mainPid: process.pid }),
    {
      mode: 0o600,
    },
  );
  worker = spawnUtility("block");
  worker.on("error", async (type, location) => {
    await writeFile(
      statusFile,
      JSON.stringify({ stage: "error", type, location }),
      {
        mode: 0o600,
      },
    );
  });
  worker.on("exit", async (code) => {
    if (lifecycleTest !== "normal")
      await writeFile(statusFile, JSON.stringify({ stage: "exit", code }), {
        mode: 0o600,
      });
  });
  worker.once("spawn", async () => {
    await writeFile(
      statusFile,
      JSON.stringify({
        mainPid: process.pid,
        utilityPid: worker.pid,
        mode: lifecycleTest,
      }),
      { mode: 0o600 },
    );
    if (lifecycleTest === "normal") setTimeout(() => app.quit(), 100);
  });
}

async function sdkProbe() {
  worker = spawnUtility("sdk", sdkAccount);
  const timeout = setTimeout(() => {
    worker.kill();
    void writeFile(statusFile, JSON.stringify({ status: "timeout" }), {
      mode: 0o600,
    }).then(() => app.quit());
  }, 20_000);
  worker.on("message", async (message) => {
    clearTimeout(timeout);
    await writeFile(statusFile, JSON.stringify(message), { mode: 0o600 });
    worker.kill();
    app.quit();
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 900,
    height: 640,
    title: "Better Env Vault — Electron Prototype",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(join(here, "renderer.html"));
}

ipcMain.handle("prototype:probe", async (_event, account) => {
  if (worker) worker.kill();
  worker = spawnUtility("sdk", typeof account === "string" ? account : "");
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.kill();
      resolve({ status: "timeout" });
    }, 20_000);
    worker.on("message", (message) => {
      clearTimeout(timeout);
      worker.kill();
      resolve(message);
    });
  });
});

app.on("window-all-closed", () => app.quit());
void app.whenReady().then(async () => {
  if (lifecycleTest && statusFile) await lifecycleProbe();
  else if (sdkAccount && statusFile) await sdkProbe();
  else createWindow();
});
