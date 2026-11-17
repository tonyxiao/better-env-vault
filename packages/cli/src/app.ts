import { Command, Option } from "commander";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { VaultError } from "../../core/src/errors.js";

export function appCommand() {
  return new Command("app")
    .description("Launch the installed Better Env Vault macOS application")
    .option(
      "--schema <path...>",
      "Open project schemas instead of vault browsing",
    )
    .addOption(
      new Option("--auth <mode>", "Vault authentication").choices([
        "desktop",
        "service-account",
      ]),
    )
    .option("--account <account>", "1Password account name or UUID")
    .option("--service-account-keychain <name>", "macOS Keychain entry name")
    .action(async (options) => {
      if (process.platform !== "darwin")
        throw new VaultError("Better Env Vault.app requires macOS.");
      const path = resolve(homedir(), "Applications/Better Env Vault.app");
      try {
        await access(path);
      } catch {
        throw new VaultError("Install the macOS app with npm run app:install.");
      }
      const args: string[] = [];
      for (const schema of options.schema ?? [])
        args.push("--schema", resolve(schema));
      for (const [key, flag] of [
        ["auth", "--auth"],
        ["account", "--account"],
        ["serviceAccountKeychain", "--service-account-keychain"],
      ])
        if (options[key]) args.push(flag, options[key]);
      await new Promise<void>((done, reject) => {
        const child = spawn(
          "/usr/bin/open",
          args.length ? ["-n", path, "--args", ...args] : [path],
          {
            stdio: "ignore",
          },
        );
        const fail = () =>
          reject(new VaultError("Could not launch the macOS app."));
        child.once("error", fail);
        child.once("exit", (code) => (code === 0 ? done() : fail()));
      });
    });
}
