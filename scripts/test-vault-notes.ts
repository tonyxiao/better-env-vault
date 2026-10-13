import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { MemoryProvider, config } from "../tests/helpers.js";
import { startServer } from "../apps/web/src/server.js";

const provider = new MemoryProvider();
const id = config.environments.dev.vault;
provider.listVaults = async () => [{ id, name: "infra" }];
await provider.save(id, "KEY", "fixture-private-value", "alpha beta");
const app = await startServer({ schemas: [], discovery: {}, provider });
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_BROWSER === "chromium" ? undefined : "chrome",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors: string[] = [];
  const edits: Record<string, unknown>[] = [];
  let revealRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.includes("reveal")) revealRequests++;
    if (path === "/api/edit") edits.push(request.postDataJSON());
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
  await cell.click();
  assert.ok((await input.boundingBox())!.height < 50);
  await input.fill("alpha beta");
  await input.press("Home");
  for (let index = 0; index < 5; index++) await input.press("ArrowRight");
  await input.press("Shift+Enter");
  await page.getByRole("button", { name: "Save notes", exact: true }).waitFor();
  assert.ok((await input.boundingBox())!.height > 200);
  assert.equal(await input.inputValue(), "alpha\n beta");
  assert.equal(
    await input.evaluate(
      (element) => (element as HTMLTextAreaElement).selectionStart,
    ),
    6,
  );
  await input.pressSequentially("middle");
  await input.press("Enter");
  assert.equal(await input.inputValue(), "alpha\nmiddle\n beta");
  assert.equal(
    provider.vaults[id][0].notes,
    "alpha beta",
    "Enter in the drawer must add a line instead of saving",
  );
  await input.press("Control+Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Saved notes for KEY in infra" })
    .waitFor();
  assert.equal(provider.vaults[id][0].notes, "alpha\nmiddle\n beta");
  await cell.getByText("3 lines", { exact: true }).waitFor();

  await cell.click();
  await page.getByRole("button", { name: "Save notes", exact: true }).waitFor();
  const multiline =
    "Deployment checklist\n\n  - Verify database connectivity\n  - Rotate credentials after the deploy  \n\nOwner: infra team — 秘密🔑\nTrailing spaces   \n";
  await input.fill(multiline);
  assert.equal(await page.locator(".json-code-editor").count(), 0);
  assert.equal(
    await input.evaluate((element) => getComputedStyle(element).whiteSpace),
    "pre-wrap",
  );
  if (process.env.SCREENSHOT_DIRECTORY) {
    await mkdir(process.env.SCREENSHOT_DIRECTORY, { recursive: true });
    const path = join(
      process.env.SCREENSHOT_DIRECTORY,
      "multiline-notes-editor.png",
    );
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    execFileSync("pay", ["agent", "artifact", "create", "--file", path], {
      stdio: "inherit",
    });
  }
  await page.getByRole("button", { name: "Save notes", exact: true }).click();
  await cell.getByText("8 lines", { exact: true }).waitFor();
  assert.equal(
    provider.vaults[id][0].notes,
    multiline,
    "Whitespace and trailing newlines must be preserved exactly",
  );
  assert.equal(provider.vaults[id][0].value, "fixture-private-value");

  await cell.click();
  await input.fill("discard this\nsecond line");
  await input.press("Escape");
  assert.equal(provider.vaults[id][0].notes, multiline);
  await cell.click();
  assert.equal(await input.inputValue(), multiline);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok((await input.boundingBox())!.width < 390);
  await input.fill("");
  await page.getByRole("button", { name: "Save notes", exact: true }).click();
  await cell.getByText("—", { exact: true }).waitFor();
  assert.equal(provider.vaults[id][0].notes, "");
  await page.setViewportSize({ width: 1440, height: 900 });

  await cell.click();
  await page
    .getByRole("button", { name: "Expand notes editor", exact: true })
    .click();
  await page.getByRole("button", { name: "Save notes", exact: true }).waitFor();
  await input.fill('  {\n    "a": 1\n  }\n');
  await input.press("Control+Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Saved notes for KEY in infra" })
    .waitFor();
  assert.equal(
    provider.vaults[id][0].notes,
    '  {\n    "a": 1\n  }\n',
    "Notes that look like JSON must remain plain text",
  );
  await cell.click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.ok(
    !(await page.locator("body").innerText()).includes("fixture-private-value"),
  );
  assert.equal(revealRequests, 0);
  assert.equal(edits.length, 4);
  assert.ok(
    edits.every((edit) => edit.notes !== undefined && edit.value === undefined),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Verified multiline expansion, caret placement, wrapping, whitespace preservation, save/cancel/clear, mobile layout, and notes-only writes.",
  );
} finally {
  await browser.close();
  await app.close();
}
