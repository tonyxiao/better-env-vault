# Better Env Vault implementation plan

## Outcome

Build a standalone local tool that uses 1Password vaults as environment
boundaries. A shell helper loads fresh values into a terminal or direnv. A small
web app shows the same effective values, their origins, missing keys, and
overrides, and writes edits to 1Password and the project's
`.env.schema`.

This repository owns the tool. Projects consuming it do not need to adopt a
particular web framework or change their existing application architecture.

## Agreed requirements

1. Use ordinary 1Password vault items, with a vault for each environment and an
   item title matching the environment-variable name.
2. Store a variable's value in the API Credential item's `credential` field.
   `/key` has no special meaning in a 1Password reference; field names and IDs
   identify the field to read.
3. Retain useful, user-authored item notes. Do not generate migration notes or
   automatically apply tags.
4. Support a configurable fallback chain. For example, staging falls back to
   development, and production falls back to staging and then development.
5. `.env.schema` is the sole project configuration and the source of truth for
   variable definitions, provider/account selection, environment vault mappings,
   and inheritance. Its non-sensitive defaults form the base value shared by
   every environment. No separate project configuration file is required.
6. Keep sensitive values in 1Password. Permit editing non-sensitive defaults in
   `.env.schema` itself.
7. Export values for shell use without generating a plaintext secrets file.
8. Provide an EnvKey-style matrix with inherited versus explicit values and
   clear provenance, plus editing of vault values and schema definitions.
9. Use one resolution engine for the exporter and UI.

## Scope of the first release

### Included

- Node.js 22+ and npm, with a checked-in lockfile.
- A 1Password provider using desktop authentication or a service-account token.
- Project settings in `.env.schema`, mapping named environments to explicit
  vault IDs.
- Configurable environment parents and cycle detection.
- A required `.env.schema`, discovered in the current directory or selected by
  an explicit CLI schema path.
- Shell exports, direnv integration, and running a child command with resolved
  variables.
- A local web app for the environment matrix, definition editing, overrides,
  notes, and removing overrides to restore inheritance.
- Schema validation and actionable configuration errors.
- Secret-free diagnostics and tests.

### Deferred

- Hosting the app publicly or building a shared authentication system.
- Providers other than 1Password.
- Automatic secret rotation and provider-specific credential generation.
- Bidirectional background synchronization or replacing a running process's
  environment when secrets change.
- Bulk environment cloning, account administration, and vault deletion.

## Data model

### Project configuration

Use `.env.schema` as the only declarative project configuration. Store project
settings in its root-level metadata alongside the variable definitions. Do not
introduce `better-env-vault.config.json`, a separate project registry, or a
second source of truth for project settings.

The root metadata must describe:

- Configuration format version and an optional project display name.
- Provider selection and the 1Password account boundary.
- Named environments and their explicit vault IDs.
- The optional parent of each environment and optional default environment.
- Any explicit legacy field mappings or other project-specific provider options.

For example, a schema can describe dev mapped to `<dev-vault-id>`, staging
mapped to `<staging-vault-id>` and extending dev, and prod mapped to
`<prod-vault-id>` and extending staging, all under `<1password-account-id>`.
Finalize the root decorator syntax after verifying Env Spec/Varlock extension
support; these are configuration requirements, not a new schema syntax.
Tool metadata must not become exported environment variables or execute code
merely to discover project settings.

Discover `.env.schema` in the current working directory by default. An explicit
`--schema` path selects another project's schema; it does not supply additional
project settings. Resolve relative paths from the schema's directory. A missing
schema is an actionable error; do not derive an implicit project from vaults.

The schema must not contain secret values or authentication tokens. Vault IDs
avoid accidental selection of a same-named vault in another account. Account selection must be
explicit for desktop authentication; a service account's scope supplies its
account boundary and must still be checked against configured vaults.

Each schema describes one independent project. Do not infer inheritance
between vaults merely because their variable names overlap. An environment chain must resolve
within one project, be acyclic, and reference configured environments only.

The initial implementation should support one parent per environment. A linear
parent chain covers the requested behavior without introducing ambiguous merge
ordering between multiple parents.

### Vault items

- Item category: API Credential.
- Item title: an environment-variable name matching
  `[A-Za-z_][A-Za-z0-9_]*`.
- Value: the standard `credential` field, including explicit empty strings.
- Notes: user-authored operational notes for that environment's override.
- Identity and concurrency: retain item ID and item version internally.

Ignore non-API-Credential items such as Secure Notes when constructing the
variable catalog. Report API Credential items with invalid names or missing
credential fields as configuration errors. Never silently select the first of
two items with the same variable name.

New values use `credential`; pre-existing fields named `key` may be supported
only through an explicit legacy mapping or a reviewed normalization operation.
Do not guess which of several concealed fields is the intended value.

### Schema definitions

Each definition contains:

- Variable name.
- Description from its associated comments.
- Type and validation decorators.
- Required status, including supported environment-dependent requirements.
- Sensitivity/public status.
- Optional non-sensitive default.

Use the Env Spec parser used by Varlock to understand `.env.schema`, and use
Varlock's validation semantics rather than maintaining a competing set of type
rules. Pin the integration versions and verify the APIs before implementation;
Varlock currently exposes some graph-loading operations as internal APIs.

Preserve root decorators, unrelated comments, expressions, quoting, multiline
values, line endings, and definitions that an edit does not affect. Prefer
source-range edits followed by a fresh parse over reserializing the entire
file. If a construct cannot be safely edited, explain the limitation and keep
that construct read-only rather than rewriting it incorrectly.

Treat schema expressions and plugins as code: execute them only for an
explicitly selected, trusted project. The UI must not accept arbitrary server
filesystem paths from an untrusted request. Schema paths selected at local
server launch identify the projects available in that server session. Keep this
allowlist in memory; every project's settings still come from its own schema.

## Resolution behavior

For a production environment that extends staging, which extends dev:

```text
schema defaults → dev vault → staging vault → prod vault
```

Apply these rules:

1. Begin with the schema's defaults.
2. Apply parent vaults from oldest ancestor to nearest parent.
3. Apply the selected environment's explicit values last.
4. Absence means inheritance. An explicit empty value overrides a parent and
   is then validated; it must not be mistaken for absence.
5. A missing required variable is an error. Do not export an incomplete
   configuration as though it were valid.
6. A present override equal to its parent value is still an explicit override.
   The UI may label it redundant, but must not automatically delete it.
7. Only declared keys belong to the effective catalog. Show extra
   vault items separately as unmanaged and offer an explicit adoption action.
8. Do not silently use unrelated values already present in the caller's shell
   to satisfy missing vault or schema values.

Return internal resolved records containing the value, source layer,
source item ID, explicit/inherited/missing status, sensitivity, and validation
result. Browser responses omit sensitive values unless the user explicitly
reveals one. Error messages must not include the value that failed validation.

This provenance is essential: the web app should explain the exact resolution
used by the shell helper rather than implementing its own approximation.

## Architecture

Suggested structure:

```text
packages/core/        Schema configuration, provider, resolver, edit operations
packages/cli/         Exporter, run command, validation, provenance output
apps/web/            Local API server and environment-management UI
tests/               Resolution, schema editing, provider, API, and UI tests
docs/                Setup and operating instructions
```

Use TypeScript for the shared code. A small React/Vite UI is a reasonable
starting point; the local API server can use Node's HTTP interfaces. No
production deployment or external database is required for the first release.
Keep UI and server frameworks out of the core package.

### 1Password access

Prefer the official 1Password SDK for provider reads and writes where its
documented APIs support the required operations. Investigate batch item reads
and use bounded concurrency for independent reads, instead of launching a CLI
process for each field. An adapter for the installed `op` CLI is an acceptable
fallback.

Before implementation, verify SDK support for item listing, item versions,
creation, updates, deletion, notes, and desktop authentication. Do not infer
methods from the Environment API: native Environments and ordinary vault
items have different capabilities.

Authentication options:

- Desktop app: authenticate through 1Password and let it control authorization
  prompts. Reuse one provider session for the tool's lifetime.
- Service account: read `OP_SERVICE_ACCOUNT_TOKEN` from the server/CLI process
  environment. Require access only to the configured vaults; writes need the
  appropriate vault permissions.

Never request a token through the browser or persist it in project
configuration. Do not log SDK responses, CLI stdout, item JSON, secret values,
or credential-bearing child-process errors.

If the CLI adapter sends JSON over stdin, test it on macOS: the migration
experiment showed that Node's socket-backed child stdin can cause `op` to
ignore the supplied template. Use a verified supported stdin mechanism or the
SDK; do not fall back to putting secret values in command arguments or files.

## Shell helper and direnv

Proposed command surface, to be finalized during implementation:

```bash
better-env-vault export --environment dev --format shell
better-env-vault export --environment prod --format direnv
better-env-vault run --environment staging -- npm run dev
better-env-vault explain --environment prod
better-env-vault check --environment prod
```

These commands use the current directory's `.env.schema`. Use
`--schema ./path/to/.env.schema` to select another project. Environment selection
is a runtime choice among the environments declared in that schema; if omitted,
use its declared default or require an explicit selection. CLI flags must not
override account, vault, inheritance, or other declarative project settings.

`export` resolves and validates the full selected configuration before writing
anything to stdout. Failure must not emit a partially usable shell script.

Shell output uses literal, safely quoted `export NAME=VALUE` statements. It
must preserve spaces, quotes, dollar signs, backticks, backslashes, Unicode,
empty strings, and multiline values without executing value content. Reject
values containing NUL because process environments cannot represent them.

The `direnv` output mode runs `direnv dump` in a child process supplied with the
resolved environment. Use direnv's own format rather than implementing its
encoding. A stable `.envrc` can then use:

```bash
direnv_load better-env-vault export \
  --environment dev \
  --format direnv
```

For Bash/Zsh shells, a direct source workflow can use:

```bash
source <(better-env-vault export \
  --environment dev \
  --format shell)
```

Document that process-substitution failures do not reliably propagate through
`source`; direnv or `run` is preferred when startup must fail on invalid config.
Also provide a guarded in-memory sourcing example that checks the exporter's
exit status before evaluating its safely quoted output.

Fresh values are fetched on each load or explicit reload. This does not
continuously mutate an already running application. `direnv reload` refreshes
the shell, and applications need a restart to receive the new environment.

An `explain` command shows variable names, provenance, validation, and override
status without printing secret values. Diagnostic output belongs on stderr;
stdout in export mode must contain only the intended shell or direnv payload.

## Web app

### Main view

- Project switcher and connection status.
- Selected schema path and the project settings declared in its root metadata.
- Columns for schema default and each configured environment.
- Rows for declared variables, with description, type, required status, and
  sensitivity.
- Cell states: explicit override, inherited from a named layer, schema default,
  missing, and invalid.
- Search, and filters for missing values, invalid values, overrides, and
  unmanaged vault items.
- A visible refresh control; changes elsewhere in 1Password are reflected
  after refresh, without a secret cache on disk.

Show non-sensitive values directly. Sensitive cells display a fixed mask so
length is not disclosed. Only explicit user reveal retrieves a secret for that
cell; keep it transient and clear it when the editor closes or project changes.

### Cell editor

Open a drawer that shows the variable's definition, effective source, parent
chain, current explicit status, and selected edit destination.

Actions:

- Set or replace an explicit value in the selected environment's vault.
- Edit user-authored notes on the selected override item.
- Remove an override to inherit from its parent or the schema default.
- Edit a schema default for a non-sensitive variable.
- Edit its schema name, description, type, required status, and sensitivity.
- Add a variable, register it in the schema, and optionally set
  values in selected environments.
- Adopt an unmanaged item into the schema.

Separate editing an explicit value from editing the effective inherited value.
The default action on an inherited cell creates an override in the selected
environment. Editing the source layer instead must be an explicit choice.

### Edits and persistence

The edit destination determines what is written:

| Edit                               | Vault change                                       | Schema change                                                |
| ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| Sensitive environment value        | Create/update `credential`                         | Ensure its definition exists; never write the literal secret |
| Non-sensitive environment override | Create/update `credential`                         | Ensure its definition exists; leave the base default alone   |
| Non-sensitive base/default value   | No environment override is created                 | Update the variable's default                                |
| Definition metadata                | Change item titles if the variable is renamed      | Update associated comments/decorators/name                   |
| Environment-specific notes         | Update that item's notes                           | None; do not duplicate notes into global descriptions        |
| Remove an override                 | Delete the selected vault item                     | Retain the definition and default                            |
| Delete a variable everywhere       | Delete its items from every configured environment | Remove its definition after explicit confirmation            |

For a rename, prepare the full operation across all configured environment
vaults and the schema. Reject destination-name collisions before writing.
Changing sensitivity must not silently move a secret into a schema default.

Project-setting edits update the schema's root metadata with the same
preservation and concurrency protections as definition edits. An explicit
initialization command can create a schema with project settings and definitions,
but must not copy sensitive values into the new file. Normal operation requires
that schema; vault contents alone do not define a project.

### Consistency and conflicts

1Password and the filesystem cannot be updated in one atomic transaction.
The UI must represent that honestly.

- Carry schema fingerprints and item versions with edit forms.
- Re-read/check both immediately before writing and reject stale edits.
- Serialize mutations per project in the local server.
- Prepare and validate the intended schema text before changing vault items.
- Apply vault changes, then atomically replace the schema file when required.
- Attempt safe rollback using prior values held only in memory if a later step
  fails, and avoid overwriting intervening changes during rollback.
- If rollback is incomplete, return a partial-save result with affected item
  IDs and clear recovery instructions. Do not show a successful save until
  all requested destinations are verified.
- A no-op edit should not rewrite the schema or bump vault versions.

Schema writes must preserve file permissions and check file identity, content
fingerprint, and relevant symlinks before replacement. Never overwrite another
editor's changes or allow an API request to choose an arbitrary output path.

## Local server boundary

The tool has access to secrets and can modify vaults and local schema files.
Treat this as a local privileged application:

- Bind to loopback by default; do not listen on every interface.
- Validate the Host header and reject unexpected origins to prevent DNS
  rebinding and cross-site access.
- Use a random per-launch browser session credential and a mutation token.
  Keep tokens out of logs and URL history; establish the session through an
  intentional local launch flow.
- Use no permissive CORS policy. Require the session for reads as well as
  writes; revealing values requires an explicit authenticated request.
- Mark responses `Cache-Control: no-store`. Do not put secrets in URLs,
  browser storage, analytics, screenshots, or error messages.
- Return masked metadata from the matrix API; provide a separate explicit
  reveal endpoint.
- Escape all variable names, notes, descriptions, and defaults in the UI.
- Bound request sizes and validate every mutation payload and target against
  configured projects/vaults/definitions.

The first release is not suitable for public deployment. Remote or multi-user
operation requires a separate authentication, authorization, and deployment
design.

## Delivery phases

### Phase 1: Core model and provider

- Bootstrap the standalone npm workspace and shared TypeScript package.
- Implement schema root-metadata parsing, project/account/vault scoping, parent-chain
  validation, item normalization, and the 1Password adapter.
- Add the schema adapter and shared resolver with provenance.
- Verify desktop and service-account access without writing real secret values
  to test output or files.

Acceptance: resolve one real project and print only key names, counts,
provenance, and validation status. Confirm duplicate names, parent cycles,
missing fields, and authentication failures produce actionable errors.

### Phase 2: Export helper

- Implement `export`, `run`, `check`, and `explain`.
- Support a single vault as well as configured fallback chains.
- Implement safe shell quoting and direnv output via `direnv dump`.
- Document `.envrc` setup, service-account tokens, desktop authorization,
  refreshing values, and app restarts.

Acceptance: a child process receives the expected resolved values; direnv
loads/unloads them correctly; secret content cannot execute shell commands;
invalid config emits no partial export.

### Phase 3: Read-only matrix

- Build the local session-protected API and project selector.
- Build the matrix, provenance drawer, filters, masked values, and explicit
  reveal flow.
- Show unmanaged keys separately from schema definitions.

Acceptance: matrix resolution matches CLI resolution for every environment;
the default matrix response contains no sensitive values; empty and missing
values appear differently.

### Phase 4: Vault and schema editing

- Add per-environment overrides and notes, schema definition/default editing,
  adoption, renaming, and override removal.
- Add concurrency guards, atomic schema writes, coordinated operations, and
  partial-save recovery.
- Require confirmation for deleting a variable from all environments.

Acceptance: edits are verified in their requested 1Password/schema destinations;
the CLI sees them on its next load; required/sensitivity rules are honored;
the UI rejects stale edits without clobbering either destination.

### Phase 5: Verification and polish

- Run focused tests, type checks, formatting, and production builds.
- Exercise the real local UI and export flow against an explicitly created
  disposable test vault, using non-secret test values.
- Verify cleanup of disposable test items and vaults.
- Write setup, troubleshooting, and schema-format compatibility documentation.

## Tests that matter

- Resolution: schema default, each parent layer, explicit empty values,
  identical-but-explicit overrides, missing required values, project isolation,
  duplicate titles, and parent cycles.
- Schema: parsing real Varlock syntax, preservation of untouched bytes and
  advanced constructs, non-sensitive defaults, prevention of secret literals,
  invalid metadata edits, rename conflicts, and concurrent file changes.
- Configuration: all project settings load from schema root metadata, missing
  schemas fail clearly, project metadata is excluded from exports, and CLI/UI
  environment selection uses only environments declared in the selected schema.
- Export: hostile shell characters, multiline values, Unicode, NUL rejection,
  no partial stdout on failure, inherited-shell contamination, and direnv
  integration.
- Provider: account/vault isolation, authentication failures, bounded reads,
  version conflicts, field validation, and no secret-bearing diagnostics.
- Editing: create/update/remove override, note preservation, correct default
  destination, coordinated schema/vault failures, and honest partial results.
- Local API: session requirements, origin/Host checks, path restrictions,
  request limits, and secret-free metadata responses.
- UI: effective-source display, create-override versus edit-source choices,
  keyboard access, loading/authentication states, and error recovery.

Do not run live provider mutations in the normal test suite. Integration writes
use a dedicated disposable vault and happen only when explicitly requested.

## Decisions to verify during implementation

These are implementation investigations, not blockers to the agreed design:

- Exact official SDK batch-read and concurrency behavior, version-checked write
  support, and deletion semantics.
- Stable parser and Varlock integration APIs, including how to preserve source
  spans and validate a proposed schema edit without executing unwanted plugins.
- Root decorator syntax and extension support for all project settings in
  `.env.schema`, without introducing a separate configuration file.
- The precise set of supported schema decorators and which advanced definitions
  should initially be read-only in the editor.
- Packaging the CLI so projects can install it without depending on this repo's
  development tools.
- A local launch/session mechanism that works with the chosen browser and
  development preview while preserving loopback and origin protections.
