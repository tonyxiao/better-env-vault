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
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) void stop();
}, 1000).unref();
function setup(error = false) {
  awaitingToken = true;
  process.stdout.write(JSON.stringify({ setupRequired: true, error }) + "\n");
}
async function start() {
  app = await startServer({ ...config!, port: 0 });
  if (stopping) {
    await app.close();
    return;
  }
  process.stdout.write(
    JSON.stringify({ url: app.url, bootstrap: app.bootstrap }) + "\n",
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
        else await start();
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
