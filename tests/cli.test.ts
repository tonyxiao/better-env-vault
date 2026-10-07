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

// Launch/shutdown tests use fixture schemas and never initialize 1Password.
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { fixture } from "./helpers.js";

function envault(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("../packages/cli/src/envault.ts", import.meta.url)),
      ...args,
    ],
    options,
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (part) => {
    stdout += part;
  });
  child.stderr.on("data", (part) => {
    stderr += part;
  });
  const closed = once(child, "close");
  async function ready() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const url = stdout.match(/running at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url) return url;
      if (child.exitCode !== null)
        throw new Error(`CLI exited before starting: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("CLI did not start.");
  }
  return { child, closed, ready, output: () => ({ stdout, stderr }) };
}

it.each(["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"] as const)(
  "stops the envault server and closes active connections on %s",
  async (signal) => {
    const schema = await fixture("# @optional\nTOKEN=\n");
    const app = envault([schema.path, "--no-open", "--print-launch-url"]);
    let socket: ReturnType<typeof connect> | undefined;
    try {
      const url = await app.ready();
      const launchUrl = app
        .output()
        .stdout.split("\n")
        .find((line) => line.includes("#session="))!;
      const token = new URLSearchParams(new URL(launchUrl).hash.slice(1)).get(
        "session",
      );
      const session = await fetch(url + "/api/session", {
        method: "POST",
        headers: { Origin: url, "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(session.status).toBe(200);
      const cookie = session.headers.get("set-cookie")!.split(";")[0];
      const projects = await (
        await fetch(url + "/api/projects", { headers: { Cookie: cookie } })
      ).json();
      expect(projects.projects[0].schemaPath).toBe(schema.path);
      const address = new URL(url);
      socket = connect(Number(address.port), address.hostname);
      await once(socket, "connect");
      socket.write(`GET / HTTP/1.1\r\nHost: ${address.host}\r\n`);
      app.child.kill(signal);
      const [code, killedBy] = await app.closed;
      if (signal === "SIGKILL") expect(killedBy).toBe("SIGKILL");
      else expect(code).toBe(0);
      await expect(fetch(url + "/api/projects")).rejects.toThrow();
    } finally {
      socket?.destroy();
      if (app.child.exitCode === null && app.child.signalCode === null)
        app.child.kill("SIGKILL");
      await app.closed;
    }
  },
  10_000,
);

it.skipIf(process.platform === "win32")(
  "opens an authenticated browser link and defaults to the current schema",
  async () => {
    const schema = await fixture("# @optional\nTOKEN=\n");
    const directory = dirname(schema.path);
    const launchFile = join(directory, "browser-launch.json");
    const opener = join(
      directory,
      process.platform === "darwin" ? "open" : "xdg-open",
    );
    await writeFile(
      opener,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.BEV_TEST_LAUNCH_FILE, JSON.stringify(process.argv.slice(2)), {mode:0o600});\n`,
      { mode: 0o755 },
    );
    const app = envault([], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: directory + ":" + process.env.PATH,
        BEV_TEST_LAUNCH_FILE: launchFile,
      },
    });
    try {
      const url = await app.ready();
      let args: string[] | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          args = JSON.parse(await readFile(launchFile, "utf8"));
          break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(args).toHaveLength(1);
      const link = new URL(args![0]);
      expect(link.origin).toBe(url);
      expect(new URLSearchParams(link.hash.slice(1)).get("session")).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(app.output().stdout).not.toContain("#session=");
      app.child.kill("SIGINT");
      expect((await app.closed)[0]).toBe(0);
    } finally {
      if (app.child.exitCode === null && app.child.signalCode === null)
        app.child.kill("SIGKILL");
      await app.closed;
    }
  },
  10_000,
);

it("rejects missing schemas and invalid ports before launching the server", async () => {
  const schema = await fixture("# @optional\nTOKEN=\n");
  for (const args of [
    [join(dirname(schema.path), "missing")],
    [schema.path, "--port", "65536"],
  ]) {
    const app = envault(args);
    expect((await app.closed)[0]).toBe(1);
    expect(app.output().stdout).not.toContain("running at");
  }
});
