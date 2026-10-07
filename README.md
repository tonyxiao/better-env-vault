# Better Env Vault

A local environment-variable manager backed by 1Password vaults, with an
EnvKey-style view of overrides and inheritance. `.env.schema` is the sole
project configuration and variable catalog.

See the [setup guide](docs/setup.md) to configure a schema, load values into a
shell or child process, and open the local web matrix. The
[implementation plan](docs/implementation-plan.md) describes the design.

The core model is:

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
better-env-vault --help
```

Run `npm test` for the isolated test suite. Live testing uses dedicated disposable
vaults and runs only through the explicit `npm run test:local` command.
