/** Exercise the editing workflow using only keyboard input. No 1Password access. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { MemoryProvider, config, fixture } from "../tests/helpers.js";
import { startServer } from "../apps/web/src/server.js";

const provider = new MemoryProvider();
const id = config.environments.dev.vault;
provider.listVaults = async () => [{ id, name: "infra" }];
await provider.save(id, "KEY", "initial", "initial notes");
await provider.save(id, "JSON", '{"n":1}', "");
const app = await startServer({ schemas: [], discovery: {}, provider });
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_BROWSER === "chromium" ? undefined : "chrome",
  headless: true,
});
const errors: string[] = [];
let writes = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/edit") writes++;
  });
  await page.goto(app.launchUrl);
  await page
    .getByRole("button", { name: "Edit KEY in infra", exact: true })
    .waitFor();
  const search = page.getByRole("textbox", {
    name: "Search secrets across environments",
  });
  const input = page.getByRole("textbox", {
    name: "KEY value in infra",
    exact: true,
  });
  async function focusedCell(name: string, column: number) {
    await page.waitForFunction(
      ({ name, column }) => {
        const active = document.activeElement;
        return (
          active?.getAttribute("role") === "gridcell" &&
          active.getAttribute("aria-colindex") === String(column) &&
          active.closest('[role="row"]')?.textContent?.includes(name)
        );
      },
      { name, column },
    );
  }
  async function searchFor(text: string, shortcut = "Control+k") {
    await page.keyboard.press(shortcut);
    await search.fill(text);
    assert.equal(
      await search.evaluate((el) => document.activeElement === el),
      true,
    );
    await search.press("Enter");
    await page.waitForFunction(() =>
      document.activeElement?.closest('[role="grid"], [role="treegrid"]'),
    );
  }
  await searchFor("KEY", "/");
  await page.keyboard.press("Enter");
  await input.waitFor();
  await input.fill("cancelled");
  await input.press("Escape");
  await focusedCell("KEY", 4);
  assert.equal(await input.count(), 0);
  assert.equal(writes, 0);
  await page.keyboard.press("F2");
  await input.waitFor();
  await input.fill("draft");
  await input.press("Control+Shift+Enter");
  const drawer = page.getByRole("dialog");
  await drawer.waitFor();
  const expanded = drawer.getByRole("textbox");
  await expanded.press("End");
  await expanded.press("Enter");
  await expanded.pressSequentially("second line");
  assert.equal(await expanded.inputValue(), "draft\nsecond line");
  if (process.env.SCREENSHOT_DIRECTORY) {
    await mkdir(process.env.SCREENSHOT_DIRECTORY, { recursive: true });
    const path = join(
      process.env.SCREENSHOT_DIRECTORY,
      "keyboard-value-editor.png",
    );
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    execFileSync("pay", ["agent", "artifact", "create", "--file", path], {
      stdio: "inherit",
    });
  }
  await expanded.press("Control+k");
  assert.equal(
    await expanded.evaluate((el) => document.activeElement === el),
    true,
    "Search shortcut must not steal focus from a modal editor",
  );
  await expanded.press("Control+Shift+Enter");
  await drawer.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.tagName === "TEXTAREA",
  );
  assert.equal(
    await input.evaluate((el) => document.activeElement === el),
    true,
  );
  assert.equal(await input.inputValue(), "draft\nsecond line");
  assert.equal(writes, 0, "Expanding and collapsing must not save");
  await input.press("Meta+Shift+Enter");
  await drawer.waitFor();
  await drawer.getByRole("textbox").press("Meta+Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Saved KEY in infra" })
    .waitFor();
  assert.equal(
    provider.vaults[id].find((item) => item.name === "KEY")!.value,
    "draft\nsecond line",
  );
  await searchFor("KEY", "Meta+k");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");

  const notes = page.getByRole("textbox", {
    name: "Notes for KEY in infra",
    exact: true,
  });
  await notes.waitFor();
  await notes.press("Control+Shift+Enter");
  await drawer.waitFor();
  await drawer.getByRole("textbox").fill("notes\nsecond");
  await page.keyboard.press("Control+Shift+Enter");
  await drawer.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.tagName === "TEXTAREA",
  );
  assert.equal(await notes.inputValue(), "notes\nsecond");
  await notes.press("Control+Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Saved notes for KEY in infra" })
    .waitFor();

  await searchFor("JSON");
  await page.keyboard.press("F2");
  await drawer.waitFor();
  await drawer.getByRole("textbox").fill('{\n "n": 2\n}');
  await page.keyboard.press("Control+Shift+Enter");
  await drawer.waitFor({ state: "hidden" });
  const jsonInline = page.getByRole("textbox", {
    name: "JSON value in infra",
    exact: true,
  });
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") ===
      "JSON value in infra",
  );
  assert.equal(
    await jsonInline.evaluate((el) => document.activeElement === el),
    true,
  );
  await jsonInline.press("Control+Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Saved JSON in infra" })
    .waitFor();
  assert.equal(
    provider.vaults[id].find((item) => item.name === "JSON")!.value,
    '{"n":2}',
  );
  await searchFor("JSON");
  await page.keyboard.press("Enter");
  await drawer.waitFor();
  await drawer.getByRole("textbox").fill("invalid json");
  await page.keyboard.press("Control+Shift+Enter");
  await drawer.waitFor({ state: "hidden" });
  const beforeInvalidSave = writes;
  await jsonInline.press("Control+Enter");
  assert.equal(writes, beforeInvalidSave);
  await jsonInline.press("Escape");

  await page.keyboard.press("/");
  await search.fill("");
  await search.press("ArrowDown");
  await page.waitForFunction(() =>
    document.activeElement?.closest('[role="grid"]'),
  );
  await page.keyboard.press("ArrowDown");

  await page.keyboard.press("Enter");
  await input.waitFor();
  await input.fill("paused draft");
  await input.press("Control+k");
  await page.waitForFunction(
    () => document.activeElement?.id === "vault-search",
  );
  assert.equal(
    await search.evaluate((el) => document.activeElement === el),
    true,
  );
  await page
    .getByRole("status")
    .filter({ hasText: "Unsaved value draft for KEY" })
    .waitFor();
  await search.press("Escape");
  await page.waitForFunction(() =>
    document.activeElement?.closest('[role="grid"]'),
  );
  assert.ok(
    await page
      .getByRole("grid")
      .evaluate((el) => el.contains(document.activeElement)),
  );
  // Cancel search back to the actual prior cell, even after filtering it out.
  await focusedCell("KEY", 4);
  await page.keyboard.press("ArrowRight");
  await focusedCell("KEY", 5);
  await page.keyboard.press("Meta+k");
  await search.fill("JSON");
  await page
    .getByRole("button", { name: "Edit JSON in infra", exact: true })
    .waitFor();
  await search.press("Escape");
  await focusedCell("KEY", 5);
  assert.equal(await search.inputValue(), "");
  await page.keyboard.press("ArrowLeft");
  await focusedCell("KEY", 4);
  await page.keyboard.press("Meta+Shift+Enter");
  await drawer.waitFor();
  await drawer.getByRole("textbox").press("ArrowDown");
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  await focusedCell("KEY", 4);
  await page.keyboard.press("ArrowUp");
  await focusedCell("JSON", 4);
  await page.keyboard.press("Enter");
  await drawer.waitFor();
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  await focusedCell("JSON", 4);
  await page.keyboard.press("ArrowDown");
  await focusedCell("KEY", 4);
  await page.keyboard.press("Meta+k");
  assert.equal(
    await search.evaluate((el) => document.activeElement === el),
    true,
  );
  await search.press("Escape");
  await focusedCell("KEY", 4);

  await page
    .getByRole("combobox", { name: "Group secrets" })
    .selectOption("environment");
  await searchFor("KEY");
  await page.keyboard.press("F2");
  await input.waitFor();
  await input.press("Escape");
  assert.ok(
    await page
      .getByRole("treegrid")
      .evaluate((el) => el.contains(document.activeElement)),
  );
  await focusedCell("KEY", 4);
  await page.keyboard.press("ArrowRight");
  await focusedCell("KEY", 5);
  await page.keyboard.press("Meta+k");
  await search.fill("JSON");
  await search.press("Escape");
  await focusedCell("KEY", 5);
  assert.equal(await search.inputValue(), "KEY");
  await page.keyboard.press("Meta+Shift+Enter");
  await drawer.waitFor();
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  await focusedCell("KEY", 5);
  assert.deepEqual(errors, []);

  const schema = await fixture("# @public @optional\nLABEL=base\n");
  const schemaApp = await startServer({
    schemas: [schema.path],
    provider: new MemoryProvider(),
  });
  try {
    await page.goto(schemaApp.launchUrl);
    await page
      .getByRole("button", { name: "Edit LABEL in dev", exact: true })
      .waitFor();
    const schemaSearch = page.getByRole("textbox", {
      name: "Search variables",
      exact: true,
    });
    await page.keyboard.press("Control+k");
    await schemaSearch.fill("LABEL");
    await schemaSearch.press("ArrowDown");
    await page.waitForFunction(() =>
      document.activeElement?.closest('[role="grid"]'),
    );

    await page.keyboard.press("Enter");
    const schemaInput = page.getByRole("textbox", {
      name: "LABEL value in schema",
      exact: true,
    });
    await schemaInput.waitFor();
    await schemaInput.press("Control+Shift+Enter");
    await drawer.waitFor();
    await drawer.getByRole("textbox").fill("schema draft\nsecond");
    await page.keyboard.press("Control+Shift+Enter");
    await drawer.waitFor({ state: "hidden" });
    assert.equal(await schemaInput.inputValue(), "schema draft\nsecond");
    await schemaInput.press("Escape");
    assert.equal(await schemaInput.count(), 0);
    await focusedCell("LABEL", 3);
    await page.keyboard.press("ArrowRight");
    await focusedCell("LABEL", 4);
    await page.keyboard.press("Meta+k");
    await schemaSearch.fill("no matches");
    await page.getByText("No matching variables", { exact: true }).waitFor();
    await schemaSearch.press("Escape");
    await focusedCell("LABEL", 4);
    assert.equal(await schemaSearch.inputValue(), "LABEL");
    await page.keyboard.press("Meta+Shift+Enter");
    await drawer.waitFor();
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    await focusedCell("LABEL", 4);
    await page.keyboard.press("ArrowRight");
    await focusedCell("LABEL", 5);
    assert.deepEqual(errors, []);
  } finally {
    await schemaApp.close();
  }
  console.log(
    "Verified keyboard search, grid navigation, edit/cancel, value/notes/JSON expansion, draft-preserving collapse, compact JSON saves, and schema mode.",
  );
} finally {
  await browser.close();
  await app.close();
}
