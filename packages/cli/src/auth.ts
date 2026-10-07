import { Command } from "commander";
import {
  storeServiceAccountToken,
  removeServiceAccountToken,
} from "../../core/src/keychain.js";
import { VaultError } from "../../core/src/errors.js";

export function authCommand() {
  const command = new Command("auth").description(
    "Manage service-account credentials in macOS Keychain",
  );
  command
    .command("store")
    .description(
      "Store a 1Password service-account token supplied on standard input",
    )
    .argument(
      "<name>",
      "Keychain entry referenced by serviceAccountKeychain in .env.schema",
    )
    .action(async (name: string) => {
      if (process.stdin.isTTY)
        throw new VaultError(
          "Pipe the service-account token to envault auth store; tokens are never accepted as command arguments.",
        );
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        length += buffer.length;
        if (length > 65536)
          throw new VaultError("Service-account token input is too large.");
        chunks.push(buffer);
      }
      try {
        const bytes = Buffer.concat(chunks);
        try {
          await storeServiceAccountToken(name, bytes.toString("utf8").trim());
        } finally {
          bytes.fill(0);
        }
      } finally {
        for (const chunk of chunks) chunk.fill(0);
      }
      process.stdout.write(
        `Service-account token stored in macOS Keychain as ${name}.\n`,
      );
    });
  command
    .command("remove")
    .description(
      "Remove a local Keychain credential; this does not revoke the 1Password service account",
    )
    .argument("<name>", "Keychain entry name")
    .action(async (name: string) => {
      const removed = await removeServiceAccountToken(name);
      process.stdout.write(
        removed
          ? `Removed Keychain entry ${name}.\n`
          : `Keychain entry ${name} was already absent.\n`,
      );
    });
  return command;
}
