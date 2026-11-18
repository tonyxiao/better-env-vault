import { execFileSync, spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const bundle = join(root, ".local/electron/Better Env Vault.app");
const stage = join(root, "tmp/electron-deploy");
const archive = join(stage, "Better Env Vault-electron.zip");
const verifyScript = join(root, "scripts/electron/verify.mjs");
const requirement =
  '=identifier "com.txlforge.better-env-vault" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: Tony Xiao (9QULCFJ59K)"';
const values = process.argv.slice(2);
const take = (flag) => {
  const index = values.indexOf(flag);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (!value) throw new Error(`Missing value for ${flag}.`);
  values.splice(index, 2);
  return value;
};
const desktopAccount = take("--desktop-account");
const provisionHost = take("--provision-host");
const signatureOnly = values.includes("--signature-only");
if (signatureOnly) values.splice(values.indexOf("--signature-only"), 1);
const hosts = values;
if (
  !hosts.length ||
  hosts.some((host) => !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host))
)
  throw new Error("Specify SSH hosts to deploy.");
if (provisionHost && !hosts.includes(provisionHost))
  throw new Error("The provisioning host must also be a deployment host.");
if (provisionHost && !process.env.OP_SERVICE_ACCOUNT_TOKEN)
  throw new Error("Run provisioning deployment through op-agent.");
if (
  desktopAccount &&
  (!desktopAccount.trim() ||
    desktopAccount.length > 128 ||
    /[\r\n\0]/.test(desktopAccount) ||
    desktopAccount.startsWith("ops_") ||
    desktopAccount.startsWith("A3-"))
)
  throw new Error("Invalid desktop account name.");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
}
function succeeds(command, args) {
  try {
    execFileSync(command, args, { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const ssh = (host, script) =>
  run(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, "/bin/sh", "-s"],
    { input: script, stdio: ["pipe", "inherit", "inherit"] },
  );

await access(bundle);
run("codesign", ["--verify", "--deep", "--strict", "-R", requirement, bundle]);
await mkdir(stage, { recursive: true, mode: 0o700 });
run("ditto", ["-c", "-k", "--keepParent", bundle, archive]);
const archiveDigest = execFileSync("/usr/bin/shasum", ["-a", "256", archive], {
  encoding: "utf8",
})
  .split(/\s/)[0]
  .trim();

for (const host of hosts) {
  const cache = "$HOME/Library/Caches/better-env-vault-electron-installer";
  run("ssh", [host, `mkdir -p ${cache}`]);
  const cachedArchive =
    "Library/Caches/better-env-vault-electron-installer/update.zip";
  if (
    !succeeds("ssh", [
      host,
      `test "$(/usr/bin/shasum -a 256 ${cachedArchive} 2>/dev/null | /usr/bin/awk '{print $1}')" = ${archiveDigest}`,
    ])
  )
    run("scp", [archive, `${host}:${cachedArchive}`]);
  run("scp", [
    verifyScript,
    `${host}:Library/Caches/better-env-vault-electron-installer/verify.mjs`,
  ]);
  try {
    ssh(
      host,
      `set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cache=${cache}
cd "$cache"
stage="update-$(date +%Y%m%d%H%M%S)-$$"
mkdir "$stage"
ditto -x -k update.zip "$stage"
app="$stage/Better Env Vault.app"
codesign --verify --deep --strict -R '${requirement}' "$app"
/usr/bin/killall "Better Env Vault" 2>/dev/null || true
/usr/bin/killall BetterEnvVault 2>/dev/null || true
installed="$HOME/Applications/Better Env Vault.app"
mkdir -p "$HOME/Applications"
if [ -e "$cache/previous.app" ]; then /bin/mv "$cache/previous.app" "$stage/older-previous.app"; fi
if [ -e "$installed" ]; then /bin/mv "$installed" "$cache/previous.app"; fi
/bin/mv "$app" "$installed"
codesign --verify --deep --strict "$installed"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$installed"
`,
    );

    if (host === provisionHost) {
      const socket =
        "$HOME/Library/Caches/better-env-vault-electron-installer/provision.sock";
      const result =
        "$HOME/Library/Caches/better-env-vault-electron-installer/provision.json";
      ssh(
        host,
        `set -eu
socket=${socket}
result=${result}
if [ -e "$socket" ]; then /bin/mv "$socket" "$socket.stale.$$"; fi
if [ -e "$result" ]; then /bin/mv "$result" "$result.stale.$$"; fi
env -u ELECTRON_RUN_AS_NODE open -n "$HOME/Applications/Better Env Vault.app" --args --provision-service-account=better-env-vault-electron --provision-socket="$socket" --verify-status="$result"
deadline=$((SECONDS+30))
while [ ! -S "$socket" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
[ -S "$socket" ]
`,
      );
      const sender = spawn(
        "ssh",
        [host, "/usr/bin/nc", "-w", "1", "-U", `${socket}`],
        { stdio: ["pipe", "ignore", "inherit"] },
      );
      sender.stdin.end(process.env.OP_SERVICE_ACCOUNT_TOKEN);
      await new Promise((resolvePromise, reject) => {
        sender.once("error", reject);
        // Apple nc can report 1 when the server closes a successfully written
        // Unix socket. The signed app's result below is the authoritative ack.
        sender.once("exit", resolvePromise);
      });
      ssh(
        host,
        `set -eu
result=${result}
deadline=$((SECONDS+100))
while [ ! -s "$result" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
/usr/bin/grep -q '"status":"ok"' "$result"
`,
      );
    } else if (!signatureOnly) {
      const source = desktopAccount
        ? ` --verify-source=${JSON.stringify(`desktop:${desktopAccount}`)}`
        : "";
      ssh(
        host,
        `set -eu
cd ${cache}
ELECTRON_RUN_AS_NODE=1 "$HOME/Applications/Better Env Vault.app/Contents/MacOS/Better Env Vault" verify.mjs${source}
`,
      );
    }
    console.log(
      `${signatureOnly ? "INSTALLED_SIGNATURE_VERIFIED" : "INSTALLED_AND_VERIFIED"} ${host}`,
    );
  } catch (error) {
    ssh(
      host,
      `set -eu
cache=${cache}
/usr/bin/killall "Better Env Vault" 2>/dev/null || true
installed="$HOME/Applications/Better Env Vault.app"
failed="$cache/failed-electron-$(date +%Y%m%d%H%M%S)-$$.app"
if [ -e "$installed" ]; then /bin/mv "$installed" "$failed"; fi
if [ -e "$cache/previous.app" ]; then /bin/mv "$cache/previous.app" "$installed"; fi
if [ -e "$installed" ]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$installed"
fi
`,
    );
    throw error;
  }
}
