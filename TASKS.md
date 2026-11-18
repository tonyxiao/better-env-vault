# Inbox

## Better Env Vault Electron rollout

- [x] Replace the AppKit/WKWebView shell with a signed Electron app while retaining the existing TypeScript backend and React UI.
- [x] Run each source in an Electron-managed utility process; verify cleanup after normal quit and forced main-process death without a custom watchdog.
- [x] Sandbox renderers, disable Node integration, keep Chromium data ephemeral, and persist only non-secret source metadata.
- [x] Preserve the native shell as explicit `app:native:*` rollback commands and keep its app and Keychain credential recoverable during rollout.
- [x] Build, install, and verify the production Electron app on TX Studio with live service-account inventory.
- [x] Install the Electron app on TX M5, TX MBA, and CS Mini; verify live inventory on M5 and CS Mini and the signed bundle on MBA. TX MBA still needs 1Password before desktop inventory can pass.

- [x] Bundle the existing TypeScript core, local server, React UI, runtime, authentication, schema resolution, and editing in a self-contained macOS app.
- [x] Use random loopback ports and per-launch nonce sessions; keep secrets out of logs, URLs, files, preferences, and persistent WebKit storage.
- [x] Preserve both CLI commands and add `envault app`.
- [x] Sign portable builds with Tony’s required Apple Development identity; fail if unavailable.
- [x] Install and verify the base rollout through `5b0d421` in `~/Applications` on Mac Studio, TX M5, TX MBA, and CS Mini.
- [x] Limit saved app service-account tokens to TX Studio and CS Mini; remove the accidentally copied tokens from TX M5 and TX MBA. Use desktop authentication on the laptops.
- [x] Verify Mac Studio’s 1Password desktop account is signed in.
- [x] Support multiple service-account, desktop-account, and schema sources without a four-source limit.
- [x] Add a custom macOS icon, bundle every required resolution, and install it across the Macs.
- [x] Add a custom macOS vault icon, packaged at every Dock/Finder icon size.
- [x] Keep the source switcher compact in the top-right title bar, without an extra content row.
- [x] Add source menu shortcuts, protect pending saves/drafts, and isolate source sessions.
- [x] Follow system dark mode live throughout the native shell, grids, dialogs, and editors.
- [x] Make startup discovery nonblocking and repeated reopen/source switching immediate with RAM-only stale-while-revalidate workspaces.
- [x] Terminate active, cached, and retiring loopback servers on Quit; the former native shell used a dedicated watchdog and Electron now provides lifecycle cleanup.
- [x] Verify editing, notes, search, masking, project/schema modes, source switching, dark mode, and warm reuse with isolated fixtures.
- [x] Run formatting, type checking, the complete isolated suite, production build, CLI checks, signature/requirement/entitlement checks, live inventory, shutdown, and storage checks.
- [x] Document reproducible build, installation, authentication, and performance behavior.
- [x] Commit and push the completed implementation to `main`.
- [x] Install the compact-switcher, account-name setup, and icon update on all four Macs; verify signatures everywhere and live service-account catalog loading on Studio and CS Mini. Laptop desktop-SDK verification is tracked below.
- [x] Verify TX M5 desktop SDK access twice after restarting 1Password, including full catalog UI, warm reopening, shutdown, and storage checks; open the normal app and save only the native account name.
- [ ] Verify TX MBA desktop access after installing/signing into 1Password there; its SDK library is absent. Optional Studio desktop verification also needs local authorization. Studio and CS Mini primary service-account paths pass.
- [x] Commit and push the follow-up fixes and credential-placement correction.
- [ ] Cover all four Macs in the optional shared-Keychain provisioning profile, without distributing service-account credentials. Correct Provisioning UDIDs are collected; Apple API device registration currently returns HTTP 403. Portable signed builds already run on all four Macs.
