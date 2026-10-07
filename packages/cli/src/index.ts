#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  loadSchema,
  selectEnvironment,
  configurationText,
  configSchema,
  environmentChain,
} from "../../core/src/schema.js";
import { OnePasswordProvider } from "../../core/src/provider.js";
import {
  readVaults,
  resolveEnvironment,
  exportValues,
  publicResolution,
} from "../../core/src/resolver.js";
import {
  childEnvironment,
  direnvDump,
  shellExport,
} from "../../core/src/export.js";
import { safeError, VaultError } from "../../core/src/errors.js";
import { startServer } from "../../../apps/web/src/server.js";

const program = new Command()
  .enablePositionalOptions()
  .name("better-env-vault")
  .version("0.1.0")
  .description(
    "Load and edit environments declared in .env.schema using 1Password.",
  );
function common(command: Command) {
  return command
    .option("--schema <path>", "Project schema path", ".env.schema")
    .option("-e, --environment <name>", "Environment declared in the schema");
}
async function resolveCommand(options: {
  schema: string;
  environment?: string;
}) {
  const schema = await loadSchema(options.schema);
  const environment = selectEnvironment(schema, options.environment);
  const provider = await OnePasswordProvider.connect(schema.config);
  const snapshot = await readVaults(
    schema,
    provider,
    environmentChain(schema.config, environment),
  );
  const resolution = await resolveEnvironment(schema, environment, snapshot);
  return { schema, resolution };
}
common(
  program
    .command("export")
    .description("Print a validated shell or direnv payload"),
)
  .option("--format <format>", "shell or direnv", "shell")
  .action(async (options) => {
    if (!["shell", "direnv"].includes(options.format))
      throw new VaultError("Use --format shell or direnv.");
    const { schema, resolution } = await resolveCommand(options);
    const values = exportValues(resolution);
    const declared = schema.parsed.configItems.map((i) => i.key);
    const output =
      options.format === "direnv"
        ? await direnvDump(childEnvironment(values, declared))
        : shellExport(
            values,
            declared.filter((key) => !Object.hasOwn(values, key)),
          );
    process.stdout.write(output);
  });
common(
  program.command("check").description("Validate without revealing values"),
).action(async (options) => {
  const { resolution } = await resolveCommand(options);
  exportValues(resolution);
  process.stdout.write(
    `${resolution.environment}: ${resolution.variables.length} variables validated.\n`,
  );
});
common(
  program
    .command("explain")
    .description("Show provenance without revealing values"),
).action(async (options) => {
  const { resolution } = await resolveCommand(options);
  const safe = publicResolution(resolution);
  process.stdout.write(
    JSON.stringify(
      {
        environment: safe.environment,
        chain: safe.chain,
        valid: safe.valid,
        variables: safe.variables.map(
          ({ value: _value, defaultValue: _default, ...record }) => record,
        ),
        unmanaged: safe.unmanaged,
      },
      null,
      2,
    ) + "\n",
  );
  if (!resolution.valid) process.exitCode = 1;
});
common(
  program
    .command("run")
    .description("Run a child command with validated values")
    .argument("<command...>"),
)
  .passThroughOptions()
  .action(async (args: string[], options) => {
    const { schema, resolution } = await resolveCommand(options);
    const env = childEnvironment(
      exportValues(resolution),
      schema.parsed.configItems.map((i) => i.key),
    );
    const child = spawn(args[0], args.slice(1), { env, stdio: "inherit" });
    const signals = ["SIGINT", "SIGTERM"] as const;
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    const handlers = signals.map((signal) => {
      const handler = () => forward(signal);
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", () =>
        reject(new VaultError("Unable to start the child command.")),
      );
      child.once("exit", (code, signal) => {
        for (const [event, handler] of handlers) process.off(event, handler);
        process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
        resolve();
      });
    });
  });
program
  .command("serve")
  .description("Open the local environment matrix")
  .option("--schema <path...>", "Schema paths available in this session", [
    ".env.schema",
  ])
  .option("--port <number>", "Loopback port (0 chooses an available port)", "0")
  .option("--no-open", "Start without opening the browser")
  .option(
    "--print-launch-url",
    "Print a one-time link for connecting a browser manually",
  )
  .action(async (options) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new VaultError("Invalid port.");
    const app = await startServer({ schemas: options.schema, port });
    process.stdout.write(`Better Env Vault is running at ${app.url}\n`);
    function openBrowser(launchUrl: string) {
      const command =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer"
            : "xdg-open";
      const browser = spawn(command, [launchUrl], { stdio: "ignore" });
      browser.on("error", () =>
        process.stderr.write(
          "Could not open the browser. Type link in this terminal to get a one-time browser link.\n",
        ),
      );
    }
    if (options.open) openBrowser(app.launchUrl);
    if (options.printLaunchUrl)
      process.stdout.write(app.issueLaunchUrl() + "\n");
    if (process.stdin.isTTY) {
      process.stdout.write(
        "Type open to open another browser, or link to get a fresh one-time browser link.\n",
      );
      const input = createInterface({ input: process.stdin });
      input.on("line", (line) => {
        if (line.trim() === "open") openBrowser(app.issueLaunchUrl());
        if (line.trim() === "link")
          process.stdout.write(app.issueLaunchUrl() + "\n");
      });
    } else if (!options.open && !options.printLaunchUrl)
      process.stderr.write(
        "Use --print-launch-url to connect a browser when automatic opening is disabled.\n",
      );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        void app.close().then(() => process.exit(0));
      });
  });
program
  .command("init")
  .description("Create a schema with all project settings")
  .requiredOption(
    "--account <account>",
    "1Password account UUID or desktop name",
  )
  .requiredOption("--vault <id>", "Existing vault ID for the first environment")
  .option("--environment <name>", "First environment name", "dev")
  .option("--name <name>", "Project display name")
  .option("--auth <method>", "desktop or service-account", "desktop")
  .option("--schema <path>", "Schema to create", ".env.schema")
  .action(async (options) => {
    const config = configSchema.parse({
      version: 1,
      provider: "1password",
      account: options.account,
      auth: options.auth,
      name: options.name,
      defaultEnvironment: options.environment,
      environments: { [options.environment]: { vault: options.vault } },
    });
    const text = configurationText(config);
    try {
      await writeFile(options.schema, text, { flag: "wx", mode: 0o600 });
    } catch {
      throw new VaultError(
        "Cannot create schema. The destination may already exist.",
      );
    }
    process.stdout.write(
      "Created schema. Add variable definitions or adopt vault items in the web app.\n",
    );
  });

try {
  await program.parseAsync();
} catch (error) {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
}
