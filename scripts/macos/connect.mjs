// Run inside the signed op-agent child. Credentials travel only through private
// pipes and an owner-only Unix socket to the signed GUI app's existing core.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

async function receive() {
  const { createServer } = await import("node:net");
  const { chmod, mkdir, unlink } = await import("node:fs/promises");
  const { randomBytes } = await import("node:crypto");
  const { execFileSync } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const app = join(homedir(), "Applications/Better Env Vault.app");
  const requirement =
    '=identifier "com.txlforge.better-env-vault" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: Tony Xiao (9QULCFJ59K)"';
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    stdio: "ignore",
  });
  execFileSync("/usr/bin/codesign", ["--verify", "-R", requirement, app], {
    stdio: "ignore",
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) throw new Error("Credential input is too large.");
    chunks.push(chunk);
  }
  const token = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  if (!token.subarray(0, 4).equals(Buffer.from("ops_")))
    throw new Error("A service-account token is required.");
  const directory = join(
    homedir(),
    "Library/Caches/better-env-vault-installer",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, randomBytes(6).toString("hex") + ".sock");
  const previousUmask = process.umask(0o077);
  const server = createServer({ allowHalfOpen: true });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("App credential setup timed out.")),
        60_000,
      );
      server.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Could not create the private connection."));
      });
      server.once("connection", (socket) => {
        server.close();
        let reply = "";
        socket.on("data", (part) => {
          if (reply.length < 32) reply += part.toString();
        });
        socket.once("error", () => {
          clearTimeout(timer);
          reject(new Error("App credential connection failed."));
        });
        socket.once("end", () => {
          clearTimeout(timer);
          resolve(reply === "OK");
          socket.destroy();
        });
        socket.end(token);
      });
      server.listen(path, async () => {
        try {
          await chmod(path, 0o600);
          execFileSync(
            "/usr/bin/open",
            ["-n", app, "--args", "--connect-socket", path],
            { stdio: "ignore" },
          );
        } catch {
          clearTimeout(timer);
          reject(new Error("Could not launch app credential setup."));
        }
      });
    });
    if (!result)
      throw new Error("App Keychain setup failed. Unlock Keychain and retry.");
  } finally {
    process.umask(previousUmask);
    token.fill(0);
    if (server.listening) server.close();
    await unlink(path).catch(() => {});
  }
}

const host = process.argv[2];
if (host && !/^[a-z0-9][a-z0-9.-]*$/i.test(host))
  throw new Error("Use a configured SSH host name.");
const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
if (!token?.startsWith("ops_"))
  throw new Error(
    "Run via op-agent run --no-masking -- npm run app:connect -- [ssh-host].",
  );
const bytes = Buffer.from(token);
const environment = {
  HOME: homedir(),
  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  LANG: "en_US.UTF-8",
};
if (process.env.SSH_AUTH_SOCK)
  environment.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
const source = `(${receive.toString()})().catch(() => process.exit(1))`;
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const executable = host
  ? "/usr/bin/ssh"
  : join(
      homedir(),
      "Applications/Better Env Vault.app/Contents/Resources/runtime/bin/node",
    );
const args = host
  ? [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      host,
      'exec "$HOME/Applications/Better Env Vault.app/Contents/Resources/runtime/bin/node" --input-type=module -e ' +
        shellQuote(source),
    ]
  : ["--input-type=module", "-e", source];
try {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("App credential setup timed out."));
    }, 70_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not start app credential setup."));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            new Error(
              "App Keychain setup failed. Unlock Keychain and allow access if prompted.",
            ),
          );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
  console.log(`APP_KEYCHAIN_CONFIGURED ${host ?? "this Mac"}`);
} finally {
  bytes.fill(0);
}
