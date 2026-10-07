# Better Env Vault

A local environment-variable manager backed by 1Password vaults, with an
EnvKey-style view of overrides and inheritance. `.env.schema` is the sole
project configuration and variable catalog.

The project is currently in planning. See the
[implementation plan](docs/implementation-plan.md) for the data model, exporter,
web app, editing behavior, and delivery phases.

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

No implementation or live credentials are included yet.
