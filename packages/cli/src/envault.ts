#!/usr/bin/env node
import { Command } from "commander";
import { safeError, VaultError } from "../../core/src/errors.js";
import { serve, webOptions } from "./serve.js";
import { authCommand } from "./auth.js";
import { lstat } from "node:fs/promises";

const program = webOptions(
  new Command()
    .name("envault")
    .version("0.1.0")
    .description(
      "Open a schema editor, or browse 1Password vaults when no .env.schema is present. The server stops when this CLI exits.",
    )
    .argument("[schema]", "Path to .env.schema")
    .option("--vaults", "Browse 1Password vaults even when a schema is present")
    .option(
      "--account <account>",
      "1Password account name or UUID for vault browsing",
    )
    .option(
      "--service-account-keychain <name>",
      "macOS Keychain entry for vault browsing",
    ),
);

program.addCommand(authCommand());

program.action(async (schema: string | undefined, options) => {
  if (schema && options.vaults)
    throw new VaultError("Choose a schema path or --vaults.");
  let discovery = options.vaults === true;
  if (!schema && !discovery) {
    try {
      await lstat(".env.schema");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      discovery = true;
    }
  }
  await serve({
    ...options,
    schemas: discovery ? [] : [schema ?? ".env.schema"],
    ...(discovery
      ? {
          discovery: {
            account: options.account,
            serviceAccountKeychain: options.serviceAccountKeychain,
          },
        }
      : {}),
  });
});

try {
  await program.parseAsync();
} catch (error) {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
}
