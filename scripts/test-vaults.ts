import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { MemoryProvider, config } from "../tests/helpers.js";
import { startServer } from "../apps/web/src/server.js";

const provider = new MemoryProvider();
const [infra, jewelry, empty] = Object.values(config.environments).map(
  (e) => e.vault,
);
provider.listVaults = async () => [
  { id: infra, name: "infra" },
  { id: jewelry, name: "jewelry" },
  { id: empty, name: "money-redux" },
];
await provider.save(infra, "TOKEN", "infra-fixture", "original notes");
await provider.save(jewelry, "TOKEN", "jewelry-fixture", "");
const app = await startServer({ schemas: [], discovery: {}, provider });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  let cellReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/reveal") cellReads++;
  });
  page.on("pageerror", (error) => errors.push(error.message));
  let releaseInitial!: () => void;
  const initialGate = new Promise<void>(
    (resolve) => (releaseInitial = resolve),
  );
  let gateInitial = true;
  await page.route(/\/api\/catalog(?:\?|$)/, async (route) => {
    if (gateInitial) await initialGate;
    await route.continue();
  });
  await page.goto(app.launchUrl);
  await page
    .getByRole("status")
    .filter({ hasText: "Loading 1Password secrets" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("columnheader", { name: "Notes", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await page.getByRole("button", { name: "Schema settings" }).count(),
    0,
  );
  assert.ok(!(await page.locator("body").innerText()).includes(".env.schema"));
  gateInitial = false;
  releaseInitial();
  const infraCell = page.getByRole("button", {
    name: "Edit TOKEN in infra",
    exact: true,
  });
  const jewelryCell = page.getByRole("button", {
    name: "Edit TOKEN in jewelry",
    exact: true,
  });
  await infraCell.waitFor();
  await jewelryCell.waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Vault", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Schema settings" }).count(),
    0,
  );
  assert.ok(
    !(await page.locator("body").innerText()).includes("infra-fixture"),
  );
  const readsBeforeNotes = cellReads;
  const notesCell = page.getByRole("button", {
    name: "Edit notes for TOKEN in infra",
    exact: true,
  });
  await notesCell.getByText("original notes", { exact: true }).waitFor();
  await notesCell.click();
  const notesInput = page.getByRole("textbox", {
    name: "Notes for TOKEN in infra",
    exact: true,
  });
  assert.equal(await notesInput.inputValue(), "original notes");
  await notesInput.fill("Edited inline notes");
  await notesInput.press("Shift+Enter");
  await notesInput.pressSequentially("Second line");
  assert.equal(
    await notesInput.inputValue(),
    "Edited inline notes\nSecond line",
  );
  await notesInput.press("Control+Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Saved notes for TOKEN in infra" })
    .waitFor();
  assert.equal(
    provider.vaults[infra][0].notes,
    "Edited inline notes\nSecond line",
  );
  assert.equal(provider.vaults[infra][0].value, "infra-fixture");
  assert.equal(
    cellReads,
    readsBeforeNotes,
    "Notes editing must not reveal or fetch the secret value",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("columnheader", { name: "Environment", exact: true })
    .click();
  await page
    .getByRole("columnheader", { name: "Environment", exact: true })
    .click();
  assert.ok(
    (await page.getByRole("row").nth(1).innerText()).includes("jewelry"),
    "Descending environment sort should put jewelry first",
  );
  await page.getByRole("columnheader", { name: "Secret", exact: true }).click();
  const search = page.getByRole("textbox", {
    name: "Search secrets across environments",
    exact: true,
  });
  await search.fill("jewelry token");
  await jewelryCell.waitFor();
  assert.equal(await infraCell.count(), 0);
  await search.fill("TOKEN");
  await infraCell.waitFor();
  await jewelryCell.waitFor();
  await page
    .getByRole("button", { name: "Filter environment infra", exact: true })
    .click();
  await infraCell.waitFor();
  assert.equal(await jewelryCell.count(), 0);
  await page
    .getByRole("button", { name: "Filter environment jewelry", exact: true })
    .click();
  await jewelryCell.waitFor();
  await infraCell.waitFor();
  await page
    .getByRole("button", { name: "All environments", exact: true })
    .click();
  await infraCell.click();
  const field = page.getByRole("textbox", {
    name: "TOKEN value in infra",
    exact: true,
  });
  await field.waitFor();
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'textarea[aria-label="TOKEN value in infra"]',
        ) as HTMLTextAreaElement
      )?.value === "infra-fixture",
  );
  await field.press("Escape");
  const readsBefore = cellReads;
  await infraCell.click();
  assert.equal(await field.inputValue(), "infra-fixture");
  assert.equal(
    cellReads,
    readsBefore,
    "Reopening a cell must not issue another reveal request",
  );
  await field.fill("infra-edited");
  await field.press("Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Saved TOKEN in infra" })
    .waitFor();
  assert.equal(provider.vaults[infra][0].value, "infra-edited");
  assert.equal(provider.vaults[jewelry][0].value, "jewelry-fixture");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Reveal all values", exact: true })
    .click();
  await infraCell.getByText("infra-edited", { exact: true }).waitFor();
  await jewelryCell.getByText("jewelry-fixture", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Hide all values", exact: true })
    .click();
  assert.ok(!(await page.locator("body").innerText()).includes("infra-edited"));
  assert.ok(
    !(await page.locator("body").innerText()).includes("jewelry-fixture"),
  );
  await page
    .getByRole("button", {
      name: "Filter environment money-redux",
      exact: true,
    })
    .click();
  await page
    .getByText("No secrets match your search and environment filters.", {
      exact: true,
    })
    .waitFor();
  await search.fill("");
  await page.getByRole("button", { name: "Add variable", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Variable name", exact: true })
    .fill("NEW_SECRET");
  await dialog
    .getByRole("textbox", { name: "Secret value", exact: true })
    .fill("new-fixture");
  await dialog
    .getByRole("textbox", { name: "Initial value notes", exact: true })
    .fill("new notes");
  await dialog
    .getByRole("button", { name: "Create secret", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Edit NEW_SECRET in money-redux",
      exact: true,
    })
    .waitFor();
  assert.equal(provider.vaults[empty][0].value, "new-fixture");
  await page
    .getByRole("button", {
      name: "Details for NEW_SECRET in money-redux",
      exact: true,
    })
    .click();
  await dialog
    .getByRole("combobox", { name: "Change", exact: true })
    .selectOption("rename");
  await dialog
    .getByRole("textbox", { name: "New variable name", exact: true })
    .fill("RENAMED");
  await dialog
    .getByRole("button", { name: "Save change", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit RENAMED in money-redux", exact: true })
    .waitFor();
  await page
    .getByRole("button", {
      name: "Details for RENAMED in money-redux",
      exact: true,
    })
    .click();
  await dialog
    .getByRole("combobox", { name: "Change", exact: true })
    .selectOption("delete");
  await dialog
    .getByRole("textbox", { name: "Type RENAMED to confirm", exact: true })
    .fill("RENAMED");
  await dialog
    .getByRole("button", { name: "Delete from this vault", exact: true })
    .click();
  await page
    .getByText("No secrets match your search and environment filters.", {
      exact: true,
    })
    .waitFor();
  assert.equal(provider.vaults[empty].length, 0);
  assert.equal(provider.vaults[infra][0].value, "infra-edited");
  assert.equal(provider.vaults[jewelry][0].value, "jewelry-fixture");
  await page
    .getByRole("button", { name: "All environments", exact: true })
    .click();
  await infraCell.waitFor();
  await jewelryCell.waitFor();
  await page
    .getByRole("grid", { name: "Secrets across environments" })
    .getByRole("checkbox", { name: "Select All", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Type DELETE to confirm", exact: true })
    .fill("DELETE");
  await dialog
    .getByRole("button", { name: "Delete secrets", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Deleted 2 secrets" })
    .waitFor();
  assert.equal(provider.vaults[infra].length, 0);
  assert.equal(provider.vaults[jewelry].length, 0);
  assert.deepEqual(errors, []);
  console.log(
    "Combined vault UI passed: cross-environment search, multiple filters, duplicate names, inline editing, masking, create, rename, and cross-environment deletion.",
  );
} finally {
  await browser.close();
  await app.close();
}
