import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { MemoryProvider, config } from "../tests/helpers.js";
import { startServer } from "../apps/web/src/server.js";

const provider = new MemoryProvider();
const [slow, fast, other] = Object.values(config.environments).map(
  (env) => env.vault,
);
provider.listVaults = async () => [
  { id: slow, name: "Slow vault" },
  { id: fast, name: "Fast vault" },
  { id: other, name: "Other vault" },
];
await provider.save(slow, "SLOW_KEY", "late-value", "");
await provider.save(fast, "FAST_KEY", "unicode-秘密🔑", "Fast notes");
await provider.save(other, "OTHER_KEY", "other-value", "");
let release!: () => void;
const gate = new Promise<void>((done) => (release = done));
const read = provider.readVault.bind(provider);
provider.readVault = async (id) => {
  if (id === slow) await gate;
  return read(id);
};
const app = await startServer({ schemas: [], discovery: {}, provider });
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_BROWSER === "chromium" ? undefined : "chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  const fastCell = page.getByRole("button", {
    name: "Edit FAST_KEY in Fast vault",
    exact: true,
  });
  const slowCell = page.getByRole("button", {
    name: "Edit SLOW_KEY in Slow vault",
    exact: true,
  });
  await fastCell.waitFor();
  await page
    .getByRole("status")
    .filter({ hasText: "2 of 3 vaults complete" })
    .waitFor();
  if (process.env.SCREENSHOT_DIRECTORY) {
    await mkdir(process.env.SCREENSHOT_DIRECTORY, { recursive: true });
    const path = join(
      process.env.SCREENSHOT_DIRECTORY,
      "progressive-vault-loading.png",
    );
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    execFileSync("pay", ["agent", "artifact", "create", "--file", path], {
      stdio: "inherit",
    });
  }
  assert.equal(
    await slowCell.count(),
    0,
    "Fast vaults must render while the slow vault is still pending",
  );
  assert.equal(
    await fastCell.isDisabled(),
    true,
    "Inline editing waits for the inventory to stop moving",
  );
  await page.getByRole("gridcell").filter({ has: fastCell }).click();
  await page.keyboard.press("Enter");
  assert.equal(
    await page
      .getByRole("textbox", {
        name: "FAST_KEY value in Fast vault",
        exact: true,
      })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Filter environment Slow vault", exact: true })
    .getByText("…", { exact: true })
    .waitFor();
  await page
    .getByRole("textbox", {
      name: "Search secrets across environments",
      exact: true,
    })
    .fill("秘密🔑");
  await fastCell.waitFor();
  await page
    .getByRole("button", { name: "Reveal all values", exact: true })
    .click();
  await fastCell.getByText("unicode-秘密🔑", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Hide all values", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Group secrets", exact: true })
    .selectOption("environment");
  await page
    .getByRole("button", {
      name: "Collapse environment Fast vault",
      exact: true,
    })
    .waitFor();
  release();
  await page
    .getByRole("button", { name: "Refresh secrets", exact: true })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      !(
        document.querySelector(
          'button[aria-label="Refresh secrets"]',
        ) as HTMLButtonElement
      )?.disabled,
  );
  await page
    .getByRole("textbox", {
      name: "Search secrets across environments",
      exact: true,
    })
    .fill("");
  await slowCell.waitFor();
  assert.equal(await fastCell.isEnabled(), true);
  assert.equal(
    await page
      .getByRole("status")
      .filter({ hasText: "vaults complete" })
      .count(),
    0,
  );
  await fastCell.click();
  const input = page.getByRole("textbox", {
    name: "FAST_KEY value in Fast vault",
    exact: true,
  });
  assert.equal(await input.inputValue(), "unicode-秘密🔑");
  await input.fill("updated-after-stream");
  await input.press("Control+Enter");
  await page
    .getByRole("status")
    .filter({ hasText: "Saved FAST_KEY in Fast vault" })
    .waitFor();
  assert.equal(provider.vaults[fast][0].value, "updated-after-stream");
  // Compatibility for an older CLI still running with a rebuilt web bundle.
  await page.route(/\/api\/catalog(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.delete("stream");
    await route.fulfill({
      response: await route.fetch({ url: url.toString() }),
    });
  });
  await page
    .getByRole("button", { name: "Refresh secrets", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !(
        document.querySelector(
          'button[aria-label="Refresh secrets"]',
        ) as HTMLButtonElement
      )?.disabled,
  );
  await fastCell.waitFor();
  assert.equal(await fastCell.isEnabled(), true);
  await page.unroute(/\/api\/catalog(?:\?|$)/);
  assert.deepEqual(errors, []);
  console.log(
    "Verified first-vault rendering, progress counts, local value search/reveal during loading, grouping, and editing after completion.",
  );
} finally {
  release();
  await browser.close();
  await app.close();
}
