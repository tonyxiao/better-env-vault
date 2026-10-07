# Using Better Env Vault

Install Node.js 22 or newer and 1Password 8. In 1Password, open **Settings →
Developer** and enable **Integrate with other apps** under SDK integration.
Desktop authentication uses the account named in the schema. The desktop app
controls authorization prompts; unlock it and approve Better Env Vault when asked.

Build and link the CLI from this checkout:

```bash
npm ci
npm run build
npm link
```

Run `better-env-vault --help` for the available commands. For development, use
`npm run dev -- <command>` without linking.

## One schema per project

All declarative project settings live in `.env.schema`. The CLI discovers that
file in the current directory. `--schema ./path/to/.env.schema` selects a different
project. There is no separate configuration file or persisted project registry.

Get your account UUID and vault IDs from the 1Password CLI (`op account list`
and `op vault list --account <account>`), or the 1Password app. IDs and account
names are metadata; keep private project schemas out of public repositories
when they contain private organizational details.

Initialize a project using an existing vault:

```bash
better-env-vault init --account <account-uuid> --vault <vault-id> --environment dev
```

Then edit its schema. This example uses placeholders; replace each ID with the
actual 26-character vault ID:

```dotenv
# @vaultConfig='{"version":1,"name":"Example","provider":"1password","account":"<account-uuid>","auth":"desktop","defaultEnvironment":"dev","environments":{"dev":{"vault":"<dev-vault-id>"},"staging":{"vault":"<staging-vault-id>","extends":"dev"},"prod":{"vault":"<prod-vault-id>","extends":"staging"}}}'
# @defaultSensitive=true
# ---

# Public base URL shared by every environment
# @public @required @type=url
PUBLIC_URL=https://example.com

# Worker count
# @public @type=number(min=1,max=16)
WORKERS=2

# Stored in the credential field of an API Credential item named API_TOKEN
# @required
API_TOKEN=

# Required only in production
# @required=forEnv(prod)
PRODUCTION_TOKEN=
```

`@vaultConfig` is a static JSON string in the schema's header. It supports:

| Setting              | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `version`            | `1`                                                                             |
| `provider`           | `1password`                                                                     |
| `account`            | Desktop account UUID/name; service-account account boundary metadata            |
| `auth`               | `desktop` (default) or `service-account`                                        |
| `name`               | Optional project display name                                                   |
| `defaultEnvironment` | Optional environment used when `--environment` is omitted                       |
| `environments`       | Named environments, each with a unique `vault` ID and optional `extends` parent |
| `legacyFields`       | Optional mapping of variable names to pre-existing field IDs                    |

Keep a `# ---` divider between the header and variable definitions so the first
variable's comments belong to that variable. New schemas default to treating
values as sensitive; mark non-sensitive definitions `@public` before adding
literal defaults. Sensitive literal defaults are rejected, even if a vault
override shadows them. Secret values and authentication tokens belong in
1Password or the process environment, never in the schema.

For service-account authentication, set `auth` to `service-account` in the
schema and supply `OP_SERVICE_ACCOUNT_TOKEN` to the CLI/server process using your
existing secure provisioning mechanism. The SDK verifies every configured vault
against the authenticated account's accessible vaults. Provider credentials are
not implicitly forwarded to commands run by this tool.

Your installed CLI can create a scoped service account. For example, capture a
24-hour token directly into the shell environment, using your account and vault
names in place of the placeholders:

```bash
export OP_SERVICE_ACCOUNT_TOKEN="$(op service-account create better-env-vault \
  --account '<account>' \
  --expires-in 24h \
  --vault '<dev-vault>:read_items,write_items' \
  --vault '<staging-vault>:read_items,write_items' \
  --vault '<prod-vault>:read_items,write_items' \
  --raw)"
```

Creating the account needs authorization once. With `auth: "service-account"` in
`@vaultConfig`, subsequent SDK operations use the token and do not prompt through
the desktop app. Use just `read_items` for export-only access. Tokens are shown
only once, and service-account permissions cannot be changed after creation.
Service accounts cannot access built-in Personal, Private, Employee, or default
Shared vaults; environment vaults must be ordinary custom vaults. See the
[official service-account setup guide](https://developer.1password.com/docs/service-accounts/get-started/).

## Load values

```bash
better-env-vault check --environment prod
better-env-vault explain --environment prod
better-env-vault run --environment dev -- npm run dev
```

Values resolve in this order: schema defaults, oldest parent vault, nearest
parent vault, selected environment vault. A missing override inherits its
parent. An explicit empty string overrides it. Only schema-declared keys are
exported. Unmanaged API Credential items are shown separately in the UI.
Unrelated shell values do not fill missing keys; missing optional declared keys
are removed from the child environment. Required or invalid values stop export
before any output is written.

Use a guarded Bash/Zsh source command when loading directly into a terminal:

```bash
if bev_exports=$(better-env-vault export --environment dev --format shell); then
  eval "$bev_exports"
fi
unset bev_exports
```

The exporter quotes values literally, including dollar signs, quotes,
backticks, Unicode, and multiline text. Do not enable shell tracing (`set -x`)
while loading secrets. `source <(better-env-vault export ...)` is also supported,
but process-substitution failures do not reliably propagate through `source`.
Use `run` when application startup must fail on invalid configuration.

For direnv, install direnv and place this in your project's `.envrc`:

```bash
watch_file .env.schema
direnv_load better-env-vault export --environment dev --format direnv
```

Run `direnv allow` once, and `direnv reload` to fetch fresh values. The tool uses
`direnv dump`'s own encoding. Modern direnv supplies a temporary dump path through
`DIRENV_DUMP_FILE_PATH`; direnv owns that temporary file and removes it after
loading. Direct shell export and `run` keep resolved values in memory and do not
write a secrets file. Already running applications need a restart to receive
changed values.

## Local matrix and editing

```bash
better-env-vault serve
better-env-vault serve --schema ./project-a/.env.schema ./project-b/.env.schema
```

`serve` binds to loopback and opens a one-time browser launch link. The browser
clears the link's fragment immediately, exchanges it for an HttpOnly session
cookie, and keeps the mutation token in memory. Each new browser needs its own
one-time link. In the running server's terminal, type `link` to obtain a fresh
link or `open` to open your default browser. Links expire after five minutes;
issuing another does not disconnect existing browsers. For manual launch:

```bash
better-env-vault serve --schema ./path/to/.env.schema --no-open --print-launch-url
```

Copy the one-time link into the browser you want to connect. Opening the plain
address does not authenticate a new browser. The app validates Host and Origin,
requires a session for all API reads, and sends no-store responses.

The matrix shows schema defaults, explicit overrides, inherited values, and
missing/invalid values. Search by name or description and filter missing,
invalid, or overridden values. Sensitive cells use a fixed mask. **Reveal
current value** retrieves only the selected cell; closing the editor or changing
projects discards the revealed value.

Click an environment cell to create or replace its override. Existing notes are
preserved unless edited. Reveal the current value to edit existing notes. An
inherited cell creates an override in the selected environment; **Edit source
environment** deliberately targets the ancestor instead. **Remove override**
restores inheritance.

The editor also supports public schema defaults, descriptions, types, required
and sensitive status, renaming across vaults, and confirmed deletion everywhere.
**Add variable** creates a definition and an initial value in the selected
environment in one save. Turn off **Set an initial environment value** to create
only a definition. Sensitive values are written to 1Password, never to the schema.
You can update an override's notes without revealing or replacing its value.
To deliberately clear a value, select **Set an explicit empty value**; use
**Remove override** to restore inheritance instead.
**Adopt into schema** registers unmanaged items without copying their values.
**Project settings** edits `@vaultConfig` in the schema header.

SDK connection attempts are shared between simultaneous requests. After a
provider authorization error, an explicit refresh establishes a fresh SDK
connection. Saves are never automatically retried.

Every mutation rechecks schema fingerprints and affected item versions, and
mutations for one project are serialized. Schema writes preserve permissions and
untouched source bytes. Multi-destination writes attempt rollback after failure;
an incomplete rollback is reported as a partial save with recovery item IDs.
Refresh and inspect those items in 1Password before retrying.

## Schema compatibility and limits

The integration pins `@env-spec/parser` 0.6.1 and Varlock 1.21.1. Parsing,
coercion, validation, sensitivity, and environment-dependent requirements use
Varlock's semantics. It currently uses Varlock's internal graph API, covered by
the test suite. Root metadata supports `vaultConfig`, `defaultRequired`,
`defaultSensitive`, `envFlag`, and `currentEnv`.

This release rejects plugin/import/generator/cache root decorators. Built-in
expressions are supported for resolution in locally selected, trusted schemas;
expression defaults are read-only in the editor. Renaming a schema containing
expressions requires a manual review to avoid breaking references. Schemas must
be regular files; symlinked schema files are rejected.

The SDK version-checks item updates. Item deletion has no atomic conditional
version parameter: the tool rechecks immediately before deleting, but an
external edit in that narrow interval cannot be excluded. Filesystem replacement
also has a narrow race after the final identity/fingerprint check. Do not treat
multi-destination edits as an atomic transaction.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run format:check
```

For a local Chrome test of the complete UI against a selected schema:

```bash
npm run build
npm run test:ui -- --schema ./path/to/.env.schema --headed
```

This explicit command creates one uniquely named non-secret fixture, tests
creation, masking/reveal, notes-only updates, replacement values, empty
overrides, inheritance, and confirmed deletion, and removes the fixture.
Existing item versions are checked to remain unchanged. Chrome must be installed.
If interrupted, `.local/ui-test-recovery.json` identifies only that test fixture.

The normal test suite uses a memory provider and never mutates live vaults.
To explicitly test the local desktop SDK with dedicated disposable vaults:

```bash
npm run build
npm run test:local -- --account <personal-account-uuid> --existing --hold
```

The script creates three clearly named test vaults, uses only non-secret fixture
values, checks batch reads/inheritance/empty values, editing and notes, schema
defaults, renaming/removal, stale writes, shell export, child execution, and
direnv. `--existing` additionally loads one suitable existing API Credential
vault into a child process without logging values or modifying its items.
`--hold` leaves the disposable matrix available for browser testing until Ctrl-C.
Cleanup deletes and verifies only the vault IDs created by that invocation.

Private test state lives in ignored `.local/` files. If the process is killed
before cleanup, `.local/cleanup.json` records the exact disposable vault IDs to
remove. Run `npm run test:cleanup` after renewing desktop authorization to delete
and verify those recorded test vaults. A new test refuses to overwrite pending
cleanup state. Never commit that local state.

If authentication waits or times out, unlock 1Password, approve its SDK request,
and check **Settings → Developer → Integrate with other apps**. If a vault is
unavailable, verify its ID and account selection. If a save is rejected as stale,
refresh before editing again.
