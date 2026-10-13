import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { MemoryProvider, config } from "../tests/helpers.js";
import { startServer } from "../apps/web/src/server.js";

const provider = new MemoryProvider();
const id = config.environments.dev.vault;
provider.listVaults = async () => [{ id, name: "infra" }];
await provider.save(id, "KEY", "fixture-value", "initial");
await provider.save(id, "OTHER", "other-fixture", "other initial");
const app = await startServer({ schemas: [], discovery: {}, provider });
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_BROWSER === "chromium" ? undefined : "chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  let catalogReads = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/catalog") catalogReads++;
  });
  await page.goto(app.launchUrl);
  const cell = page.getByRole("button", {
    name: "Edit notes for KEY in infra",
    exact: true,
  });
  const input = page.getByRole("textbox", {
    name: "Notes for KEY in infra",
    exact: true,
  });
  await cell.waitFor();
  const initialReads = catalogReads;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const observed = new Promise<void>((done) => (started = done));
  await page.route("**/api/edit?*", async (route) => {
    const response = await route.fetch();
    if (route.request().postDataJSON().name === "KEY") {
      started();
      await gate;
    }
    await route.fulfill({ response });
  });
  await cell.click();
  await input.fill("first edit");
  await input.press("Control+Enter");
  await observed;
  assert.equal(
    await cell.isDisabled(),
    true,
    "A row must stay blocked until its verified result is applied",
  );
  // A newer result from another row can arrive before this response.
  const otherCell = page.getByRole("button", {
    name: "Edit notes for OTHER in infra",
    exact: true,
  });
  await otherCell.click();
  const otherInput = page.getByRole("textbox", {
    name: "Notes for OTHER in infra",
    exact: true,
  });
  await otherInput.fill("newer other edit");
  await otherInput.press("Control+Enter");
  await otherCell.getByText("newer other edit", { exact: true }).waitFor();
  release();
  await page
    .getByRole("status")
    .filter({ hasText: "Saved notes for KEY in infra" })
    .waitFor();
  await page.unroute("**/api/edit?*");
  await otherCell.getByText("newer other edit", { exact: true }).waitFor();
  await cell.click();
  assert.equal(await input.inputValue(), "first edit");
  await input.fill("second edit");
  await input.press("Control+Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Saved notes for KEY in infra" })
    .waitFor();
  await cell.getByText("second edit", { exact: true }).waitFor();
  assert.equal(provider.vaults[id][0].notes, "second edit");
  assert.equal(
    catalogReads,
    initialReads,
    "Single-cell saves must not reload the catalog",
  );

  // Leaving a draft to search must not write it to 1Password.
  await cell.click();
  await input.fill("unfinished draft");
  const search = page.getByRole("textbox", {
    name: "Search secrets across environments",
    exact: true,
  });
  await search.fill("KEY");
  await page
    .getByRole("status")
    .filter({ hasText: "Unsaved notes draft" })
    .waitFor();
  assert.equal(provider.vaults[id][0].notes, "second edit");
  await cell.click();
  assert.equal(await input.inputValue(), "unfinished draft");
  await input.press("Escape");
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();

  // A concurrent external change must keep the draft and require comparison.
  await provider.save(id, "KEY", "fixture-value", "external change", {
    ...provider.vaults[id][0],
  });
  await cell.click();
  await input.fill("my retained draft");
  await input.press("Control+Enter");
  await page
    .getByRole("alert")
    .filter({ hasText: "Your draft is retained" })
    .waitFor();
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  const latest = page.getByRole("textbox", {
    name: "Latest field",
    exact: true,
  });
  const draft = page.getByRole("textbox", {
    name: "Retained draft",
    exact: true,
  });
  await latest.waitFor();
  assert.equal(await latest.inputValue(), "external change");
  assert.equal(await draft.inputValue(), "my retained draft");
  // A new change after comparison must still reject the reviewed save.
  await provider.save(id, "KEY", "fixture-value", "changed again", {
    ...provider.vaults[id][0],
  });
  await page
    .getByRole("button", { name: "Save reviewed draft", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Your draft is retained" })
    .waitFor();
  assert.equal(provider.vaults[id][0].notes, "changed again");
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await latest.waitFor();
  assert.equal(await latest.inputValue(), "changed again");
  assert.equal(await draft.inputValue(), "my retained draft");
  await page
    .getByRole("button", { name: "Save reviewed draft", exact: true })
    .click();
  await cell.getByText("my retained draft", { exact: true }).waitFor();
  assert.equal(provider.vaults[id][0].notes, "my retained draft");
  assert.ok(
    !(await page.locator("body").innerText()).includes("fixture-value"),
  );

  // Hiding during an accepted-but-delayed save must mask the late response.
  await page
    .getByRole("button", { name: "Reveal all values", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Hide all values", exact: true })
    .waitFor();
  let releaseVisible!: () => void;
  let visibleStarted!: () => void;
  const visibleGate = new Promise<void>((done) => (releaseVisible = done));
  const visibleObserved = new Promise<void>((done) => (visibleStarted = done));
  await page.route("**/api/edit?*", async (route) => {
    const response = await route.fetch();
    visibleStarted();
    await visibleGate;
    await route.fulfill({ response });
  });
  await cell.click();
  await input.fill("save while visible");
  await input.press("Control+Enter");
  await visibleObserved;
  await page
    .getByRole("button", { name: "Hide all values", exact: true })
    .click();
  releaseVisible();
  await cell.getByText("save while visible", { exact: true }).waitFor();
  assert.ok(
    !(await page.locator("body").innerText()).includes("fixture-value"),
  );
  await page.unroute("**/api/edit?*");
  assert.deepEqual(errors, []);
  console.log(
    "Verified blocked saves, rapid follow-up edits, no catalog reload, search draft retention, and reviewed conflict recovery.",
  );
} finally {
  await browser.close();
  await app.close();
}
