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

This is the default local installation workflow. Linking exposes `envault` and
`better-env-vault` through symlinks to this checkout. After source changes, run
`npm run build` to update the installed commands; linking is normally needed
only once per checkout and active Node installation. Keep the checkout in a
stable location and ensure `$(npm prefix -g)/bin` is on your `PATH`. On another
computer, clone the repository and repeat these setup commands.

Run `better-env-vault --help` for the available commands. For development, use
`npm run dev -- <command>` without linking.

## Browse vaults without a schema

```bash
envault                               # browses vaults when .env.schema is absent
envault --vaults                      # always browse vaults
envault --vaults --auth desktop --account <account-uuid>
envault --vaults --auth service-account --service-account-keychain <entry-name>
```

Desktop discovery uses `op account list --format json` to find accounts, then
connects through the SDK to list each account's accessible vaults. `--account`
or `OP_ACCOUNT` selects one account and does not require the `op` CLI.
`OP_SERVICE_ACCOUNT_TOKEN` or `--service-account-keychain` instead selects
service-account authentication and lists only the token's accessible vaults.
Use `envault auth store <entry-name>` to store a token through stdin as described
below.

The secrets list shows every accessible environment together. Each vault is an
isolated environment; matching names in different vaults appear as separate
rows with their environment labels. Search secret names, environment names, notes, and account metadata across the
combined list. Click column headers to sort ascending or descending; Ctrl/Cmd-click
adds a secondary sort. Values can be sorted after revealing them. Environment filter buttons support
multiple selections; **All environments** clears the selection. Filtering and
search run locally. **Refresh** rescans environments and reloads their secrets.

Reads run two vaults at a time and use the existing 30-second memory cache. A
malformed or inaccessible vault reports an error beside the combined list while
other environments remain available. Values stay masked by default. Revealing
all values reveals the selected environments; hiding values or changing
filters clears revealed values. Already opened cells reuse their values in
browser memory for immediate reopening, without exposing them in the masked
list. Refresh, hiding values, changing environment filters, and connection
errors clear that cache; saves invalidate the edited cell. Nothing is persisted
to browser storage. After the server's vault snapshot expires, a single-cell
reveal reads only the selected credential through the SDK.

Notes are visible in their own grid column and support inline editing, including
multiline text with Shift+Enter or Alt+Enter. Enter saves the note. Notes-only saves preserve the credential value
and do not require revealing it. Secret values remain masked until opened or
explicitly revealed.

The grid supports keyboard navigation, inline editing, reveal/hide, adding
variables, and confirmed single or bulk deletion. Each row edit, rename,
or deletion affects only its own environment. Creating a secret asks which
environment it belongs to. Bulk deletion groups selected rows by environment,
checks versions, and processes each environment separately. All values are
treated as sensitive. No schema file is written, and there are no defaults, inheritance, type decorators, or
schema settings. Bulk deletion checks versions before removing any items and
attempts restoration on failure.

As in schema mode, variables are API Credential items with an environment-variable
name and a single `credential` field. Login and other item categories are not
environment variables and are excluded. A vault with invalid or duplicate API
Credential names reports an error for that vault; other vaults remain available.
Notes are included in the authenticated grid response. Secret values are
returned only by the protected reveal flow.

An explicit schema path must exist and be valid; a missing or invalid supplied
schema never falls back to vault discovery. Export, check, explain, and run still
use `.env.schema` for validation and environment resolution.

The initial loading view uses the mode selected at launch. Vault browsing never
falls back to a schema view while waiting for 1Password. Visible loading
indicators distinguish browser connection, initial secret loading, refreshes,
and value reveals; field spinners show saves in progress. Schema mode also
shows a loading state before its environment values are ready.

### 1Password connection modes

Envault connects directly to 1Password through `@1password/sdk`; its local web
server is an HTTP application server, not an MCP server. No MCP connection is
configured or implied by either authentication mode.

`--auth desktop` explicitly selects desktop authentication, even if an ambient
`OP_SERVICE_ACCOUNT_TOKEN` is present. `--auth service-account` explicitly selects
service-account authentication; provide the token through the process
environment or a named macOS Keychain entry. If `--auth` is omitted, a token or
Keychain entry selects service-account mode, otherwise desktop mode is used.
Authentication options apply to `--vaults`; schema mode uses the schema's
settings.

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
# @vaultConfig={
#   version=1,
#   name='Example',
#   provider='1password',
#   account='<account-uuid>',
#   auth='desktop',
#   defaultEnvironment='dev',
#   environments={
#     dev={
#       vault='<dev-vault-id>',
#     },
#     staging={
#       vault='<staging-vault-id>',
#       extends='dev',
#     },
#     prod={
#       vault='<prod-vault-id>',
#       extends='staging',
#     },
#   },
# }
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

`@vaultConfig` is Better Env Vault's custom project-metadata decorator. It is
parsed by `@env-spec/parser`, then validated and interpreted by Better Env Vault;
it is not a built-in Env Spec or Varlock project configuration feature.

New schemas and project-settings saves use the parser's native multiline object
syntax: `key=value`, comma-separated fields, nested braces, and `#` on every
continuation line. Values must be static; resolver functions and interpolation
are rejected in project metadata. The previous single-line JSON-string form
remains supported. Because native object keys only support letters, digits, and
underscores, projects with hyphens in environment names retain the JSON form.

It supports:

| Setting                  | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `version`                | `1`                                                                             |
| `provider`               | `1password`                                                                     |
| `account`                | Desktop account UUID/name; service-account account boundary metadata            |
| `auth`                   | `desktop` (default) or `service-account`                                        |
| `name`                   | Optional project display name                                                   |
| `serviceAccountKeychain` | Optional macOS Keychain entry name for service-account authentication           |
| `defaultEnvironment`     | Optional environment used when `--environment` is omitted                       |
| `environments`           | Named environments, each with a unique `vault` ID and optional `extends` parent |
| `legacyFields`           | Optional mapping of variable names to pre-existing field IDs                    |

Keep a `# ---` divider between the header and variable definitions so the first
variable's comments belong to that variable. New schemas default to treating
values as sensitive; mark non-sensitive definitions `@public` before adding
literal defaults. Sensitive literal defaults are rejected, even if a vault
override shadows them. Secret values belong in 1Password; authentication tokens
belong in macOS Keychain or the process environment, never in the schema.

For service-account authentication, set `auth` to `service-account` in the
schema. Supply `OP_SERVICE_ACCOUNT_TOKEN` to the CLI/server process, or use
`serviceAccountKeychain` to select a macOS Keychain entry. The SDK verifies every configured vault
against the authenticated account's accessible vaults. Provider credentials are
not implicitly forwarded to commands run by this tool.

For macOS Keychain storage, stream the token directly into `envault`:

```bash
op service-account create envault-testing --account <account> \
  --vault <dev-vault-id>:read_items,write_items \
  --vault <staging-vault-id>:read_items,write_items \
  --vault <prod-vault-id>:read_items,write_items \
  --expires-in 24h --raw | envault auth store envault-testing
```

Then set these fields inside the schema's `@vaultConfig` object:

```dotenv
#   auth='service-account',
#   serviceAccountKeychain='envault-testing',
```

`envault` retrieves the token through the native macOS Keychain API and passes it
to the SDK in memory. Tokens are not accepted as command arguments, printed,
written to the schema, or sent to the browser. An explicit Keychain reference
selects that entry instead of `OP_SERVICE_ACCOUNT_TOKEN`, and a missing or
inaccessible entry fails without falling back to desktop authorization. macOS
may ask you to authorize Keychain access. Only the entry name is project metadata.

`envault auth remove envault-testing` removes the local credential; it does not
revoke the service account in 1Password. Revoke it in 1Password or let its
configured expiry elapse. Service-account tokens cannot create more service
accounts; initial creation requires your user account authorization.

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
envault /path/to/.env.schema
envault # uses .env.schema in the current directory

# Open multiple projects in one session:
better-env-vault serve --schema ./project-a/.env.schema ./project-b/.env.schema
```

`envault` binds to loopback and opens a one-time browser launch link. The
server runs inside the CLI process: Ctrl+C, SIGTERM, or closing its terminal
stops the server and closes its active connections. No background daemon is
started. Use `--port 4187` to choose a port; otherwise an available port is used. The browser
clears the link's fragment immediately, exchanges it for an HttpOnly session
cookie, and keeps the mutation token in memory. Each new browser needs its own
one-time link. In the running server's terminal, type `link` to obtain a fresh
link or `open` to open your default browser. Links expire after five minutes;
issuing another does not disconnect existing browsers. For manual launch:

```bash
envault ./path/to/.env.schema --no-open --print-launch-url
```

Copy the one-time link into the browser you want to connect. Opening the plain
address does not authenticate a new browser. The app validates Host and Origin,
requires a session for all API reads, and sends no-store responses.

Each loaded `.env.schema` is a separate schema/workspace. With one schema, the
header shows its display name and file path directly. A **Schema** chooser only
appears when multiple files are loaded; it switches files, not environments.
Environments are the grid columns. **Schema settings** edits that file's
`@vaultConfig` header.

Each environment header has a **Vault info** icon. Hover or focus it to see the
exact 1Password vault name and full vault ID. Names come from the authenticated
1Password API and refresh along with the matrix; they are not inferred from
environment labels. The schema-default column has no vault.

The matrix shows schema defaults, explicit overrides, inherited values, and
missing/invalid values. Search by name or description and filter missing,
invalid, or overridden values. Sensitive cells use a fixed mask. **Reveal
current value** retrieves only the selected cell; closing the editor or changing
projects discards the revealed value.

The eye icon toggles **Reveal all values** / **Hide all values** for the current
project, including every environment column. Revealed values stay only in memory
and are cleared when hidden, on project changes, or after connection errors.
Labels consistently show **Inherits schema default**, **Inherits dev** (or the
actual source environment), and **Explicit override**.

The matrix uses React Data Grid with a frozen variable column on wide screens, resizable
columns, virtualized rows, and keyboard cell navigation. Click a value, or press
Enter/F2 on a selected cell, to edit. Rows keep the same compact height while
editing, loading, saving, and reporting errors. Arrow keys move between cells.
Enter saves and moves down; Shift+Enter moves up. Tab saves and moves across;
Shift+Tab moves backward. Clicking another grid cell commits a changed draft.
Ctrl/Cmd+Enter saves in place, Escape cancels, and Alt+Enter inserts a literal
newline. Unchanged inherited/missing cells are never written just by navigating.
Clearing a previously populated cell saves an explicit empty override if the
schema permits it; an already empty cell needs explicit empty-value intent. Use the details drawer for larger
values and notes. Public schema defaults also support inline edits.

Saves run in the background with a spinner in the affected field. You can keep
editing another field, search/filter, hide values, or switch projects while a
save runs. A background refresh preserves the active draft. Errors appear in the
field with a retry action; reopening the editor restores its failed draft for
correction. Pending sensitive values remain masked when visibility is turned
off. Every save still validates the schema fingerprint and item versions; writes
are not automatically retried.
Use a cell's details icon for notes, definition editing, renaming, deletion, and
override removal. Existing notes are
preserved unless edited. Reveal the current value to edit existing notes. An
inherited cell creates an override in the selected environment; **Edit source
environment** deliberately targets the ancestor instead. **Remove override**
restores inheritance.

To remove entire variables, select their row checkboxes and choose **Delete
selected** in the action bar below the grid. Shift-click selects a range; the
header checkbox selects visible/filtered rows. Review the selected names and
type `DELETE` once to confirm. This removes both schema definitions and their
items from every configured vault. It does not delete the vaults themselves.
**Clear selection** clears the action bar. The existing details editor's
**Delete everywhere** action is also available for a single variable.

Bulk deletion checks every selected item's version before removing anything,
uses the same per-schema write queue as other edits, and rejects deletions that
would break remaining expression references. On failure it attempts to restore
removed items before reporting the error. A partial rollback is reported for
manual recovery. Up to 200 variables can be deleted in one confirmed batch.

The editor also supports public schema defaults, descriptions, types, required
and sensitive status, renaming across vaults, and confirmed deletion everywhere.
**Add variable** creates a definition and an initial value in the selected
environment in one save. Turn off **Set an initial environment value** to create
only a definition. Sensitive values are written to 1Password, never to the schema.
You can update an override's notes without revealing or replacing its value.
To deliberately clear a value, select **Set an explicit empty value**; use
**Remove override** to restore inheritance instead.
**Adopt into schema** registers unmanaged items without copying their values.
**Schema settings** edits `@vaultConfig` in the schema header.

The UI uses React Data Grid for the matrix and shadcn/ui components, Radix
primitives, Tailwind CSS, and Lucide icons for its controls.
Revealing the matrix keeps raw editable values in browser memory, so opening an
inline editor reuses the loaded value. Search, filters, and hide/show interaction
run locally. Browser values are never stored in localStorage or on disk.

The local server caches resolved vault snapshots in process memory for 30 seconds
and shares in-flight reads. **Refresh** bypasses that cache, so external 1Password
changes appear immediately when requested. Saves invalidate cached snapshots;
schema changes and provider errors also force new reads. Cached snapshots expire
and are dropped from the server cache. CLI loads and mutation checks always read
fresh values from 1Password. Hiding values clears the browser's revealed matrix;
server memory follows its separate 30-second expiry.

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

`npm run test:vaults` verifies discovery, vault isolation, search, inline editing,
masking, empty vaults, creation, renaming, and deletion using a memory provider.
It requires local Chrome and never accesses 1Password.

`npm run test:matrix` checks global reveal/hide, cached inline editing, create/delete,
explicit empty values, drawer focus, mobile layout, CSP, and inheritance
labels, cancellation, and late-response masking using a memory provider. It
requires local Chrome and never accesses 1Password.

`npm run test:grid` deliberately delays and rejects requests to verify field
spinners, concurrent edits, draft preservation, masking during saves, keyboard
navigation, failed-value recovery, and project isolation. It also uses a memory
provider and never contacts 1Password.

`npm run test:bulk-ui -- --schema ./path/to/.env.schema` explicitly verifies
selection, vault metadata tooltips, and confirmed bulk deletion against live
1Password using two uniquely named, non-secret fixtures. It removes the fixtures
and checks that original item versions are unchanged. If interrupted, recovery
names remain in `.local/bulk-ui-recovery.json`.

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
