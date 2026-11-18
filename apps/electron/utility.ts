import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { safeError } from "../../packages/core/src/errors.js";
import { storeServiceAccountToken } from "../../packages/core/src/keychain.js";
import { startServer } from "../web/src/server.js";
import {
  appConfiguration,
  needsServiceAccountSetup,
  type AppConfiguration,
} from "../macos/configuration.js";
import { appSources, sourceId } from "../macos/sources.js";

type ParentPort = {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort })
  .parentPort;
if (!parentPort)
  throw new Error("Electron utility process requires a parent port.");
if (process.argv.includes("--block"))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);

let server: Awaited<ReturnType<typeof startServer>> | undefined;
let config: AppConfiguration | undefined;
let awaitingToken = false;
let awaitingDesktopAccount = false;
let stopping = false;
let pending = Promise.resolve();

function send(record: Record<string, unknown>) {
  parentPort!.postMessage(record);
}

async function verifyDesktopLibrary() {
  if (process.platform !== "darwin") return true;
  const relative =
    "1Password.app/Contents/Frameworks/libop_sdk_ipc_client.dylib";
  for (const path of [
    join("/Applications", relative),
    join(homedir(), "Applications", relative),
  ]) {
    try {
      await access(path);
    } catch {
      continue;
    }
    await promisify(execFile)(
      "/usr/bin/codesign",
      [
        "--verify",
        "--strict",
        "-R",
        '=anchor apple generic and certificate leaf[subject.OU] = "2BUA8C4S2C"',
        path,
      ],
      { timeout: 10_000, maxBuffer: 4096 },
    );
    return true;
  }
  return false;
}

function sourceRecord() {
  return {
    selectedSource: sourceId(config!),
    sources: appSources(config!, config!.sourceNames ?? [], []),
  };
}

function requestToken(error = false) {
  awaitingToken = true;
  send({ setupRequired: true, error, ...sourceRecord() });
}

async function start() {
  if (
    config!.discovery?.auth === "desktop" &&
    !(await verifyDesktopLibrary())
  ) {
    send({ desktopAppRequired: true, ...sourceRecord() });
    return;
  }
  server = await startServer({ ...config!, port: 0 });
  if (stopping) {
    await server.close();
    return;
  }
  send({
    url: server.url,
    launchUrl: server.launchUrl,
    ...sourceRecord(),
  });
}

async function begin(input: AppConfiguration) {
  config = await appConfiguration(input);
  const setupRequired = await needsServiceAccountSetup(config);
  if (setupRequired) requestToken();
  else if (
    !config.schemas.length &&
    config.discovery?.auth === "desktop" &&
    !config.discovery.account &&
    !process.env.OP_ACCOUNT
  ) {
    awaitingDesktopAccount = true;
    send({ desktopAccountRequired: true, ...sourceRecord() });
  } else await start();
}

async function receive(message: unknown) {
  if (!message || typeof message !== "object" || stopping) return;
  const data = message as Record<string, unknown>;
  if (data.type === "start" && !config) {
    await begin(data.config as AppConfiguration);
    return;
  }
  if (data.type === "desktop-account" && awaitingDesktopAccount) {
    const account = data.account;
    if (
      typeof account !== "string" ||
      !account.trim() ||
      account.length > 128 ||
      /[\r\n\0]/.test(account) ||
      account.startsWith("ops_") ||
      account.startsWith("A3-")
    )
      throw new Error("Invalid desktop account.");
    config!.discovery = { auth: "desktop", account: account.trim() };
    config!.desktopAccounts = [
      ...new Set([...(config!.desktopAccounts ?? []), account.trim()]),
    ];
    awaitingDesktopAccount = false;
    await start();
    return;
  }
  if (data.type === "service-token" && awaitingToken) {
    if (typeof data.token !== "string") {
      requestToken(true);
      return;
    }
    try {
      await storeServiceAccountToken(
        config!.discovery!.serviceAccountKeychain!,
        data.token,
      );
    } catch {
      requestToken(true);
      return;
    }
    awaitingToken = false;
    await start();
    return;
  }
  if (data.type === "stop") await stop();
}

async function stop() {
  if (stopping) return;
  stopping = true;
  server?.server.closeAllConnections();
  await server?.close().catch(() => {});
  process.exit(0);
}

parentPort.on("message", (event) => {
  pending = pending
    .then(() => receive(event.data))
    .catch((error) => {
      send({ fatal: true, error: safeError(error) });
    });
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.once(signal, () => void stop());
process.on("uncaughtException", (error) =>
  send({ fatal: true, error: safeError(error) }),
);
process.on("unhandledRejection", (error) =>
  send({ fatal: true, error: safeError(error) }),
);
