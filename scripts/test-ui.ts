/** Explicit browser CRUD smoke test. Only the generated fixture is mutated. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { chromium, type Browser, type Page } from "playwright-core";
import { startServer } from "../apps/web/src/server.js";

const options = new Command()
  .option("--schema <path>", "Start a local app using this schema")
  .option(
    "--launch-file <path>",
    "Use a privately stored launch URL for an existing app",
  )
  .option("--headed", "Show the local Chrome verification window")
  .parse()
  .opts();
if (!!options.schema === !!options.launchFile)
  throw new Error("Select exactly one of --schema or --launch-file.");
const fixture = `BEV_UI_TEST_${randomUUID().replaceAll("-", "").toUpperCase()}`;
const firstValue = "non-secret-initial-browser-fixture";
const updatedValue = "non-secret-updated-browser-fixture";
const prodValue = "non-secret-prod-browser-fixture";
const recoveryPath = resolve(".local/ui-test-recovery.json");
await mkdir(".local", { recursive: true, mode: 0o700 });
let ownApp: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Browser | undefined, page: Page | undefined;
let token = "",
  base = "",
  project = "",
  matrix: any;
let created = false,
  deleted = false;
async function api(path: string, data?: unknown) {
  const response = await page!.request.fetch(base + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Origin: base,
      ...(data === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Bev-Mutation": token }),
    },
    ...(data === undefined ? {} : { data }),
    timeout: 120_000,
  });
  const result = await response.json();
  if (!response.ok())
    throw new Error("The local API could not complete browser verification.");
  return result;
}
async function getMatrix() {
  return api(`/api/matrix?project=${encodeURIComponent(project)}`);
}
async function saved() {
  await page!
    .getByRole("dialog")
    .waitFor({ state: "hidden", timeout: 120_000 });
  await page!
    .getByRole("status")
    .filter({ hasText: "Saved." })
    .waitFor({ timeout: 120_000 });
}
async function editCell(environment: string) {
  await page!
    .getByRole("button", {
      name: `Details for ${fixture} in ${environment}`,
      exact: true,
    })
    .click({ timeout: 120_000 });
  return page!.getByRole("dialog");
}
try {
  let state: { url: string; launchUrl: string };
  if (options.schema) {
    ownApp = await startServer({ schemas: [options.schema] });
    state = ownApp;
  } else state = JSON.parse(await readFile(options.launchFile, "utf8"));
  const origin = new URL(state.url);
  if (
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(origin.hostname)
  )
    throw new Error("Browser verification only connects to the local app.");
  base = origin.origin;
  browser = await chromium.launch({
    channel: "chrome",
    headless: !options.headed,
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(120_000);
  await page.goto(state.launchUrl);
  await page.waitForFunction(() => location.hash === "");
  const projects = await api("/api/projects");
  token = projects.mutationToken;
  project = projects.projects[0].id;
  matrix = await getMatrix();
  const originalVersions = structuredClone(matrix.versions);
  const environments: string[] = matrix.environments;
  const parent = matrix.config.defaultEnvironment ?? environments[0];
  const child = environments.find(
    (env) => matrix.config.environments[env].extends === parent,
  );
  console.log("Local browser connected. Existing secrets are masked.");
  await writeFile(
    recoveryPath,
    JSON.stringify(
      {
        url: base,
        project,
        name: fixture,
        schemaPath: options.schema ?? matrix.schemaPath,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await page
    .getByRole("button", { name: "+ Add variable", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Variable name", exact: true })
    .fill(fixture);
  await dialog
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Temporary live CRUD verification");
  assert.ok(
    await dialog
      .getByRole("button", { name: "Create secret", exact: true })
      .isDisabled(),
    "Blank creation requires explicit empty-value intent.",
  );
  await dialog
    .getByRole("combobox", { name: "Environment", exact: true })
    .selectOption(parent);
  await dialog
    .getByRole("textbox", { name: "Secret value", exact: true })
    .fill(firstValue);
  await dialog
    .getByRole("textbox", { name: "Initial value notes", exact: true })
    .fill("Original fixture notes");
  created = true;
  await dialog
    .getByRole("button", { name: "Create secret", exact: true })
    .click();
  await saved();
  matrix = await getMatrix();
  assert.ok(
    !JSON.stringify(matrix).includes(firstValue),
    "The matrix must not contain the fixture value.",
  );
  console.log(
    "Create passed: definition and 1Password value saved together, with masked metadata.",
  );
  dialog = await editCell(parent);
  assert.ok(
    await dialog
      .getByRole("button", { name: "Save change", exact: true })
      .isDisabled(),
    "Opening an editor must not enable an accidental empty overwrite.",
  );
  await dialog
    .getByRole("textbox", { name: "Notes for this override", exact: true })
    .fill("Updated notes without reveal");
  await dialog
    .getByRole("button", { name: "Save change", exact: true })
    .click();
  await saved();
  dialog = await editCell(parent);
  await dialog
    .getByRole("button", { name: "Reveal current value", exact: true })
    .click();
  await dialog.locator("pre").filter({ hasText: firstValue }).waitFor();
  assert.equal(
    await dialog
      .getByRole("textbox", { name: "Notes for this override", exact: true })
      .inputValue(),
    "Updated notes without reveal",
  );
  await dialog
    .getByRole("button", { name: "Close editor", exact: true })
    .click();
  assert.ok(
    !(await page.locator("body").innerText()).includes(firstValue),
    "Closing the editor must discard the revealed value.",
  );
  console.log(
    "Read and notes-only update passed: original value retained and reveal cleared on close.",
  );
  dialog = await editCell(parent);
  await dialog
    .getByRole("textbox", { name: "New value", exact: true })
    .fill(updatedValue);
  await dialog
    .getByRole("button", { name: "Save change", exact: true })
    .click();
  await saved();
  let revealed = await api(`/api/reveal?project=${project}`, {
    environment: parent,
    name: fixture,
    fingerprint: (await getMatrix()).fingerprint,
  });
  assert.equal(revealed.value, updatedValue);
  assert.equal(revealed.notes, "Updated notes without reveal");
  if (child) {
    dialog = await editCell(child);
    await dialog
      .getByRole("textbox", { name: "New value", exact: true })
      .fill(prodValue);
    await dialog
      .getByRole("button", { name: "Save change", exact: true })
      .click();
    await saved();
    revealed = await api(`/api/reveal?project=${project}`, {
      environment: child,
      name: fixture,
      fingerprint: (await getMatrix()).fingerprint,
    });
    assert.equal(revealed.value, prodValue);
    dialog = await editCell(child);
    await dialog
      .getByRole("checkbox", {
        name: "Set an explicit empty value",
        exact: true,
      })
      .check();
    await dialog
      .getByRole("button", { name: "Save change", exact: true })
      .click();
    await saved();
    revealed = await api(`/api/reveal?project=${project}`, {
      environment: child,
      name: fixture,
      fingerprint: (await getMatrix()).fingerprint,
    });
    assert.equal(revealed.value, "");
    dialog = await editCell(child);
    await dialog
      .getByRole("button", { name: "Remove override", exact: true })
      .click();
    await saved();
    revealed = await api(`/api/reveal?project=${project}`, {
      environment: child,
      name: fixture,
      fingerprint: (await getMatrix()).fingerprint,
    });
    assert.equal(revealed.value, updatedValue);
  }
  console.log(
    "Update passed: replacement values, explicit empty overrides, and restored inheritance.",
  );
  dialog = await editCell(parent);
  await dialog
    .getByRole("combobox", { name: "Change", exact: true })
    .selectOption("delete");
  assert.ok(
    await dialog
      .getByRole("button", { name: "Delete everywhere", exact: true })
      .isDisabled(),
  );
  await dialog
    .getByRole("textbox", { name: `Type ${fixture} to confirm`, exact: true })
    .fill(fixture);
  await dialog
    .getByRole("button", { name: "Delete everywhere", exact: true })
    .click();
  await saved();
  deleted = true;
  const after = await getMatrix();
  assert.ok(
    !after.versions[fixture] &&
      !after.resolutions.some((r: any) =>
        r.variables.some((v: any) => v.name === fixture),
      ),
  );
  for (const [name, versions] of Object.entries(originalVersions))
    assert.deepEqual(
      after.versions[name],
      versions,
      "Existing item versions must remain unchanged.",
    );
  await unlink(recoveryPath);
  await writeFile(
    ".local/ui-test-result.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        passed: true,
        create: true,
        read: true,
        update: true,
        delete: true,
        notesOnlyPreservesValue: true,
        explicitEmpty: true,
        inheritanceRestored: !!child,
        temporaryItemsRemoved: true,
        existingCredentialsUnchanged: true,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "Delete passed: temporary secret removed from the schema and vaults. Existing credentials unchanged.",
  );
} catch {
  console.error(
    "Browser CRUD verification failed. Check the local app and 1Password authorization.",
  );
  process.exitCode = 1;
} finally {
  if (created && !deleted && page && token && project) {
    try {
      const current = await getMatrix();
      if (
        current.resolutions.some((r: any) =>
          r.variables.some((v: any) => v.name === fixture),
        )
      ) {
        await api(`/api/edit?project=${project}`, {
          action: "delete",
          name: fixture,
          confirmation: fixture,
          fingerprint: current.fingerprint,
          versions: current.versions[fixture],
        });
      } else if (
        current.resolutions.some((r: any) =>
          r.unmanaged.some((v: any) => v.name === fixture),
        )
      )
        throw new Error("Unmanaged fixture needs recovery");
      await unlink(recoveryPath).catch(() => {});
      console.log("Temporary fixture cleanup completed.");
    } catch {
      console.error(
        "Fixture recovery details remain in .local/ui-test-recovery.json.",
      );
    }
  }
  await browser?.close();
  await ownApp?.close();
}
