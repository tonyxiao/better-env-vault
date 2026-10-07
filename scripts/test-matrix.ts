import assert from "node:assert/strict";
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
  console.log(
    "Reveal/hide all, late-response protection, inline saves, inherited overrides, draft masking, cancellation, and consistent labels passed.",
  );
} finally {
  await browser.close();
  await app.close();
}
