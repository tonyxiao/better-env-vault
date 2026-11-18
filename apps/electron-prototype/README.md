# Electron architecture prototype

This is an isolated proof of concept. It does not replace the shipping AppKit/WKWebView app.

The prototype verifies this proposed process layout:

```text
Electron main
├── sandboxed Chromium renderer (no Node integration)
└── Electron utility process containing @1password/sdk
```

Commands:

```bash
npm run electron:prototype
npm run electron:prototype:verify
npm run electron:prototype:package
```

`electron:prototype:verify` deliberately blocks the utility process in native-style synchronous
work. It checks that Electron reaps the process after both a normal application quit and a forced
`SIGKILL` of the main process. No application-level parent watchdog is used.

The packaged macOS prototype uses the existing Apple Development identity and hardened runtime.
Only Electron's generic utility helper receives `disable-library-validation`, because that is the
process which loads 1Password's separately signed desktop SDK library. Renderer and GPU helpers do
not receive that exception.

Current result on TX Studio: the development Electron runtime authenticated through the Xiao
desktop account. The hardened, signed helper loads the native 1Password library successfully, but
1Password denies SDK authorization without presenting a new approval prompt. The installed native
app's equivalent signed desktop-source check also fails on this Mac, so the result does not identify
an Electron incompatibility. TX M5 then timed out in Electron and failed inventory in the installed
native app immediately afterward. The remaining desktop-authentication failure is therefore the
existing intermittent 1Password desktop SDK connection, not Electron's utility-process model.
