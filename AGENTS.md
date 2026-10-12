# Local installation

Use this checkout as the local installation of `envault` and
`better-env-vault`. The default setup is:

```bash
npm ci
npm run build
npm link
```

`npm link` exposes both commands globally through symlinks to this checkout.
Keep the checkout in a stable location and ensure `$(npm prefix -g)/bin` is
on `PATH`.

After changing CLI, core, or web code, run `npm run build` so the linked commands
use the updated compiled code and web assets. Linking is normally needed only
once per checkout and active Node installation; run it again after changing
Node versions or moving the checkout.

Verify installation with `envault --help` and `better-env-vault --help`.
On another computer, clone the repository and use the same setup commands.
Use this workflow by default unless the user requests a different installation
or distribution method.
