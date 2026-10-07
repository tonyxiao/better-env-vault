import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { fixture, MemoryProvider, config } from "../tests/helpers.js";
import { startServer } from "../apps/web/src/server.js";
const schema = await fixture("# @optional\nTOKEN=\n\n# @public\nLABEL=base\n");
const provider = new MemoryProvider();
await provider.save(
  config.environments.dev.vault,
  "TOKEN",
  "dev-fixture-value",
  "",
);
await provider.save(
  config.environments.prod.vault,
  "TOKEN",
  "prod-fixture-value",
  "",
);
const app = await startServer({ schemas: [schema.path], provider });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  const browserErrors: string[] = [];

  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  let cellReveals = 0;
  let freshLoads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/reveal") cellReveals++;
    if (url.searchParams.get("fresh") === "1") freshLoads++;
  });
  await page.goto(app.launchUrl);
  await page
    .getByRole("button", { name: "Edit TOKEN in prod", exact: true })
    .waitFor();
  assert.ok(
    !(await page.locator("body").innerText()).includes("prod-fixture-value"),
  );
  assert.match(
    await page
      .getByRole("button", { name: "Edit TOKEN in staging", exact: true })
      .innerText(),
    /Inherits dev/,
  );
  assert.match(
    await page
      .getByRole("button", { name: "Edit LABEL in dev", exact: true })
      .innerText(),
    /Inherits schema default/,
  );
  await page
    .getByRole("button", { name: "Reveal all values", exact: true })
    .click();
  await page
    .getByText("All matrix values are visible.", { exact: true })
    .waitFor();
  assert.ok(
    (await page.locator("body").innerText()).includes("dev-fixture-value"),
  );
  assert.ok(
    (await page.locator("body").innerText()).includes("prod-fixture-value"),
  );
  const beforeCachedEdit = cellReveals;
  await page
    .getByRole("button", { name: "Edit TOKEN in prod", exact: true })
    .click();
  const cachedForm = page.getByRole("form", {
    name: "Edit TOKEN in prod",
    exact: true,
  });
  assert.equal(
    await cachedForm.getByRole("textbox").inputValue(),
    "prod-fixture-value",
  );
  assert.equal(
    await cachedForm.getByText("Loading value…", { exact: true }).count(),
    0,
  );
  assert.ok(
    await cachedForm
      .getByRole("button", { name: "Save", exact: true })
      .isDisabled(),
  );
  assert.equal(
    cellReveals,
    beforeCachedEdit,
    "Already-revealed values must not be fetched again.",
  );
  await cachedForm.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Hide all values", exact: true })
    .click();
  assert.ok(
    !(await page.locator("body").innerText()).includes("prod-fixture-value"),
  );
  await page
    .getByRole("button", { name: "Edit TOKEN in prod", exact: true })
    .click();
  const form = page.getByRole("form", {
    name: "Edit TOKEN in prod",
    exact: true,
  });
  const value = form.getByRole("textbox", {
    name: "TOKEN value in prod",
    exact: true,
  });
  await value.waitFor();
  assert.equal(await value.inputValue(), "prod-fixture-value");
  await value.fill("inline-updated-fixture");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  assert.equal(
    (await provider.readVault(config.environments.prod.vault))[0].value,
    "inline-updated-fixture",
  );
  await page
    .getByRole("button", { name: "Edit TOKEN in staging", exact: true })
    .click();
  const inherited = page.getByRole("form", {
    name: "Edit TOKEN in staging",
    exact: true,
  });
  await inherited.getByRole("textbox").waitFor();
  assert.ok(
    await inherited
      .getByRole("button", { name: "Save", exact: true })
      .isDisabled(),
  );
  assert.equal(
    (await provider.readVault(config.environments.staging.vault)).length,
    0,
    "Opening inherited values does not create an override.",
  );
  await inherited.getByRole("textbox").fill("staging-override");
  await inherited.getByRole("button", { name: "Save", exact: true }).click();
  await inherited.waitFor({ state: "hidden" });
  assert.equal(
    (await provider.readVault(config.environments.staging.vault))[0].value,
    "staging-override",
  );
  await page
    .getByRole("button", { name: "Edit TOKEN in prod", exact: true })
    .click();
  await form.getByRole("textbox").waitFor();
  await form.getByRole("textbox").fill("unsaved-draft");
  await page
    .getByRole("button", { name: "Reveal all values", exact: true })
    .click();
  await page
    .getByText("All matrix values are visible.", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Hide all values", exact: true })
    .click();
  await form
    .getByRole("button", { name: "Reveal inline value", exact: true })
    .waitFor();
  assert.equal(await form.getByRole("textbox").count(), 0);
  await form
    .getByRole("button", { name: "Reveal inline value", exact: true })
    .click();
  assert.equal(await form.getByRole("textbox").inputValue(), "unsaved-draft");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    (await provider.readVault(config.environments.prod.vault))[0].value,
    "inline-updated-fixture",
  );
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  await page.route("**/api/reveal-all*", async (route) => {
    await blocked;
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Reveal all values", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Hide all values", exact: true })
    .click();
  release();
  await page.waitForTimeout(300);
  assert.ok(
    !(await page.locator("body").innerText()).includes(
      "inline-updated-fixture",
    ),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Reveal all values", exact: true })
      .getAttribute("aria-pressed"),
    "false",
  );
  await page.unroute("**/api/reveal-all*");
  const refreshButton = page.getByRole("button", {
    name: "Refresh",
    exact: true,
  });
  await refreshButton.click();
  await refreshButton.waitFor();
  await page
    .getByRole("button", { name: "Reveal all values", exact: true })
    .click();
  await page
    .getByText("All matrix values are visible.", { exact: true })
    .waitFor();
  await refreshButton.click();
  await page
    .getByRole("button", { name: "Hide all values", exact: true })
    .click();
  assert.equal(
    freshLoads,
    2,
    "Refresh bypasses both masked and revealed caches.",
  );
  const add = page.getByRole("button", { name: "Add variable", exact: true });
  await add.click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Variable name", exact: true })
    .fill("NEW_FIXTURE");
  await dialog
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Disposable browser test");
  await dialog
    .getByRole("textbox", { name: "Secret value", exact: true })
    .fill("new-fixture-value");
  await dialog
    .getByRole("button", { name: "Create secret", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    (await provider.readVault(config.environments.dev.vault)).find(
      (v) => v.name === "NEW_FIXTURE",
    )?.value,
    "new-fixture-value",
  );
  const details = page.getByRole("button", {
    name: "Details for NEW_FIXTURE in prod",
    exact: true,
  });
  await details.click();
  await dialog
    .getByRole("textbox", { name: "New value", exact: true })
    .fill("prod-fixture");
  await dialog
    .getByRole("button", { name: "Save change", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await details.click();
  await dialog
    .getByRole("checkbox", { name: "Set an explicit empty value", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Save change", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    (await provider.readVault(config.environments.prod.vault)).find(
      (v) => v.name === "NEW_FIXTURE",
    )?.value,
    "",
  );
  await details.click();
  await dialog
    .getByRole("button", { name: "Remove override", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    (await provider.readVault(config.environments.prod.vault)).find(
      (v) => v.name === "NEW_FIXTURE",
    ),
    undefined,
  );
  await details.click();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await details.evaluate((element) => element === document.activeElement),
    true,
    "Drawer restores focus to its trigger.",
  );
  await details.click();
  await dialog
    .getByRole("combobox", { name: "Change", exact: true })
    .selectOption("delete");
  assert.ok(
    await dialog
      .getByRole("button", { name: "Delete everywhere", exact: true })
      .isDisabled(),
  );
  await dialog
    .getByRole("textbox", { name: "Type NEW_FIXTURE to confirm", exact: true })
    .fill("NEW_FIXTURE");
  await dialog
    .getByRole("button", { name: "Delete everywhere", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  assert.ok(
    !Object.values(provider.vaults)
      .flat()
      .some((v) => v.name === "NEW_FIXTURE"),
  );
  await mkdir(".local", { recursive: true });
  await page.screenshot({ path: ".local/shadcn-matrix.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await add.click();
  await dialog.waitFor();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.width <= 390 && bounds.x >= 0);
  await page.waitForTimeout(550);
  const mobileBounds = await dialog.boundingBox();
  assert.ok(
    mobileBounds && mobileBounds.y === 0 && mobileBounds.height === 844,
    "Mobile drawer fills the viewport.",
  );
  await page.screenshot({ path: ".local/shadcn-mobile.png", fullPage: false });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(
    browserErrors,
    [],
    "Browser must have no runtime or CSP errors.",
  );
  console.log(
    "Reveal/hide all, late-response protection, inline saves, inherited overrides, draft masking, cancellation, consistent labels, create/delete, explicit empty, restored inheritance, drawer focus, and mobile layout passed.",
  );
} finally {
  await browser.close();
  await app.close();
}
