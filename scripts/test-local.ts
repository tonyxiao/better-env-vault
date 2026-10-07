/** Explicit integration test. Never imported by the normal test suite. */
import assert from "node:assert/strict";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  createClient,
  DesktopAuth,
  ItemCategory,
  ItemState,
} from "@1password/sdk";
import {
  configurationText,
  loadSchema,
  type ProjectConfig,
} from "../packages/core/src/schema.js";
import { OnePasswordProvider } from "../packages/core/src/provider.js";
import {
  readVaults,
  resolveEnvironment,
  exportValues,
  publicResolution,
} from "../packages/core/src/resolver.js";
import { applyEdit } from "../packages/core/src/edit.js";
import { startServer } from "../apps/web/src/server.js";
import { safeError, VaultError } from "../packages/core/src/errors.js";

const options = new Command()
  .requiredOption(
    "--account <account>",
    "Personal 1Password account UUID or desktop name",
  )
  .option("--hold", "Keep disposable vaults and UI open until interrupted")
  .option(
    "--existing",
    "Also perform read-only resolution of an existing API Credential vault",
  )
  .parse()
  .opts();
const localDirectory = resolve(".local");
await mkdir(localDirectory, { recursive: true, mode: 0o700 });
const recoveryPath = resolve(localDirectory, "cleanup.json");
const statePath = resolve(localDirectory, "test-session.json");
if (existsSync(recoveryPath)) {
  console.error(
    "A previous test needs cleanup. Run npm run test:cleanup before creating new test vaults.",
  );
  process.exit(1);
}
const cli = promisify(execFile);
function shellWithInput(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () =>
      reject(new VaultError("Could not start the shell verification.")),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString())
        : reject(new VaultError("Shell verification failed.")),
    );
    child.stdin.end(input);
  });
}
async function cliOutput(args: string[]) {
  try {
    return (
      await cli(process.execPath, ["bin/better-env-vault.mjs", ...args], {
        maxBuffer: 8_000_000,
      })
    ).stdout;
  } catch {
    throw new VaultError(
      "Live CLI verification failed. Check desktop authorization and retry.",
    );
  }
}
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let client: Awaited<ReturnType<typeof createClient>>;
try {
  client = await createClient({
    auth: new DesktopAuth(options.account),
    integrationName: "Better Env Vault",
    integrationVersion: "0.1.0",
  });
} catch {
  console.error(
    "1Password denied or could not authorize the desktop SDK request. Unlock the app and approve Better Env Vault. No test vaults were created.",
  );
  process.exit(1);
}
const disposableVaults: string[] = [];
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
try {
  console.log(
    "Desktop SDK authenticated. Creating dedicated disposable vaults.",
  );
  for (const env of ["dev", "staging", "prod"]) {
    const vault = await client.vaults.create({
      title: `Better Env Vault test ${runId} ${env}`,
      description:
        "Disposable non-secret integration test data. Safe to delete after the test.",
    });
    disposableVaults.push(vault.id);
    await writeFile(
      recoveryPath,
      JSON.stringify(
        { account: options.account, vaults: disposableVaults },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  const config: ProjectConfig = {
    version: 1,
    name: "Local 1Password verification",
    provider: "1password",
    auth: "desktop",
    account: options.account,
    defaultEnvironment: "dev",
    environments: {
      dev: { vault: disposableVaults[0] },
      staging: { vault: disposableVaults[1], extends: "dev" },
      prod: { vault: disposableVaults[2], extends: "staging" },
    },
  };
  const schemaPath = resolve(localDirectory, ".env.schema");
  await writeFile(
    schemaPath,
    configurationText(config) +
      "# Application label\n# @public @required\nAPP_LABEL=Schema default\n\n# A non-secret value treated as sensitive for masking checks\n# @required\nTEST_TOKEN=\n\n# @public @optional\nEMPTY_VALUE=base\n\n# @public @type=number(min=1,max=10)\nWORKERS=2\n",
    { mode: 0o600 },
  );
  const provider = new OnePasswordProvider(client, config);
  const token = "non-secret-test ' $() `backticks` \\ Unicode ☃\nsecond line";
  await provider.save(
    config.environments.dev.vault,
    "APP_LABEL",
    "Development label",
    "Keep this user note.",
  );
  await provider.save(
    config.environments.staging.vault,
    "APP_LABEL",
    "Staging label",
    "Stage note.",
  );
  await provider.save(
    config.environments.dev.vault,
    "TEST_TOKEN",
    token,
    "Non-secret disposable test fixture.",
  );
  await provider.save(
    config.environments.prod.vault,
    "EMPTY_VALUE",
    "",
    "Explicit empty override.",
  );
  let schema = await loadSchema(schemaPath);
  const snapshot = await readVaults(schema, provider);
  const production = await resolveEnvironment(schema, "prod", snapshot);
  assert.ok(production.valid, "Live configuration must validate.");
  assert.ok(
    exportValues(production).APP_LABEL === "Staging label",
    "Fallback must use the closest parent.",
  );
  assert.ok(
    exportValues(production).EMPTY_VALUE === "",
    "Explicit empty credential must survive.",
  );
  assert.ok(
    exportValues(production).TEST_TOKEN === token,
    "Sensitive value must resolve without modification.",
  );
  assert.ok(
    !JSON.stringify(publicResolution(production)).includes(token),
    "Metadata must not expose sensitive test values.",
  );
  console.log(
    "Live batch reads, fallback resolution, explicit empty values, and masking passed.",
  );
  const versions = (
    name: string,
    snap: Awaited<ReturnType<typeof readVaults>>,
  ) =>
    Object.fromEntries(
      Object.keys(config.environments).map((env) => [
        env,
        snap[env].find((i) => i.name === name)?.version ?? null,
      ]),
    );
  await applyEdit(schemaPath, provider, {
    action: "set",
    name: "APP_LABEL",
    environment: "dev",
    value: "Updated development",
    fingerprint: schema.fingerprint,
    versions: versions("APP_LABEL", snapshot),
  });
  const afterEdit = await readVaults(schema, provider);
  assert.ok(
    afterEdit.dev.find((i) => i.name === "APP_LABEL")?.notes ===
      "Keep this user note.",
    "Existing notes must survive edits.",
  );
  await assert.rejects(
    () =>
      applyEdit(schemaPath, provider, {
        action: "set",
        name: "APP_LABEL",
        environment: "dev",
        value: "stale",
        fingerprint: schema.fingerprint,
        versions: versions("APP_LABEL", snapshot),
      }),
    (error) => error instanceof VaultError && error.code === "conflict",
  );
  await applyEdit(schemaPath, provider, {
    action: "default",
    name: "WORKERS",
    value: "3",
    fingerprint: schema.fingerprint,
    versions: versions("WORKERS", afterEdit),
  });
  schema = await loadSchema(schemaPath);
  await applyEdit(schemaPath, provider, {
    action: "rename",
    name: "EMPTY_VALUE",
    newName: "EMPTY_RENAMED",
    fingerprint: schema.fingerprint,
    versions: versions("EMPTY_VALUE", afterEdit),
  });
  schema = await loadSchema(schemaPath);
  const afterRename = await readVaults(schema, provider);
  assert.ok(
    afterRename.prod.some((i) => i.name === "EMPTY_RENAMED" && i.value === ""),
    "Live rename must preserve empty values.",
  );
  await applyEdit(schemaPath, provider, {
    action: "remove",
    name: "APP_LABEL",
    environment: "staging",
    fingerprint: schema.fingerprint,
    versions: versions("APP_LABEL", afterRename),
  });
  const afterRemove = await readVaults(schema, provider);
  assert.ok(
    (await resolveEnvironment(schema, "prod", afterRemove)).variables.find(
      (v) => v.name === "APP_LABEL",
    )?.value === "Updated development",
    "Removal must restore inheritance.",
  );
  console.log(
    "Live edits, note preservation, stale-write rejection, schema defaults, rename, and removal passed.",
  );
  const check = await cliOutput([
    "check",
    "--schema",
    schemaPath,
    "--environment",
    "prod",
  ]);
  assert.ok(check.includes("validated"), "CLI check must succeed.");
  const explain = await cliOutput([
    "explain",
    "--schema",
    schemaPath,
    "--environment",
    "prod",
  ]);
  assert.ok(!explain.includes(token), "CLI explain must not expose values.");
  const childValues = JSON.parse(
    await cliOutput([
      "run",
      "--schema",
      schemaPath,
      "--environment",
      "prod",
      "--",
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify({APP_LABEL:process.env.APP_LABEL,TEST_TOKEN:process.env.TEST_TOKEN,EMPTY_RENAMED:process.env.EMPTY_RENAMED,WORKERS:process.env.WORKERS}))",
    ]),
  );
  assert.ok(
    childValues.APP_LABEL === "Updated development" &&
      childValues.TEST_TOKEN === token &&
      childValues.EMPTY_RENAMED === "" &&
      childValues.WORKERS === "3",
    "CLI child must receive the exact live resolved values.",
  );
  const shellPayload = await cliOutput([
    "export",
    "--schema",
    schemaPath,
    "--environment",
    "prod",
    "--format",
    "shell",
  ]);
  const sourced = await shellWithInput(
    "source /dev/stdin",
    shellPayload +
      "\nnode -e 'process.stdout.write(JSON.stringify(process.env.TEST_TOKEN))'",
  );
  assert.ok(
    JSON.parse(sourced) === token,
    "Shell source must preserve hostile characters.",
  );
  const direnvPayload = await cliOutput([
    "export",
    "--schema",
    schemaPath,
    "--environment",
    "prod",
    "--format",
    "direnv",
  ]);
  const direnvChild = await shellWithInput(
    "eval \"$(direnv apply_dump /dev/stdin)\"; node -e 'process.stdout.write(JSON.stringify(process.env.TEST_TOKEN))'",
    direnvPayload,
  );
  assert.ok(
    JSON.parse(direnvChild) === token,
    "direnv must decode the exact live resolved value.",
  );
  console.log(
    "Built CLI check, explain, child execution, shell sourcing, and direnv passed against local 1Password.",
  );
  if (options.existing) {
    const existingVaults = (await client.vaults.list()).filter(
      (v) => !disposableVaults.includes(v.id),
    );
    for (const vault of existingVaults) {
      const overview = (await client.items.list(vault.id)).filter(
        (i) =>
          i.category === ItemCategory.ApiCredentials &&
          i.state === ItemState.Active,
      );
      if (
        !overview.length ||
        overview.some((i) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(i.title))
      )
        continue;
      const existingConfig: ProjectConfig = {
        ...config,
        name: "Local existing vault",
        defaultEnvironment: "dev",
        environments: { dev: { vault: vault.id } },
      };
      const existingPath = resolve(localDirectory, "existing.env.schema");
      await writeFile(
        existingPath,
        configurationText(existingConfig) +
          overview.map((i) => `# @required\n${i.title}=\n`).join("\n"),
        { mode: 0o600 },
      );
      const existingSchema = await loadSchema(existingPath);
      const existingProvider = new OnePasswordProvider(client, existingConfig);
      const resolved = await resolveEnvironment(
        existingSchema,
        "dev",
        await readVaults(existingSchema, existingProvider),
      );
      assert.ok(resolved.valid, "Existing vault must resolve and validate.");
      const result = JSON.parse(
        await cliOutput([
          "run",
          "--schema",
          existingPath,
          "--",
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify(process.env))",
        ]),
      );
      assert.ok(
        resolved.variables.every((v) => result[v.name] === v.value),
        "Existing vault child must receive the expected values.",
      );
      console.log(
        `Existing vault read-only verification passed: ${resolved.variables.length} variables loaded into a child process; values were not logged.`,
      );
      break;
    }
  }
  app = await startServer({ schemas: [schemaPath], provider, port: 4187 });
  await writeFile(
    statePath,
    JSON.stringify(
      { url: app.url, launchUrl: app.launchUrl, schemaPath },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const unauthenticated = await fetch(app.url + "/api/matrix?project=0");
  assert.ok(
    unauthenticated.status === 401,
    "Live local server must require a browser session.",
  );
  console.log(
    `Live UI is ready at ${app.url}. The one-time launch URL is stored privately in .local/test-session.json.`,
  );
  if (options.hold) {
    console.log(
      "Waiting for browser verification. Interrupt to close the server and delete the dedicated test vaults.",
    );
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} catch (error) {
  console.error(safeError(error));
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  const failed: string[] = [];
  for (const id of disposableVaults) {
    try {
      await client.vaults.delete(id);
    } catch {
      failed.push(id);
    }
  }
  if (failed.length) {
    await writeFile(
      recoveryPath,
      JSON.stringify({ account: options.account, vaults: failed }, null, 2),
      { mode: 0o600 },
    );
    console.error(
      "Some disposable vaults could not be deleted. Recovery IDs remain in .local/cleanup.json.",
    );
    process.exitCode = 1;
  } else {
    const remaining = await client.vaults.list();
    assert.ok(
      !remaining.some((v) => disposableVaults.includes(v.id)),
      "All disposable test vaults must be deleted.",
    );
    await unlink(recoveryPath).catch(() => {});
    await unlink(statePath).catch(() => {});
    console.log("Cleanup verified: all dedicated test vaults were deleted.");
  }
  await writeFile(
    resolve(localDirectory, "test-result.json"),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        success: !process.exitCode,
        disposableVaultsCreated: disposableVaults.length,
        cleanupVerified: failed.length === 0,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
