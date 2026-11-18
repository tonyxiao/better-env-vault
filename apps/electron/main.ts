import electron from "electron";
import type {
  BrowserWindow as BrowserWindowType,
  MenuItemConstructorOptions,
  UtilityProcess,
} from "electron";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfiguration } from "../macos/configuration.js";
import type { AppSource } from "../macos/sources.js";

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  session,
  utilityProcess,
} = electron;
const runtimeDirectory = dirname(fileURLToPath(import.meta.url));
const transientData = mkdtempSync(join(tmpdir(), "better-env-vault-electron-"));
app.setName("Better Env Vault");
app.setPath("userData", transientData);
app.commandLine.appendSwitch("disable-http-cache");

interface Settings {
  sourceNames: string[];
  desktopAccounts: string[];
  selectedSource?: string;
}
interface ReadyRecord {
  url?: string;
  launchUrl?: string;
  selectedSource?: string;
  sources?: AppSource[];
  desktopAccountRequired?: boolean;
  desktopAppRequired?: boolean;
  fatal?: boolean;
  error?: string;
  sharedCredentialAvailable?: boolean;
  sharedCredentialError?: string;
}
interface Workspace {
  key: string;
  source?: AppSource;
  utility: UtilityProcess;
  window: BrowserWindowType;
  ready: boolean;
  parkedAt: number;
  sharedCredentialAvailable?: boolean;
  sharedCredentialError?: string;
}

const argument = (name: string, values = process.argv) => {
  const equals = values.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = values.indexOf(`--${name}`);
  return index >= 0 ? values[index + 1] : undefined;
};
const argumentsFor = (name: string, values = process.argv) => {
  const output: string[] = [];
  for (let index = 0; index < values.length; index++)
    if (values[index] === `--${name}` && values[index + 1])
      output.push(values[++index]);
  return output;
};

const verifyStatus = argument("verify-status");
const verifySource = argument("verify-source");
const lifecycleStatus = argument("lifecycle-status");
const settingsDirectory = join(app.getPath("appData"), "Better Env Vault");
const settingsPath = join(settingsDirectory, "settings.json");
let settings: Settings = {
  sourceNames: [],
  desktopAccounts: [],
};
let current: Workspace | undefined;
let quitting = false;
let promptWindow: BrowserWindowType | undefined;
const warm = new Map<string, Workspace>();
const sources = new Map<string, AppSource>();

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    value.length <= 128 &&
    !/[\r\n\0]/.test(value) &&
    !value.startsWith("ops_") &&
    !value.startsWith("A3-")
  );
}

function loadSettings() {
  try {
    const value = JSON.parse(
      readFileSync(settingsPath, "utf8"),
    ) as Partial<Settings>;
    settings = {
      // Electron uses the one canonical op-agent Data Protection item.
      sourceNames: [],
      desktopAccounts: [
        ...new Set(
          (Array.isArray(value.desktopAccounts)
            ? value.desktopAccounts
            : []
          ).filter(validName),
        ),
      ],
      selectedSource:
        typeof value.selectedSource === "string"
          ? value.selectedSource
          : undefined,
    };
  } catch {
    /* First launch has no metadata file. */
  }
}

function saveSettings() {
  mkdirSync(settingsDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  renameSync(temporary, settingsPath);
}

function writeVerification(status: string, detail?: string) {
  if (!verifyStatus) return;
  writeFileSync(
    verifyStatus,
    JSON.stringify({
      status,
      detail,
      mainPid: process.pid,
      utilityPids: [...warm.values()].map((workspace) => workspace.utility.pid),
      selectedSource: current?.source?.id,
      sharedCredentialAvailable: current?.sharedCredentialAvailable,
      sharedCredentialError: current?.sharedCredentialError,
    }),
    { mode: 0o600 },
  );
}

function configFor(source?: string): AppConfiguration {
  const schemas = argumentsFor("schema");
  const base = {
    schemas,
    sourceNames: settings.sourceNames,
    desktopAccounts: settings.desktopAccounts,
  } satisfies AppConfiguration;
  if (schemas.length) return base;
  if (source?.startsWith("service:")) {
    return {
      ...base,
      discovery: { auth: "service-account" },
    };
  }
  if (source?.startsWith("desktop:")) {
    const account = source.slice("desktop:".length);
    return {
      ...base,
      discovery: {
        auth: "desktop",
        ...(account !== "auto" ? { account } : {}),
      },
    };
  }
  const auth = argument("auth");
  const account = argument("account");
  return {
    ...base,
    discovery:
      auth || account
        ? {
            auth: auth === "service-account" ? "service-account" : "desktop",
            ...(account ? { account } : {}),
          }
        : undefined,
  };
}

function loadingPage(message = "Connecting to 1Password…") {
  return `data:text/html,${encodeURIComponent(`<!doctype html><meta name="color-scheme" content="light dark"><style>body{margin:0;display:grid;place-items:center;height:100vh;font:15px system-ui;background:Canvas;color:CanvasText}p{opacity:.7}</style><p>${message}</p>`)}`;
}

function createWindow(show: boolean) {
  const isolatedSession = session.fromPartition(`bev-${randomUUID()}`, {
    cache: false,
  });
  isolatedSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show,
    title: "Better Env Vault",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
    webPreferences: {
      preload: join(app.getAppPath(), "apps/electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: isolatedSession,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (
      !url.startsWith("http://127.0.0.1:") &&
      !url.startsWith("data:text/html")
    )
      event.preventDefault();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  void window.loadURL(loadingPage());
  return window;
}

async function input(options: {
  title: string;
  message: string;
  secret?: boolean;
  value?: string;
}): Promise<string | undefined> {
  if (verifyStatus) return undefined;
  if (promptWindow) {
    promptWindow.focus();
    return undefined;
  }
  const parent = current?.window;
  const window = new BrowserWindow({
    parent,
    modal: !!parent,
    width: 470,
    height: 245,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: options.title,
    webPreferences: {
      preload: join(app.getAppPath(), "apps/electron/prompt-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  promptWindow = window;
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("prompt:submit", submit);
      ipcMain.removeListener("prompt:cancel", cancel);
      promptWindow = undefined;
      if (!window.isDestroyed()) window.destroy();
      resolve(value);
    };
    const submit = (event: Electron.IpcMainEvent, value: unknown) => {
      if (event.sender === window.webContents && typeof value === "string")
        finish(value);
    };
    const cancel = (event: Electron.IpcMainEvent) => {
      if (event.sender === window.webContents) finish();
    };
    ipcMain.on("prompt:submit", submit);
    ipcMain.on("prompt:cancel", cancel);
    window.once("closed", () => finish());
    window.once("ready-to-show", () => window.show());
    void window.loadFile(join(app.getAppPath(), "apps/electron/prompt.html"), {
      query: {
        title: options.title,
        message: options.message,
        secret: options.secret ? "1" : "0",
        value: options.value ?? "",
      },
    });
  });
}

function mergeSources(records: AppSource[]) {
  for (const source of records) sources.set(source.id, source);
  rebuildMenu();
}

function sendSource(workspace: Workspace) {
  if (!workspace.window.isDestroyed())
    workspace.window.webContents.send(
      "shell:source",
      workspace.source?.label ?? "Source",
    );
}

async function waitForWorkspace(workspace: Workspace) {
  try {
    const result = (await workspace.window.webContents
      .executeJavaScript(`new Promise((resolve) => {
      const deadline = Date.now() + 60000;
      const check = () => {
        const text = document.body?.innerText || '';
        if (document.querySelector('.matrix-panel, .vault-grid') || text.includes('No accessible vaults')) resolve({ok:true});
        else if (text.includes('could not') || text.includes('failed') || text.includes('denied')) resolve({ok:false});
        else if (Date.now() > deadline) resolve({ok:false});
        else setTimeout(check, 100);
      }; check();
    })`)) as { ok?: boolean };
    if (!result.ok) throw new Error("inventory");
    writeVerification("ok");
  } catch {
    writeVerification("failed", "inventory");
  } finally {
    if (verifyStatus) app.quit();
  }
}

async function handleRecord(workspace: Workspace, value: unknown) {
  if (!value || typeof value !== "object") return;
  const record = value as ReadyRecord;
  if (record.sharedCredentialAvailable !== undefined)
    workspace.sharedCredentialAvailable = record.sharedCredentialAvailable;
  if (record.sharedCredentialError)
    workspace.sharedCredentialError = record.sharedCredentialError;
  if (record.sources) mergeSources(record.sources);
  if (record.selectedSource) {
    const previousKey = workspace.key;
    workspace.key = record.selectedSource;
    workspace.source = sources.get(record.selectedSource);
    if (previousKey !== workspace.key) {
      warm.delete(previousKey);
      warm.set(workspace.key, workspace);
    }
    if (workspace === current) {
      settings.selectedSource = workspace.key;
      saveSettings();
      sendSource(workspace);
    }
  }
  if (record.desktopAppRequired) {
    failWorkspace(
      workspace,
      "Install and unlock 1Password, then enable SDK integration in Settings → Developer.",
    );
    return;
  }
  if (record.desktopAccountRequired) {
    const account = await input({
      title: "Connect 1Password",
      message:
        "Enter the account name shown at the top of the 1Password sidebar.",
      value: settings.desktopAccounts[0] ?? "Xiao",
    });
    if (!validName(account)) {
      failWorkspace(workspace, "A 1Password desktop account name is required.");
      return;
    }
    settings.desktopAccounts = [
      ...new Set([...settings.desktopAccounts, account.trim()]),
    ];
    saveSettings();
    workspace.utility.postMessage({
      type: "desktop-account",
      account: account.trim(),
    });
    return;
  }
  if (record.fatal) {
    failWorkspace(
      workspace,
      record.error || "The local 1Password process stopped.",
    );
    return;
  }
  if (record.launchUrl && record.url) {
    workspace.ready = true;
    workspace.window.webContents.once("did-finish-load", () => {
      sendSource(workspace);
      if (verifyStatus) void waitForWorkspace(workspace);
    });
    await workspace.window.loadURL(record.launchUrl);
    if (workspace === current) workspace.window.show();
  }
}

function failWorkspace(workspace: Workspace, message: string) {
  void workspace.window.loadURL(loadingPage(message));
  writeVerification("failed", "startup");
  if (verifyStatus) setTimeout(() => app.quit(), 50);
}

function dispose(workspace: Workspace) {
  warm.delete(workspace.key);
  workspace.utility.postMessage({ type: "stop" });
  setTimeout(() => workspace.utility.kill(), 1_000).unref();
  if (!workspace.window.isDestroyed()) workspace.window.destroy();
}

function enforceWarmLimit() {
  const parked = [...warm.values()]
    .filter((workspace) => workspace !== current)
    .sort((left, right) => left.parkedAt - right.parkedAt);
  while (warm.size > 4 && parked.length) dispose(parked.shift()!);
}

function startWorkspace(source?: string) {
  const key = source ?? `launch:${randomUUID()}`;
  const window = createWindow(!current);
  const utility = utilityProcess.fork(
    join(runtimeDirectory, "utility.js"),
    [],
    {
      serviceName: "Better Env Vault 1Password",
      stdio: "ignore",
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name, value]) =>
            value !== undefined &&
            ["HOME", "PATH", "LANG", "OP_ACCOUNT"].includes(name),
        ) as [string, string][],
      ),
    },
  );
  const workspace: Workspace = {
    key,
    source: sources.get(source ?? ""),
    utility,
    window,
    ready: false,
    parkedAt: Date.now(),
  };
  warm.set(key, workspace);
  utility.on("message", (record) => void handleRecord(workspace, record));
  utility.on("exit", () => {
    if (!quitting && warm.has(workspace.key))
      failWorkspace(workspace, "The local 1Password process stopped.");
  });
  utility.once("spawn", () =>
    utility.postMessage({
      type: "start",
      config: configFor(source),
    }),
  );
  return workspace;
}

async function canSwitch() {
  if (!current?.ready) return true;
  const state = Number(
    await current.window.webContents
      .executeJavaScript("window.__bevNavigationState?.() ?? 0")
      .catch(() => 0),
  );
  if (state >= 2) {
    await dialog.showMessageBox(current.window, {
      type: "info",
      message: "A save is still in progress.",
      detail: "Wait for the save to finish before switching sources.",
    });
    return false;
  }
  if (state === 1) {
    const answer = await dialog.showMessageBox(current.window, {
      type: "warning",
      message: "Discard unsaved drafts?",
      detail: "Switching sources will discard drafts that have not been saved.",
      buttons: ["Cancel", "Discard and Switch"],
      defaultId: 0,
      cancelId: 0,
    });
    return answer.response === 1;
  }
  return true;
}

async function selectSource(id: string) {
  if (current?.key === id) return;
  if (!(await canSwitch())) return;
  const previous = current;
  let target = warm.get(id);
  if (!target) target = startWorkspace(id);
  current = target;
  settings.selectedSource = id;
  saveSettings();
  previous?.window.hide();
  previous && (previous.parkedAt = Date.now());
  target.window.show();
  target.window.focus();
  sendSource(target);
  if (target.ready && Date.now() - target.parkedAt > 30_000)
    void target.window.webContents.executeJavaScript(
      "window.dispatchEvent(new Event('bev-refresh'))",
    );
  enforceWarmLimit();
  rebuildMenu();
}

async function addDesktopAccount() {
  const account = await input({
    title: "Add Desktop Account",
    message:
      "Enter the account name shown at the top of the 1Password sidebar.",
    value: settings.desktopAccounts[0] ?? "Xiao",
  });
  if (!validName(account)) return;
  settings.desktopAccounts = [
    ...new Set([...settings.desktopAccounts, account.trim()]),
  ];
  saveSettings();
  const id = `desktop:${account.trim()}`;
  sources.set(id, {
    id,
    label: `Desktop · ${account.trim()}`,
    schemas: [],
    discovery: { auth: "desktop", account: account.trim() },
  });
  await selectSource(id);
}

function sourceMenu(): MenuItemConstructorOptions[] {
  const choices = [...sources.values()];
  return [
    ...choices.map((source, index) => ({
      label: source.label,
      type: "radio" as const,
      checked: current?.key === source.id,
      accelerator: index < 9 ? `CmdOrCtrl+${index + 1}` : undefined,
      click: () => void selectSource(source.id),
    })),
    { type: "separator" as const },
    { label: "Add Desktop Account…", click: () => void addDesktopAccount() },
  ];
}

function rebuildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: "File", submenu: [{ role: "close" }] },
    { label: "Accounts", submenu: sourceMenu() },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Refresh",
          accelerator: "CmdOrCtrl+R",
          click: () =>
            current?.window.webContents.executeJavaScript(
              "window.dispatchEvent(new Event('bev-refresh'))",
            ),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.on("shell:source-menu", (event) => {
  if (event.sender !== current?.window.webContents) return;
  Menu.buildFromTemplate(sourceMenu()).popup({ window: current.window });
});

function initialSource() {
  if (verifySource) return verifySource;
  if (argumentsFor("schema").length) return "schemas";
  const auth = argument("auth");
  if (auth === "desktop") return `desktop:${argument("account") ?? "auto"}`;
  if (auth === "service-account") return "service:op-agent";
  return settings.selectedSource?.startsWith("service:")
    ? "service:op-agent"
    : settings.selectedSource;
}

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", (_event, values) => {
    const auth = argument("auth", values);
    const account = argument("account", values);
    if (auth === "desktop") void selectSource(`desktop:${account ?? "auto"}`);
    else current?.window.show();
  });
  app.on("activate", () => {
    current?.window.show();
    current?.window.focus();
  });
  app.on("before-quit", () => {
    quitting = true;
    for (const workspace of warm.values())
      workspace.utility.postMessage({ type: "stop" });
  });
  app.on("will-quit", () => {
    for (const workspace of warm.values()) if (workspace.utility.kill()) void 0;
    try {
      rmSync(transientData, { recursive: true, force: true });
    } catch {
      /* OS temporary storage will be reclaimed. */
    }
  });
  void app.whenReady().then(async () => {
    if (lifecycleStatus) {
      const utility = utilityProcess.fork(
        join(runtimeDirectory, "utility.js"),
        ["--block"],
        {
          serviceName: "Better Env Vault blocked lifecycle probe",
          stdio: "ignore",
        },
      );
      utility.once("spawn", () =>
        writeFileSync(
          lifecycleStatus,
          JSON.stringify({ mainPid: process.pid, utilityPid: utility.pid }),
          { mode: 0o600 },
        ),
      );
      return;
    }
    loadSettings();
    current = startWorkspace(initialSource());
    rebuildMenu();
  });
}
