/** Explicit live verification. Only uniquely named non-secret fixtures are mutated. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { Command } from "commander";
import { chromium } from "playwright-core";
import { startServer } from "../apps/web/src/server.js";
const options = new Command().requiredOption("--schema <path>").parse().opts();
const prefix =
  "BEV_BULK_TEST_" + randomUUID().replaceAll("-", "").toUpperCase();
const names = [prefix + "_A", prefix + "_B"];
const recovery = ".local/bulk-ui-recovery.json";
const app = await startServer({ schemas: [options.schema] });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(120_000);
let mutationToken = "";
const created: string[] = [];
let complete = false;
let stage = "connect";
async function api(path: string, data?: unknown) {
  const response = await page.request.fetch(app.url + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Origin: app.url,
      ...(data === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Bev-Mutation": mutationToken,
          }),
    },
    ...(data === undefined ? {} : { data }),
    timeout: 120_000,
  });
  if (!response.ok())
    throw Error(
      "The protected local API could not complete the bulk fixture verification.",
    );
  return response.json();
}
const matrix = () => api("/api/matrix?project=0");
try {
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => location.hash === "");
  mutationToken = (await api("/api/projects")).mutationToken;
  stage = "read metadata";
  const before = await matrix();
  const original = structuredClone(before.versions);
  assert.equal(before.environments.length, 3);
  const environments: string[] = before.environments;
  await writeFile(
    recovery,
    JSON.stringify({ schemaPath: options.schema, names }, null, 2),
    { mode: 0o600 },
  );
  stage = "create fixtures";
  for (const [index, name] of names.entries()) {
    const current = await matrix();
    created.push(name);
    await api("/api/edit?project=0", {
      action: "add",
      name,
      description: "Disposable live bulk-delete verification",
      required: false,
      sensitive: true,
      fingerprint: current.fingerprint,
      versions: Object.fromEntries(
        environments.map((environment) => [environment, null]),
      ),
      initialValues: Object.fromEntries(
        [environments[index], environments[2]].map((environment) => [
          environment,
          {
            value: "non-secret-bulk-fixture",
            notes: "Disposable test fixture",
          },
        ]),
      ),
    });
  }
  stage = "refresh fixtures";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search variables", exact: true })
    .fill(prefix);
  const grid = page.getByRole("grid", {
    name: "Environment values",
    exact: true,
  });
  await grid.getByText(names[0], { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Schema", exact: true }).count(),
    0,
  );
  const metadata = await matrix();
  stage = "vault tooltips";
  for (const environment of environments) {
    await page
      .getByRole("button", {
        name: `Vault info for ${environment}`,
        exact: true,
      })
      .hover();
    assert.equal(
      typeof metadata.vaults[environment].name,
      "string",
      "1Password must return the actual vault title.",
    );
    const tooltip = page
      .getByRole("tooltip")
      .filter({ hasText: metadata.vaults[environment].name });
    await tooltip.waitFor();
    const text = await tooltip.textContent();
    assert.ok(text!.includes(metadata.vaults[environment].name));
    assert.ok(text!.includes(metadata.config.environments[environment].vault));
    await page.mouse.move(0, 0);
  }
  await grid.getByRole("checkbox", { name: "Select All", exact: true }).check();
  const actions = page.getByRole("toolbar", {
    name: "Selected variables actions",
    exact: true,
  });
  await actions.getByText("2 selected", { exact: true }).waitFor();
  await page.screenshot({ path: ".local/bulk-selection.png", fullPage: true });
  await actions
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  stage = "confirm deletion";
  const dialog = page.getByRole("dialog");
  for (const name of names)
    await dialog.getByText(name, { exact: true }).waitFor();
  assert.equal(await dialog.locator("li").count(), 2);
  assert.ok(
    await dialog
      .getByRole("button", { name: "Delete variables", exact: true })
      .isDisabled(),
  );
  await dialog
    .getByRole("textbox", { name: "Type DELETE to confirm", exact: true })
    .fill("DELETE");
  await dialog
    .getByRole("button", { name: "Delete variables", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Deleted 2 variables" })
    .waitFor();
  stage = "verify cleanup";
  const after = await matrix();
  for (const name of names) {
    assert.ok(!after.versions[name]);
    assert.ok(
      after.resolutions.every(
        (resolution: any) =>
          !resolution.variables.some(
            (variable: any) => variable.name === name,
          ) &&
          !resolution.unmanaged.some((variable: any) => variable.name === name),
      ),
    );
  }
  for (const [name, versions] of Object.entries(original))
    assert.deepEqual(
      after.versions[name],
      versions,
      "Existing credentials must remain unchanged.",
    );
  await unlink(recovery);
  await writeFile(
    ".local/bulk-ui-result.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        passed: true,
        rowSelection: true,
        confirmedBulkDeletion: true,
        vaultNamesAndIdsVerified: true,
        temporaryDefinitionsAndItemsRemoved: true,
        existingCredentialsUnchanged: true,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  complete = true;
  console.log(
    "Live row selection, vault-name/ID tooltips, confirmed bulk deletion, and fixture cleanup passed. Existing credentials unchanged.",
  );
} catch (error) {
  console.error(
    `Failed at ${stage}: ${error instanceof Error ? error.name : "operation"}.`,
  );
  console.error(
    "Live bulk verification failed. Recovery names remain in .local/bulk-ui-recovery.json.",
  );
  process.exitCode = 1;
} finally {
  if (!complete && mutationToken && created.length) {
    try {
      const current = await matrix();
      const remaining = created.filter((name) =>
        current.resolutions[0].variables.some(
          (variable: any) => variable.name === name,
        ),
      );
      if (remaining.length)
        await api("/api/delete-many?project=0", {
          names: remaining,
          confirmation: "DELETE",
          fingerprint: current.fingerprint,
          versions: Object.fromEntries(
            remaining.map((name) => [name, current.versions[name]]),
          ),
        });
      const after = await matrix();
      if (
        created.some((name) =>
          after.resolutions.some(
            (resolution: any) =>
              resolution.variables.some(
                (variable: any) => variable.name === name,
              ) ||
              resolution.unmanaged.some(
                (variable: any) => variable.name === name,
              ),
          ),
        )
      )
        throw Error("Cleanup incomplete");
      await unlink(recovery).catch(() => {});
      console.log("Bulk verification fixtures cleaned up.");
    } catch {
      console.error("Bulk fixture cleanup needs recovery.");
    }
  }
  await browser.close();
  await app.close();
}
