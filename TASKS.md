# Inbox

## Better Env Vault macOS rollout

- [x] Bundle the existing TypeScript core, local server, React UI, runtime, authentication, schema resolution, and editing in a self-contained macOS app.
- [x] Use random loopback ports and per-launch nonce sessions; keep secrets out of logs, URLs, files, preferences, and persistent WebKit storage.
- [x] Preserve both CLI commands and add `envault app`.
- [x] Sign portable builds with Tony’s required Apple Development identity; fail if unavailable.
- [x] Install and verify the base app in `~/Applications` on Mac Studio, TX M5, TX MBA, and CS Mini.
- [x] Provision service-account authentication securely on all four Macs, with desktop fallback when no token is configured.
- [x] Verify Mac Studio’s 1Password desktop account is signed in.
- [x] Support multiple service-account, desktop-account, and schema sources without a four-source limit.
- [x] Add source menu shortcuts, protect pending saves/drafts, and isolate source sessions.
- [x] Follow system dark mode live throughout the native shell, grids, dialogs, and editors.
- [x] Make startup discovery nonblocking and repeated reopen/source switching immediate with RAM-only stale-while-revalidate workspaces.
- [x] Terminate every active and cached loopback server on Quit.
- [x] Verify editing, notes, search, masking, project/schema modes, source switching, dark mode, and warm reuse with isolated fixtures.
- [x] Run formatting, type checking, the complete isolated suite, production build, CLI checks, signature/requirement/entitlement checks, live inventory, shutdown, and storage checks.
- [x] Document reproducible build, installation, authentication, and performance behavior.
- [x] Install and verify the completed update on all four Macs.
- [x] Commit and push the completed implementation to `main`.
- [ ] Resolve external 1Password desktop SDK authorization for live desktop inventory on Mac Studio. The account is signed in, but UUID and account-name verification fail; service-account SDK inventory and source switching pass. Computer Use currently times out when accessing 1Password.
