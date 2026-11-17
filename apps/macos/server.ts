// Private pipe protocol: one configuration line in, one readiness line out.
// Never send provider errors, request bodies, or vault contents to stdio.
import { createInterface } from "node:readline";
import { startServer } from "../web/src/server.js";
import type { DiscoveryOptions } from "../../packages/core/src/discovery.js";

process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));
const input = createInterface({ input: process.stdin });
let app: Awaited<ReturnType<typeof startServer>> | undefined;
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
// Also cover a forcibly terminated parent whose inherited pipe is still open.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) void stop();
}, 1000).unref();
input.once("line", (line) => {
  void (async () => {
    const config = JSON.parse(line) as {
      schemas: string[];
      discovery?: DiscoveryOptions;
    };
    app = await startServer({ ...config, port: 0 });
    if (stopping) {
      await app.close();
      return;
    }
    process.stdout.write(
      JSON.stringify({ url: app.url, bootstrap: app.bootstrap }) + "\n",
    );
  })().catch(() => process.exit(1));
});
