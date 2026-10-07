/** Browser verification with deliberately delayed/failed saves. No 1Password access. */
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { fixture, MemoryProvider, config } from "../tests/helpers.js";
import { configurationText } from "../packages/core/src/schema.js";
import { startServer } from "../apps/web/src/server.js";
const definitions =
  "# @optional\nTOKEN=\n\n# @public @optional\nLABEL=base\n\n# @public @type=number\nCOUNT=1\n";
const schema = await fixture(definitions);
const other = await fixture(definitions);
const otherConfig = {
  ...config,
  name: "Second project",
  environments: {
    dev: { vault: "d".repeat(26) },
    staging: { vault: "e".repeat(26), extends: "dev" },
    prod: { vault: "f".repeat(26), extends: "staging" },
  },
};
await writeFile(other.path, configurationText(otherConfig) + definitions);
const provider = new MemoryProvider();
for (const env of Object.values(otherConfig.environments))
  provider.vaults[env.vault] = [];
await provider.save(config.environments.dev.vault, "TOKEN", "dev-fixture", "");
await provider.save(
  config.environments.prod.vault,
  "TOKEN",
  "prod-fixture",
  "",
);
const app = await startServer({ schemas: [schema.path, other.path], provider });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const gates = new Map<string, { wait: Promise<void>; release: () => void }>();
function hold(name: string) {
  let release!: () => void;
  const wait = new Promise<void>((done) => {
    release = done;
  });
  gates.set(name, { wait, release });
  return release;
}
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/503|409/.test(message.text()))
      errors.push(message.text());
  });
  let rejectNext = false;
  await page.route("**/api/edit*", async (route) => {
    const data = route.request().postDataJSON();
    const gate = gates.get(data.name);
    if (gate) await gate.wait;
    if (rejectNext && data.name === "LABEL") {
      rejectNext = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Fixture save failed.",
          code: "provider",
        }),
      });
    } else await route.continue();
  });
  await page.goto(app.launchUrl);
  const grid = page.getByRole("grid", {
    name: "Environment values",
    exact: true,
  });
  await grid.getByText("Inherits dev", { exact: true }).first().waitFor();
  assert.equal(await grid.getAttribute("aria-colcount"), "6");
  const reveal = page.getByRole("button", {
    name: "Reveal all values",
    exact: true,
  });
  await reveal.click();
  await page
    .getByText("All matrix values are visible.", { exact: true })
    .waitFor();
  function form(name: string, env: string) {
    return page.getByRole("form", {
      name: `Edit ${name} in ${env}`,
      exact: true,
    });
  }
  async function edit(name: string, env: string) {
    await page
      .getByRole("button", { name: `Edit ${name} in ${env}`, exact: true })
      .click();
    await form(name, env).getByRole("textbox").waitFor();
    return form(name, env);
  }
  async function settled() {
    await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector(".field-progress"),
    );
  }
  const firstRow = grid.locator('[role="row"][aria-rowindex="2"]');
  const nextRow = grid.locator('[role="row"][aria-rowindex="3"]');
  const gridBefore = await grid.boundingBox();
  const rowBefore = await firstRow.boundingBox();
  const nextBefore = await nextRow.boundingBox();
  assert.equal(rowBefore!.height, 72);
  const releaseToken = hold("TOKEN"),
    releaseLabel = hold("LABEL");
  await (await edit("TOKEN", "prod"))
    .getByRole("textbox")
    .fill("pending-token-fixture");
  assert.equal(
    (await firstRow.boundingBox())!.height,
    rowBefore!.height,
    "Editing never changes the row height.",
  );
  assert.equal(
    (await nextRow.boundingBox())!.y,
    nextBefore!.y,
    "Editing never moves the next row.",
  );
  assert.equal(
    (await grid.boundingBox())!.height,
    gridBefore!.height,
    "Editing never resizes the grid.",
  );
  assert.ok(
    (await form("TOKEN", "prod").getByRole("textbox").boundingBox())!.height <=
      32,
    "The value editor is one compact line.",
  );
  await form("TOKEN", "prod")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page
    .getByRole("status", { name: "Saving TOKEN in prod", exact: true })
    .waitFor();
  assert.ok(
    await page
      .getByRole("textbox", { name: "Search variables", exact: true })
      .isEnabled(),
  );
  assert.ok(
    await page
      .getByRole("combobox", { name: "Filter variables", exact: true })
      .isEnabled(),
  );
  assert.ok(
    await page
      .getByRole("combobox", { name: "Schema", exact: true })
      .isEnabled(),
  );
  assert.ok(
    await page
      .getByRole("button", { name: "Hide all values", exact: true })
      .isEnabled(),
  );
  assert.equal(
    (await provider.readVault(config.environments.prod.vault)).find(
      (v) => v.name === "TOKEN",
    )!.value,
    "prod-fixture",
  );
  await (await edit("LABEL", "prod"))
    .getByRole("textbox")
    .fill("pending-label-fixture");
  await form("LABEL", "prod")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page
    .getByRole("status", { name: "Saving LABEL in prod", exact: true })
    .waitFor();
  await (await edit("COUNT", "prod")).getByRole("textbox").fill("7");
  await page
    .getByRole("button", { name: "Hide all values", exact: true })
    .click();
  assert.ok(
    !(await page.locator("body").innerText()).includes("pending-token-fixture"),
  );
  assert.equal(
    await form("COUNT", "prod").getByRole("textbox").inputValue(),
    "7",
  );
  releaseLabel();
  gates.delete("LABEL");
  await page
    .getByRole("status", { name: "Saving LABEL in prod", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    await form("COUNT", "prod").getByRole("textbox").inputValue(),
    "7",
    "Another field finishing must preserve the active draft.",
  );
  releaseToken();
  gates.delete("TOKEN");
  await page
    .getByRole("status", { name: "Saving TOKEN in prod", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    await form("COUNT", "prod").getByRole("textbox").inputValue(),
    "7",
  );
  await form("COUNT", "prod").getByRole("textbox").press("Tab");
  await form("COUNT", "prod").waitFor({ state: "hidden" });
  await settled();
  assert.equal(
    (await provider.readVault(config.environments.prod.vault)).find(
      (v) => v.name === "COUNT",
    )!.value,
    "7",
  );
  assert.equal(
    (await grid.boundingBox())!.y,
    gridBefore!.y,
    "Save confirmation never moves the grid.",
  );
  assert.equal(
    (await nextRow.boundingBox())!.y,
    nextBefore!.y,
    "Completing a save never moves neighbouring rows.",
  );
  const devLabel = grid.locator('[role="gridcell"]').filter({
    has: page.getByRole("button", { name: "Edit LABEL in dev", exact: true }),
  });
  await devLabel.click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("F2");
  await form("LABEL", "staging").getByRole("textbox").waitFor();
  await form("LABEL", "staging").getByRole("textbox").fill("keyboard-fixture");
  await form("LABEL", "staging").getByRole("textbox").press("Tab");
  await form("LABEL", "prod").getByRole("textbox").waitFor();
  await settled();
  assert.equal(
    (await provider.readVault(config.environments.staging.vault)).find(
      (v) => v.name === "LABEL",
    )!.value,
    "keyboard-fixture",
  );
  await page.keyboard.press("Escape");
  await form("LABEL", "prod").waitFor({ state: "hidden" });
  rejectNext = true;
  await (await edit("LABEL", "dev")).getByRole("textbox").fill("retry-fixture");
  await form("LABEL", "dev")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await grid
    .getByRole("alert")
    .filter({ hasText: "Fixture save failed." })
    .waitFor();
  assert.equal(
    (await nextRow.boundingBox())!.height,
    72,
    "A save failure never expands the row.",
  );
  assert.ok(
    await page
      .getByRole("button", { name: "Edit TOKEN in prod", exact: true })
      .isEnabled(),
  );
  await edit("LABEL", "dev");
  assert.equal(
    await form("LABEL", "dev").getByRole("textbox").inputValue(),
    "retry-fixture",
    "Failed drafts must be retained for correction.",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Retry saving LABEL in dev", exact: true })
    .click();
  await grid.getByRole("alert").waitFor({ state: "hidden" });
  await settled();
  assert.equal(
    (await provider.readVault(config.environments.dev.vault)).find(
      (v) => v.name === "LABEL",
    )!.value,
    "retry-fixture",
  );
  const labelBefore = (
    await provider.readVault(config.environments.staging.vault)
  ).find((v) => v.name === "LABEL")!;
  await edit("LABEL", "staging");
  await form("LABEL", "staging").getByRole("textbox").press("Enter");
  await form("COUNT", "staging").getByRole("textbox").waitFor();
  assert.equal(
    (await provider.readVault(config.environments.staging.vault)).find(
      (v) => v.name === "LABEL",
    )!.version,
    labelBefore.version,
    "Enter on an unchanged cell navigates without writing an override.",
  );
  await form("COUNT", "staging").getByRole("textbox").fill("5");
  await form("COUNT", "staging").getByRole("textbox").press("Enter");
  await settled();
  assert.equal(
    (await provider.readVault(config.environments.staging.vault)).find(
      (v) => v.name === "COUNT",
    )!.value,
    "5",
  );
  await (await edit("LABEL", "staging"))
    .getByRole("textbox")
    .fill("click-away-fixture");
  await page
    .getByRole("button", { name: "Edit COUNT in prod", exact: true })
    .click();
  await form("COUNT", "prod").getByRole("textbox").waitFor();
  await settled();
  assert.equal(
    (await provider.readVault(config.environments.staging.vault)).find(
      (v) => v.name === "LABEL",
    )!.value,
    "click-away-fixture",
    "Clicking another cell commits the changed draft.",
  );
  await page.keyboard.press("Escape");
  await (await edit("LABEL", "staging")).getByRole("textbox").fill("line-one");
  await form("LABEL", "staging").getByRole("textbox").press("Alt+Enter");
  await form("LABEL", "staging").getByRole("textbox").press("l");
  await form("LABEL", "staging").getByRole("textbox").press("Control+Enter");
  await settled();
  assert.equal(
    (await provider.readVault(config.environments.staging.vault)).find(
      (v) => v.name === "LABEL",
    )!.value,
    "line-one\nl",
    "Alt+Enter preserves literal newlines without changing row height.",
  );
  await (await edit("LABEL", "staging")).getByRole("textbox").fill("");
  await form("LABEL", "staging").getByRole("textbox").press("Control+Enter");
  await settled();
  assert.equal(
    (await provider.readVault(config.environments.staging.vault)).find(
      (v) => v.name === "LABEL",
    )!.value,
    "",
    "Clearing a populated cell saves an explicit empty override.",
  );
  await edit("TOKEN", "staging");
  await form("TOKEN", "staging").getByRole("textbox").press("Enter");
  await form("LABEL", "staging").getByRole("textbox").waitFor();
  assert.ok(
    !(await provider.readVault(config.environments.staging.vault)).some(
      (v) => v.name === "TOKEN",
    ),
    "Unchanged inherited cells never create overrides.",
  );
  await page.keyboard.press("Escape");
  await page.route("**/api/reveal?*", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "Fixture read failed.", code: "conflict" }),
    }),
  );
  await edit("LABEL", "dev");
  await form("LABEL", "dev").getByRole("alert").waitFor();
  assert.equal(
    await form("LABEL", "dev")
      .getByRole("button", { name: "Cancel", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
    "A failed read must leave keyboard focus on Cancel.",
  );
  await page.keyboard.press("Escape");
  await form("LABEL", "dev").waitFor({ state: "hidden" });
  await page.unroute("**/api/reveal?*");
  const releaseLate = hold("TOKEN");
  await (await edit("TOKEN", "prod"))
    .getByRole("textbox")
    .fill("late-project-fixture");
  await form("TOKEN", "prod")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page
    .getByRole("status", { name: "Saving TOKEN in prod", exact: true })
    .waitFor();
  await page
    .getByRole("combobox", { name: "Schema", exact: true })
    .selectOption("1");
  await grid
    .getByText("Inherits schema default", { exact: true })
    .first()
    .waitFor();
  await (await edit("LABEL", "prod"))
    .getByRole("textbox")
    .fill("other-project-draft");
  releaseLate();
  gates.delete("TOKEN");
  await page.waitForFunction(() => !document.querySelector(".field-progress"));
  await page.waitForTimeout(250);
  assert.equal(
    await form("LABEL", "prod").getByRole("textbox").inputValue(),
    "other-project-draft",
  );
  assert.ok(
    !(await page.locator("body").innerText()).includes("late-project-fixture"),
  );
  assert.ok(
    !(await provider.readVault(otherConfig.environments.prod.vault)).some(
      (v) => v.name === "TOKEN",
    ),
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 800, height: 900 });
  const variableCell = grid
    .locator('[role="gridcell"][aria-colindex="2"]')
    .first();
  const before = (await variableCell.boundingBox())!.x;
  await grid.evaluate((element) => {
    element.scrollLeft = 300;
  });
  await page.waitForTimeout(100);
  assert.equal(
    (await variableCell.boundingBox())!.x,
    before,
    "Variable names remain frozen during horizontal scrolling.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await grid.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await edit("LABEL", "prod");
  const mobileField = await form("LABEL", "prod")
    .getByRole("textbox")
    .boundingBox();
  assert.ok(
    mobileField &&
      mobileField.x >= 0 &&
      mobileField.x + mobileField.width <= 390,
    "Mobile editors remain fully visible without a frozen column covering them.",
  );
  await page.keyboard.press("Escape");
  await mkdir(".local", { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("combobox", { name: "Schema", exact: true })
    .selectOption("0");
  await grid.getByText("Inherits dev", { exact: true }).first().waitFor();
  await edit("LABEL", "dev");
  await page.screenshot({
    path: ".local/spreadsheet-editor.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, [], "The grid must have no runtime or CSP errors.");
  console.log(
    "Fixed row/grid geometry, Enter/Tab/click-away commits, multiline and empty values, nonblocking saves, draft preservation, masking, error recovery, keyboard navigation, project isolation, and mobile layout passed.",
  );
} finally {
  for (const gate of gates.values()) gate.release();
  await browser.close();
  await app.close();
}
