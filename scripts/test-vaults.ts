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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  const vault = page.getByRole("combobox", { name: "Vault", exact: true });
  await vault.waitFor();
  await page
    .getByRole("button", { name: "Edit TOKEN in vault", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("columnheader", { name: /Schema default/ }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Schema settings" }).count(),
    0,
  );
  assert.ok(!(await page.locator("body").innerText()).includes("Inherits"));
  assert.ok(
    !(await page.locator("body").innerText()).includes("infra-fixture"),
  );
  await page
    .getByRole("textbox", { name: "Search variables", exact: true })
    .fill("absent");
  assert.equal(
    await page
      .getByRole("button", { name: "Edit TOKEN in vault", exact: true })
      .count(),
    0,
  );
  await page
    .getByRole("textbox", { name: "Search variables", exact: true })
    .fill("TOKEN");
  await page
    .getByRole("button", { name: "Edit TOKEN in vault", exact: true })
    .click();
  const input = page.getByRole("textbox", {
    name: "TOKEN value in vault",
    exact: true,
  });
  await input.waitFor();
  await page.waitForFunction(
    () =>
      (
        document.querySelector(
          'textarea[aria-label="TOKEN value in vault"]',
        ) as HTMLTextAreaElement
      )?.value === "infra-fixture",
  );
  await input.fill("infra-edited");
  await input.press("Enter");
  await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  assert.equal(provider.vaults[infra][0].value, "infra-edited");
  assert.equal(provider.vaults[jewelry][0].value, "jewelry-fixture");
  await page
    .getByRole("button", { name: "Reveal all values", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit TOKEN in vault", exact: true })
    .getByText("infra-edited", { exact: true })
    .waitFor();
  await vault.selectOption(jewelry);
  await page
    .getByRole("button", { name: "Edit TOKEN in vault", exact: true })
    .waitFor();
  assert.ok(!(await page.locator("body").innerText()).includes("infra-edited"));
  assert.ok(
    !(await page.locator("body").innerText()).includes("jewelry-fixture"),
  );
  await vault.selectOption(empty);
  await page
    .getByText("This vault has no API Credential variables yet.", {
      exact: false,
    })
    .waitFor();
  await page
    .getByRole("textbox", { name: "Search variables", exact: true })
    .fill("");
  await page.getByRole("button", { name: "Add variable", exact: true }).click();
  const dialog = page.getByRole("dialog");
  assert.equal(
    await dialog.getByRole("textbox", { name: "Type", exact: true }).count(),
    0,
  );
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
    .getByRole("button", { name: "Edit NEW_SECRET in vault", exact: true })
    .waitFor();
  assert.equal(provider.vaults[empty][0].value, "new-fixture");
  await page
    .getByRole("button", {
      name: "Details for NEW_SECRET in vault",
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
    .getByRole("button", { name: "Edit RENAMED in vault", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Details for RENAMED in vault", exact: true })
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
    .getByText("This vault has no API Credential variables yet.", {
      exact: false,
    })
    .waitFor();
  assert.equal(provider.vaults[empty].length, 0);
  assert.equal(provider.vaults[infra][0].value, "infra-edited");
  assert.equal(provider.vaults[jewelry][0].value, "jewelry-fixture");
  assert.deepEqual(errors, []);
  console.log(
    "Vault UI checks passed: isolation, search, inline editing, masking, empty vaults, create, rename, and delete.",
  );
} finally {
  await browser.close();
  await app.close();
}
