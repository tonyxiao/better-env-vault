// Copy the already-built signed portable app. Credentials stay on each Mac.
import { execFileSync } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const bundle = join(root, ".local/macos/Better Env Vault.app");
const stage = join(root, "tmp/macos");
const archive = join(stage, "Better Env Vault-update.zip");
const requirement =
  '=identifier "com.txlforge.better-env-vault" and anchor apple generic and certificate leaf[subject.CN] = "Apple Development: Tony Xiao (9QULCFJ59K)"';
const hosts = process.argv.slice(2);
const signatureOnly = hosts.includes("--signature-only");
if (signatureOnly) hosts.splice(hosts.indexOf("--signature-only"), 1);
const desktopFlag = hosts.indexOf("--desktop-account");
const desktopAccount = desktopFlag >= 0 ? hosts[desktopFlag + 1] : undefined;
if (desktopFlag >= 0) {
  if (
    !desktopAccount ||
    desktopAccount.length > 128 ||
    /[\r\n\0]/.test(desktopAccount) ||
    desktopAccount.startsWith("ops_")
  )
    throw new Error("Specify a desktop account name.");
  hosts.splice(desktopFlag, 2);
}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const verifyArgs = desktopAccount
  ? ` --auth desktop --account ${quote(desktopAccount)}`
  : "";
if (
  !hosts.length ||
  hosts.some((host) => !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host))
)
  throw new Error(
    "Specify SSH hosts: npm run app:deploy -- tx-m5 tx-mba cs-mini",
  );
function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
}
let profiled = false;
try {
  await access(join(bundle, "Contents/embedded.provisionprofile"));
  profiled = true;
} catch {}
if (profiled)
  throw new Error("Build the portable app before copying it across Macs.");
run("codesign", ["--verify", "--deep", "--strict", "-R", requirement, bundle]);
await mkdir(stage, { recursive: true, mode: 0o700 });
run("ditto", ["-c", "-k", "--keepParent", bundle, archive]);
for (const host of hosts) {
  run("ssh", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    host,
    "mkdir -p ~/Library/Caches/better-env-vault-installer",
  ]);
  const target = `${host}:Library/Caches/better-env-vault-installer/`;
  run("scp", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    archive,
    target + "update.zip",
  ]);
  run("scp", [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    join(root, "scripts/macos/verify.mjs"),
    target + "verify.mjs",
  ]);
  run(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, "/bin/sh -s"],
    {
      stdio: ["pipe", "inherit", "inherit"],
      input: `set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ "$(uname -m)" = "${process.arch === "arm64" ? "arm64" : "x86_64"}" ] || { echo 'Target architecture differs; build on that architecture.' >&2; exit 1; }
cd "$HOME/Library/Caches/better-env-vault-installer"
stage="update-$(date +%Y%m%d%H%M%S)-$$"
mkdir "$stage"
ditto -x -k update.zip "$stage"
app="$stage/Better Env Vault.app"
codesign --verify --deep --strict -R '${requirement}' "$app"
mkdir -p "$HOME/Applications"
installed="$HOME/Applications/Better Env Vault.app"
if [ -e "$installed" ]; then
  mv "$installed" "$stage/previous.app"
fi
mv "$app" "$installed"
codesign --verify --deep --strict "$installed"
${signatureOnly ? ": # Live verification deferred until the desktop account is unlocked." : '"$installed/Contents/Resources/runtime/bin/node" verify.mjs' + verifyArgs}
if [ -e "$stage/previous.app" ] && command -v trash >/dev/null; then
  trash "$stage/previous.app"
fi
`,
    },
  );
  console.log(
    `${signatureOnly ? "INSTALLED_SIGNATURE_VERIFIED" : "INSTALLED_AND_VERIFIED"} ${host}`,
  );
}
