import { spawn } from "node:child_process";
import { VaultError } from "./errors.js";
import { variableName } from "./schema.js";

export function shellExport(
  values: Record<string, string>,
  missing: string[] = [],
): string {
  const lines = missing.map((name) => {
    if (!variableName.test(name))
      throw new VaultError("Invalid variable name.");
    return `unset ${name}`;
  });
  for (const [name, value] of Object.entries(values)) {
    if (!variableName.test(name) || value.includes("\0"))
      throw new VaultError(
        "Invalid variable name or NUL in environment value.",
      );
    lines.push(`export ${name}='${value.replaceAll("'", "'\\''")}'`);
  }
  return lines.join("\n") + "\n";
}

export function childEnvironment(
  values: Record<string, string>,
  declared: string[],
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of declared) delete env[key];
  // Provider credentials are never implicitly forwarded to the consuming application.
  delete env.OP_SERVICE_ACCOUNT_TOKEN;
  delete env.__VARLOCK_ENV;
  for (const key of Object.keys(env))
    if (key.startsWith("OP_SESSION_")) delete env[key];
  return { ...env, ...values };
}

export function direnvDump(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("direnv", ["dump"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8_000_000) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () =>
      reject(new VaultError("Install direnv to use --format direnv.")),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString())
        : reject(new VaultError("direnv dump failed.")),
    );
  });
}
