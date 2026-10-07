import { Command } from "commander";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { startServer } from "../../../apps/web/src/server.js";
import { VaultError } from "../../core/src/errors.js";

export function webOptions(command: Command) {
  return command
    .option(
      "--port <number>",
      "Loopback port (0 chooses an available port)",
      "0",
    )
    .option("--no-open", "Start without opening the browser")
    .option(
      "--print-launch-url",
      "Print a one-time link for connecting a browser manually",
    );
}

export async function serve(options: {
  schemas: string[];
  port: string;
  open: boolean;
  printLaunchUrl?: boolean;
}) {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new VaultError("Invalid port.");
  const app = await startServer({ schemas: options.schemas, port });
  let input: Interface | undefined;
  let stopping = false;
  const browsers = new Set<ChildProcess>();
  // The server lives in this process. Stopping the CLI closes its connections,
  // including requests waiting for desktop authorization, then exits.
  async function stop() {
    if (stopping) return;
    stopping = true;
    input?.close();
    for (const browser of browsers) browser.kill();
    app.server.closeAllConnections();
    try {
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => void stop());

  process.stdout.write(`Better Env Vault is running at ${app.url}\n`);
  process.stdout.write("Press Ctrl+C to stop the server.\n");
  function openBrowser(launchUrl: string) {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    const browser = spawn(command, [launchUrl], { stdio: "ignore" });
    browsers.add(browser);
    browser.once("exit", (code) => {
      browsers.delete(browser);
      if (code !== 0 && !stopping) browserFailure();
    });
    browser.once("error", () => {
      browsers.delete(browser);
      browserFailure();
    });
  }
  function browserFailure() {
    process.stderr.write(
      "Could not open the browser. Type link in this terminal, or restart with --no-open --print-launch-url.\n",
    );
  }
  if (options.open) openBrowser(app.launchUrl);
  if (options.printLaunchUrl) process.stdout.write(app.issueLaunchUrl() + "\n");
  if (process.stdin.isTTY) {
    process.stdout.write(
      "Type open to open another browser, or link to get a fresh one-time browser link.\n",
    );
    input = createInterface({ input: process.stdin });
    input.on("line", (line) => {
      if (line.trim() === "open") openBrowser(app.issueLaunchUrl());
      if (line.trim() === "link")
        process.stdout.write(app.issueLaunchUrl() + "\n");
    });
  } else if (!options.open && !options.printLaunchUrl)
    process.stderr.write(
      "Use --print-launch-url to connect a browser when automatic opening is disabled.\n",
    );
}
