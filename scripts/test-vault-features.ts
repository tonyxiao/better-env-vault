import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { MemoryProvider, config, fixture } from "../tests/helpers.js";
import { startServer } from "../apps/web/src/server.js";

const provider = new MemoryProvider();
const [personal, work, jewelry] = Object.values(config.environments).map(
  (env) => env.vault,
);
provider.listVaults = async () => [
  { id: personal, name: "infra", account: "personal" },
  { id: work, name: "infra", account: "work" },
  { id: jewelry, name: "jewelry", account: "work" },
];
const original = '{"region":"us-west-2","ports":[443,8443]}';
await provider.save(personal, "CONFIG", original, "JSON configuration");
await provider.save(personal, "LABEL", "personal-only", "Label notes");
await provider.save(work, "API_TOKEN", "opaque-needle-123", "Rotate quarterly");
await provider.save(jewelry, "JOBS", "jobs-value", "Job runner");
let reads = 0;
const read = provider.readVault.bind(provider);
provider.readVault = async (id) => {
  reads++;
  return read(id);
};
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
  let revealRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("reveal")) revealRequests++;
  });
  await page.goto(app.launchUrl);
  const search = page.getByRole("textbox", {
    name: "Search secrets across environments",
    exact: true,
  });
  const configCell = page.getByRole("button", {
    name: "Edit CONFIG in infra",
    exact: true,
  });
  const tokenCell = page.getByRole("button", {
    name: "Edit API_TOKEN in infra",
    exact: true,
  });
  await configCell.waitFor();
  const initialReads = reads;
  await search.fill("opaque-needle-123");
  await tokenCell.waitFor();
  assert.equal(await configCell.count(), 0);
  assert.ok(
    !(await page.locator("body").innerText()).includes("opaque-needle-123"),
  );
  await page
    .getByRole("button", { name: "Reveal all values", exact: true })
    .click();
  await tokenCell.getByText("opaque-needle-123", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Hide all values", exact: true })
    .click();
  assert.ok(
    !(await page.locator("body").innerText()).includes("opaque-needle-123"),
  );
  assert.equal(reads, initialReads);
  assert.equal(
    revealRequests,
    0,
    "Search and visibility must not issue reveal requests",
  );

  await search.fill("");
  await page
    .getByRole("combobox", { name: "Group secrets", exact: true })
    .selectOption("environment");
  await page
    .getByRole("treegrid", { name: "Secrets across environments", exact: true })
    .waitFor();
  const personalGroup = page.getByRole("button", {
    name: "Collapse environment infra (personal)",
    exact: true,
  });
  const workGroup = page.getByRole("button", {
    name: "Collapse environment infra (work)",
    exact: true,
  });
  await personalGroup.waitFor();
  await workGroup.waitFor();
  const groupRow = page.getByRole("row").filter({ has: personalGroup });
  await groupRow.getByRole("checkbox").click();
  await page.getByText("2 selected", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await workGroup.click();
  assert.equal(await tokenCell.count(), 0);
  await search.fill("opaque-needle-123");
  await tokenCell.waitFor();
  await search.fill("");

  const notesCell = page.getByRole("button", {
    name: "Edit notes for CONFIG in infra",
    exact: true,
  });
  await notesCell.click();
  const notes = page.getByRole("textbox", {
    name: "Notes for CONFIG in infra",
    exact: true,
  });
  await notes.fill("retained grouped draft");
  await personalGroup.click();
  await page
    .getByRole("status")
    .filter({ hasText: "Unsaved notes draft for CONFIG" })
    .waitFor();
  assert.equal(provider.vaults[personal][0].notes, "JSON configuration");
  await page
    .getByRole("button", {
      name: "Expand environment infra (personal)",
      exact: true,
    })
    .click();
  await notesCell.click();
  assert.equal(await notes.inputValue(), "retained grouped draft");
  await notes.press("Escape");
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  assert.equal(
    reads,
    initialReads,
    "Grouping, collapse, and resumed editing are local",
  );

  async function capture(name: string) {
    if (!process.env.SCREENSHOT_DIRECTORY) return;
    await mkdir(process.env.SCREENSHOT_DIRECTORY, { recursive: true });
    const path = join(process.env.SCREENSHOT_DIRECTORY, name);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    execFileSync("pay", ["agent", "artifact", "create", "--file", path], {
      stdio: "inherit",
    });
  }
  await capture("grouped-environments.png");
  await configCell.click();
  const json = page.getByRole("textbox", {
    name: "JSON value for CONFIG in infra",
    exact: true,
  });
  await json.waitFor();
  assert.ok((await json.inputValue()).includes('\n  "region": "us-west-2"'));
  assert.ok((await page.locator(".json-highlight .json-key").count()) > 0);
  assert.ok((await json.boundingBox())!.height > 200);
  await capture("json-editor.png");
  await json.fill('{"region":}');
  assert.equal(
    await page
      .getByRole("button", { name: "Save JSON", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("alert").filter({ hasText: "Invalid JSON" }).waitFor();
  assert.equal(provider.vaults[personal][0].value, original);
  await json.fill(
    '{\n  "id": 900719925474099312345,\n  "enabled": true,\n  "text": "a  b"\n}',
  );
  await page.getByRole("button", { name: "Save JSON", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Saved CONFIG in infra" })
    .waitFor();
  assert.equal(
    provider.vaults[personal][0].value,
    '{"id":900719925474099312345,"enabled":true,"text":"a  b"}',
  );
  assert.ok(
    !(await page.locator("body").innerText()).includes("900719925474099312345"),
  );
  await search.fill("900719925474099312345");
  await configCell.waitFor();
  assert.equal(await tokenCell.count(), 0);
  await configCell.click();
  await json.waitFor();
  await json.fill('{\n  "id": 900719925474099312345,\n  "enabled": false\n}');
  await json.press("Control+Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Saved CONFIG in infra" })
    .waitFor();
  assert.equal(
    provider.vaults[personal][0].value,
    '{"id":900719925474099312345,"enabled":false}',
  );
  assert.equal(revealRequests, 0);
  await page
    .getByRole("combobox", { name: "Group secrets", exact: true })
    .selectOption("none");
  await page
    .getByRole("grid", { name: "Secrets across environments", exact: true })
    .waitFor();
  // Schema mode uses the same memory-only visibility and JSON editor.
  const schema = await fixture(
    "# @optional\nCONFIG=\n\n# @public\nLABEL=base\n",
  );
  const schemaApp = await startServer({ schemas: [schema.path], provider });
  try {
    const schemaPage = await browser.newPage();
    schemaPage.on("pageerror", (error) => errors.push(error.message));
    let schemaRevealRequests = 0;
    schemaPage.on("request", (request) => {
      if (new URL(request.url()).pathname.includes("reveal"))
        schemaRevealRequests++;
    });
    await schemaPage.goto(schemaApp.launchUrl);
    const schemaCell = schemaPage.getByRole("button", {
      name: "Edit CONFIG in dev",
      exact: true,
    });
    await schemaCell.waitFor();
    await schemaPage
      .getByRole("textbox", { name: "Search variables", exact: true })
      .fill("900719925474099312345");
    await schemaCell.waitFor();
    assert.ok(
      !(await schemaPage.locator("body").innerText()).includes(
        "900719925474099312345",
      ),
    );
    await schemaPage
      .getByRole("button", { name: "Reveal all values", exact: true })
      .click();
    await schemaCell
      .getByText('{"id":900719925474099312345,"enabled":false}', {
        exact: true,
      })
      .waitFor();
    await schemaPage
      .getByRole("button", { name: "Hide all values", exact: true })
      .click();
    await schemaCell.click();
    const schemaJson = schemaPage.getByRole("textbox", {
      name: "JSON value for CONFIG in dev",
      exact: true,
    });
    await schemaJson.waitFor();
    await schemaJson.fill(
      '{\n  "id": 900719925474099312345,\n  "mode": "schema"\n}',
    );
    await schemaPage
      .getByRole("button", { name: "Save JSON", exact: true })
      .click();
    await schemaPage
      .getByRole("status")
      .filter({
        hasText: "Saved. Values are available on the next environment load.",
      })
      .waitFor();
    assert.equal(
      provider.vaults[personal][0].value,
      '{"id":900719925474099312345,"mode":"schema"}',
    );
    assert.equal(schemaRevealRequests, 0);
    await schemaPage.close();
  } finally {
    await schemaApp.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    "Verified grouping, duplicate environment names, selection, collapse, retained drafts, local masked value search/reveal, and lossless highlighted JSON saves.",
  );
} finally {
  await browser.close();
  await app.close();
}
