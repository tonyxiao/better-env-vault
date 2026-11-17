import { watchParent } from "./parent-watchdog.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { appSources, sourceId } from "./sources.js";
// Private pipe protocol. Credentials enter only through stdin and native Keychain;
// stdout carries only fixed setup states and the in-memory session handshake.
import { createInterface } from "node:readline";
import { startServer } from "../web/src/server.js";
import { storeServiceAccountToken } from "../../packages/core/src/keychain.js";
import {
  appConfiguration,
  needsServiceAccountSetup,
  type AppConfiguration,
} from "./configuration.js";

process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));
const input = createInterface({ input: process.stdin });
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let config: AppConfiguration | undefined;
let awaitingToken = false;
let awaitingDesktopAccount = false;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  app?.server.closeAllConnections();
  await app?.close();
  process.exit(0);
}
input.on("close", () => void stop());
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.once(signal, () => void stop());
watchParent();

function setup(error = false) {
  awaitingToken = true;
  process.stdout.write(
    JSON.stringify({
      setupRequired: true,
      error,
      ...(config
        ? {
            sources: appSources(config, config.sourceNames ?? [], []),
            selectedSource: sourceId(config),
          }
        : {}),
    }) + "\n",
  );
}
async function verifyDesktopLibrary() {
  // The SDK loads this vendor-signed addon from 1Password itself. Node's
  // library-validation exception is scoped to its runtime, never the native shell.
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
async function start() {
  if (config!.discovery?.auth === "desktop") {
    if (!(await verifyDesktopLibrary())) {
      process.stdout.write(
        JSON.stringify({
          desktopAppRequired: true,
          selectedSource: sourceId(config!),
          sources: appSources(config!, config!.sourceNames ?? [], []),
        }) + "\n",
      );
      return;
    }
  } else if (config!.schemas.length) await verifyDesktopLibrary();
  app = await startServer({ ...config!, port: 0 });
  if (stopping) {
    await app.close();
    return;
  }
  process.stdout.write(
    JSON.stringify({
      url: app.url,
      bootstrap: app.bootstrap,
      selectedSource: sourceId(config!),
      sources: appSources(config!, config!.sourceNames ?? [], []),
    }) + "\n",
  );
}
// Serialize messages so repeated submissions cannot start concurrent servers.
let pending = Promise.resolve();
input.on("line", (line) => {
  if (line.length > 70_000) process.exit(1);
  pending = pending
    .then(async () => {
      if (stopping) return;
      if (!config) {
        config = await appConfiguration(JSON.parse(line) as AppConfiguration);
        if (config.useDataProtectionToken)
          process.env.OP_SERVICE_ACCOUNT_TOKEN =
            process.env.BEV_DATA_PROTECTION_SERVICE_ACCOUNT_TOKEN;
        delete process.env.BEV_DATA_PROTECTION_SERVICE_ACCOUNT_TOKEN;
        if (await needsServiceAccountSetup(config)) setup();
        else if (
          !config.schemas.length &&
          config.discovery?.auth === "desktop" &&
          !config.discovery.account &&
          !process.env.OP_ACCOUNT
        ) {
          awaitingDesktopAccount = true;
          process.stdout.write(
            JSON.stringify({
              desktopAccountRequired: true,
              selectedSource: sourceId(config),
              sources: appSources(config, config.sourceNames ?? [], []),
            }) + "\n",
          );
        } else await start();
      } else if (awaitingDesktopAccount) {
        const data = JSON.parse(line) as { desktopAccount?: unknown };
        const account = data.desktopAccount;
        if (
          typeof account !== "string" ||
          !account.trim() ||
          account.length > 128 ||
          /[\r\n\0]/.test(account) ||
          account.startsWith("ops_") ||
          account.startsWith("A3-")
        )
          process.exit(1);
        config.discovery = { auth: "desktop", account: account.trim() };
        config.desktopAccounts = [
          ...new Set([...(config.desktopAccounts ?? []), account.trim()]),
        ];
        awaitingDesktopAccount = false;
        await start();
      } else if (awaitingToken) {
        const data = JSON.parse(line) as { serviceAccountToken?: unknown };
        if (typeof data.serviceAccountToken !== "string") {
          setup(true);
          return;
        }
        try {
          await storeServiceAccountToken(
            config.discovery!.serviceAccountKeychain!,
            data.serviceAccountToken,
          );
        } catch {
          setup(true);
          return;
        }
        awaitingToken = false;
        await start();
      }
    })
    .catch(() => process.exit(1));
});
