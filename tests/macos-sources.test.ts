import { expect, it } from "vitest";
import { appSources, sourceId } from "../apps/macos/sources.js";
import { parseDesktopAccounts } from "../packages/core/src/discovery.js";

it("lists multiple service and desktop accounts without a four-source limit", () => {
  const accounts = Array.from({ length: 15 }, (_, n) => ({
    id: `account-${n}`,
    label: `Account ${n}`,
  }));
  const sources = appSources(
    {
      schemas: [],
      discovery: {
        auth: "service-account",
        serviceAccountKeychain: "better-env-vault",
      },
    },
    ["work", "better-env-vault", "staging", "work"],
    accounts,
  );
  expect(sources).toHaveLength(18);
  expect(sources[0].id).toBe("service:better-env-vault");
  expect(sources.filter((s) => s.discovery?.auth === "desktop")).toHaveLength(
    15,
  );
  expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
});
it("keeps named credentials and desktop accounts isolated and preserves the selected source", () => {
  const config = {
    schemas: [],
    discovery: { auth: "desktop" as const, account: "selected" },
  };
  const sources = appSources(
    config,
    ["work"],
    [{ id: "other", label: "Other" }],
  );
  expect(sourceId(config)).toBe("desktop:selected");
  expect(sources.find((s) => s.id === sourceId(config))?.discovery).toEqual(
    config.discovery,
  );
  expect(sources.find((s) => s.id === "service:work")?.discovery).toEqual({
    auth: "service-account",
    serviceAccountKeychain: "work",
  });
  expect(sources.find((s) => s.id === "desktop:other")?.discovery).toEqual({
    auth: "desktop",
    account: "other",
  });
});
it("preserves schema mode and provides desktop setup when account discovery is unavailable", () => {
  const config = { schemas: ["/project/.env.schema"] };
  const sources = appSources(config, [], []);
  expect(sources[0]).toEqual({
    id: "schemas",
    label: "Project schemas",
    schemas: config.schemas,
  });
  expect(sources.some((s) => s.id === "desktop:auto")).toBe(true);
});
it("sanitizes account metadata and excludes URL credentials and query payloads", () => {
  const records = parseDesktopAccounts([
    {
      account_uuid: "account-1",
      url: "https://username:credential@example.1password.com/path?payload=private",
      email: "owner@example.com",
    },
    {
      account_uuid: "account-1",
      url: "example.1password.com",
      email: "owner@example.com",
    },
    { account_uuid: "invalid id" },
  ]);
  expect(records).toEqual([
    { id: "account-1", label: "example.1password.com · owner@example.com" },
  ]);
  expect(parseDesktopAccounts({})).toEqual([]);
  expect(
    appSources(
      { schemas: [], discovery: { auth: "desktop" } },
      ["../invalid"],
      [],
    ).some((s) => s.id.includes("invalid")),
  ).toBe(false);
});
