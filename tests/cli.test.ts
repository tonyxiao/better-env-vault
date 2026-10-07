import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSchema } from "../packages/core/src/schema.js";

function cli(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "packages/cli/src/index.ts",
      ...args,
    ]);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => (stdout += part));
    child.stderr.on("data", (part) => (stderr += part));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
it("starts the CLI and exposes every command without contacting 1Password", async () => {
  const result = await cli(["--help"]);
  expect(result.code).toBe(0);
  for (const command of ["export", "check", "explain", "run", "serve", "init"])
    expect(result.stdout).toContain(command);
});
it("initializes a standalone schema and refuses to overwrite it", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "bev-cli-")), ".env.schema");
  const args = [
    "init",
    "--account",
    "example-account",
    "--vault",
    "a".repeat(26),
    "--schema",
    path,
  ];
  expect((await cli(args)).code).toBe(0);
  expect((await loadSchema(path)).config.environments.dev.vault).toBe(
    "a".repeat(26),
  );
  expect((await cli(args)).code).toBe(1);
});
it("fails without partial export and accepts child-command options after --", async () => {
  const path = join(
    await mkdtemp(join(tmpdir(), "bev-cli-")),
    "missing.env.schema",
  );
  const result = await cli(["export", "--schema", path]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Cannot read");
  const child = await cli([
    "run",
    "--schema",
    path,
    "--",
    "node",
    "-e",
    "process.exit(0)",
  ]);
  expect(child.code).toBe(1);
  expect(child.stderr).toContain("Cannot read");
  expect(child.stderr).not.toContain("unknown option");
});
