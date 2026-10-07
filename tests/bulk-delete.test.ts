import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fixture, MemoryProvider, config } from "./helpers.js";
import { applyDeleteMany } from "../packages/core/src/edit.js";
import { loadSchema } from "../packages/core/src/schema.js";
import { readVaults } from "../packages/core/src/resolver.js";

async function setup(
  definitions = "# @optional\nA=\n\n# @optional\nB=\n\n# @public\nKEEP=base\n",
) {
  const schema = await fixture(definitions);
  const provider = new MemoryProvider();
  await provider.save(
    config.environments.dev.vault,
    "A",
    "a-fixture",
    "keep-a-notes",
  );
  await provider.save(
    config.environments.prod.vault,
    "A",
    "a-prod-fixture",
    "",
  );
  await provider.save(
    config.environments.staging.vault,
    "B",
    "b-fixture",
    "keep-b-notes",
  );
  await provider.save(
    config.environments.dev.vault,
    "UNMANAGED",
    "unmanaged-fixture",
    "",
  );
  const snapshot = await readVaults(schema, provider);
  const versions = Object.fromEntries(
    ["A", "B"].map((name) => [
      name,
      Object.fromEntries(
        Object.keys(config.environments).map((environment) => [
          environment,
          snapshot[environment].find((item) => item.name === name)?.version ??
            null,
        ]),
      ),
    ]),
  );
  return {
    schema,
    provider,
    payload: {
      fingerprint: schema.fingerprint,
      names: ["A", "B"],
      confirmation: "DELETE",
      versions,
    },
  };
}
it("deletes all selected definitions and configured items while preserving unrelated data", async () => {
  const { schema, provider, payload } = await setup();
  const unmanaged = structuredClone(
    provider.vaults[config.environments.dev.vault].find(
      (item) => item.name === "UNMANAGED",
    ),
  );
  expect(await applyDeleteMany(schema.path, provider, payload)).toEqual({
    saved: true,
    deleted: ["A", "B"],
  });
  expect(
    (await loadSchema(schema.path)).parsed.configItems.map((item) => item.key),
  ).toEqual(["KEEP"]);
  expect(
    Object.values(provider.vaults)
      .flat()
      .some((item) => ["A", "B"].includes(item.name)),
  ).toBe(false);
  expect(
    provider.vaults[config.environments.dev.vault].find(
      (item) => item.name === "UNMANAGED",
    ),
  ).toEqual(unmanaged);
});
it("checks every selected version before any removal", async () => {
  const { schema, provider, payload } = await setup();
  payload.versions.B.staging = 0;
  const calls = provider.calls;
  await expect(applyDeleteMany(schema.path, provider, payload)).rejects.toThrow(
    "changed",
  );
  expect(provider.calls).toBe(calls);
  expect(await readFile(schema.path, "utf8")).toBe(schema.text);
});
it("rejects duplicate, undeclared, unconfirmed, and stale selections", async () => {
  const { schema, provider, payload } = await setup();
  const calls = provider.calls;
  for (const request of [
    { ...payload, names: ["A", "A"] },
    { ...payload, names: ["UNMANAGED"] },
    { ...payload, confirmation: "" },
    { ...payload, fingerprint: "stale" },
  ])
    await expect(
      applyDeleteMany(schema.path, provider, request),
    ).rejects.toThrow();
  expect(provider.calls).toBe(calls);
});
it("rolls back removed items if a later removal fails", async () => {
  const { schema, provider, payload } = await setup();
  provider.failAt = provider.calls + 2;
  await expect(
    applyDeleteMany(schema.path, provider, payload),
  ).rejects.toThrow();
  expect(await readFile(schema.path, "utf8")).toBe(schema.text);
  const all = Object.values(provider.vaults).flat();
  expect(all.filter((item) => item.name === "A")).toHaveLength(2);
  expect(
    all.find((item) => item.name === "A" && item.notes === "keep-a-notes")
      ?.value,
  ).toBe("a-fixture");
  expect(all.find((item) => item.name === "B")?.notes).toBe("keep-b-notes");
});
it("reports partial deletion when rollback cannot restore an item", async () => {
  const { schema, provider, payload } = await setup();
  provider.failAt = provider.calls + 2;
  provider.save = async () => {
    throw new Error("private-fixture-error");
  };
  await expect(
    applyDeleteMany(schema.path, provider, payload),
  ).rejects.toMatchObject({ code: "partial" });
  expect(await readFile(schema.path, "utf8")).toBe(schema.text);
});
it("rejects breaking references, but permits deleting a dependent group together", async () => {
  const schema = await fixture(
    '# @public\nHOST=example.test\n\n# @public\nURL=concat("https://",ref(HOST))\n\n# @public\nKEEP=base\n',
  );
  const provider = new MemoryProvider();
  const empty = Object.fromEntries(
    Object.keys(config.environments).map((env) => [env, null]),
  );
  await expect(
    applyDeleteMany(schema.path, provider, {
      fingerprint: schema.fingerprint,
      names: ["HOST"],
      confirmation: "DELETE",
      versions: { HOST: empty },
    }),
  ).rejects.toThrow();
  expect(provider.calls).toBe(0);
  await applyDeleteMany(schema.path, provider, {
    fingerprint: schema.fingerprint,
    names: ["HOST", "URL"],
    confirmation: "DELETE",
    versions: { HOST: empty, URL: empty },
  });
  expect(
    (await loadSchema(schema.path)).parsed.configItems.map((item) => item.key),
  ).toEqual(["KEEP"]);
});
