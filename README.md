# Better Env Vault

A local environment-variable manager backed by 1Password vaults, with an
EnvKey-style view of overrides and inheritance. Browse 1Password vaults directly,
or use `.env.schema` for project configuration, validation, and inheritance.

See the [setup guide](docs/setup.md) to configure a schema, load values into a
shell or child process, and open the local web matrix. The
[implementation plan](docs/implementation-plan.md) describes the design.

For schema-based projects, the core model is:

- One vault per project environment; one API Credential item per variable.
- The schema declares the provider, account, environment vaults, inheritance,
  and variable definitions; no separate project configuration file is needed.
- Non-sensitive `.env.schema` defaults form the base layer.
- Environment vaults override those defaults in a configured fallback order.
- Secret values stay in 1Password. The schema contains definitions and optional
  non-sensitive defaults.
- A shared resolver powers both shell exports and the web app so the displayed
  effective values match the values applications receive.

Requires Node.js 22+ and 1Password desktop SDK integration or a service account.

```bash
npm ci
npm run build
npm link
envault /path/to/.env.schema
```

Run `envault` without a path to use `.env.schema` in the current directory.
If that file is absent, it discovers accessible 1Password vaults and opens each
as an independent environment in a combined searchable list with environment
filters. Use `envault --vaults` to browse vaults even in
a directory with a schema, or `envault --vaults --account <account-uuid>` to
select an account. Automatic desktop account discovery requires the `op` CLI.
The CLI opens your browser and keeps the server in the foreground; Ctrl+C or
stopping the CLI stops the server. The `better-env-vault` commands remain
available for exporting values and other operations.

Run `npm test` for the isolated test suite. Live testing uses dedicated disposable
vaults and runs only through the explicit `npm run test:local` command.
