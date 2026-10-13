import { describe, expect, it, vi } from "vitest";
import {
  ItemCategory,
  ItemFieldType,
  ItemState,
  type Client,
  type Item,
} from "@1password/sdk";
import { OnePasswordProvider } from "../packages/core/src/provider.js";
import { safeError } from "../packages/core/src/errors.js";
import { config } from "./helpers.js";

const vault = config.environments.dev.vault;
function fixture() {
  const item: Item = {
    id: "item-id",
    title: "KEY",
    category: ItemCategory.ApiCredentials,
    vaultId: vault,
    fields: [
      {
        id: "credential",
        title: "credential",
        fieldType: ItemFieldType.Concealed,
        value: "private-content",
      },
    ],
    sections: [],
    notes: "user notes",
    tags: ["user-tag"],
    websites: [],
    version: 7,
    files: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const client = {
    items: {
      list: vi.fn(async () => [{ ...item, state: ItemState.Active }]),
      getAll: vi.fn(async () => ({
        individualResponses: [{ content: structuredClone(item) }],
      })),
      get: vi.fn(async () => structuredClone(item)),
      put: vi.fn(async (input: Item) => {
        Object.assign(item, structuredClone(input), {
          version: item.version + 1,
        });
        return structuredClone(item);
      }),
      create: vi.fn(async (input: Partial<Item>) => {
        Object.assign(item, input, { version: 1 });
        return structuredClone(item);
      }),
      delete: vi.fn(async () => {}),
    },
  };
  return {
    item,
    client,
    provider: new OnePasswordProvider(client as unknown as Client, config),
  };
}

describe("SDK adapter contract", () => {
  it("limits requests to configured vaults and rejects failed batch entries without raw diagnostics", async () => {
    const { provider, client } = fixture();
    await expect(provider.readVault("outside")).rejects.toThrow("outside");
    expect(client.items.list).not.toHaveBeenCalled();
    client.items.getAll.mockRejectedValueOnce(
      new Error("private-content raw SDK response"),
    );
    let error: unknown;
    try {
      await provider.readVault(vault);
    } catch (caught) {
      error = caught;
    }
    expect(safeError(error)).not.toContain("private-content");
  });
  it("passes item versions to SDK updates and preserves unrelated fields and tags", async () => {
    const { provider, client, item } = fixture();
    const previous = (await provider.readVault(vault))[0];
    await provider.save(vault, "KEY", "new", previous.notes, previous);
    expect(client.items.put.mock.calls[0][0]).toMatchObject({
      version: 7,
      tags: ["user-tag"],
      notes: "user notes",
    });
    expect(item.version).toBe(8);
    await expect(
      provider.save(vault, "KEY", "stale", "", previous),
    ).rejects.toThrow("changed");
  });
  it("does not write or bump versions for a no-op", async () => {
    const { provider, client } = fixture();
    const previous = (await provider.readVault(vault))[0];
    await provider.save(vault, "KEY", previous.value, previous.notes, previous);
    expect(client.items.put).not.toHaveBeenCalled();
  });
  it("reports an accepted save with failed verification as partial, including its item ID", async () => {
    const { provider, client } = fixture();
    const previous = (await provider.readVault(vault))[0];
    client.items.get
      .mockImplementationOnce(async () => previous.raw!)
      .mockRejectedValueOnce(new Error("private-content"));
    await expect(
      provider.save(vault, "KEY", "new", "", previous),
    ).rejects.toMatchObject({
      code: "partial",
      message: expect.stringContaining("item-id"),
    });
  });
  it("refuses attachment deletion and preserves metadata when recreating a deleted item", async () => {
    const { provider, client, item } = fixture();
    const previous = (await provider.readVault(vault))[0];
    item.files = [
      {
        attributes: { id: "file", name: "attachment", size: 1 },
        fieldId: "field",
        sectionId: "section",
      },
    ];
    await expect(provider.remove(vault, previous)).rejects.toThrow(
      "attachments",
    );
    expect(client.items.delete).not.toHaveBeenCalled();
    item.files = [];
    client.items.list.mockResolvedValueOnce([]);
    await provider.restore(vault, previous);
    expect(client.items.create.mock.calls[0][0]).toMatchObject({
      title: "KEY",
      tags: ["user-tag"],
      notes: "user notes",
      fields: previous.raw!.fields,
    });
  });
});

it("limits discovery operations to vaults returned by the authenticated client", async () => {
  const { client } = fixture();
  const list = vi.fn(async () => [{ id: vault, title: "Available vault" }]);
  const provider = new OnePasswordProvider(
    { ...client, vaults: { list } } as unknown as Client,
    { ...config, environments: {} },
    true,
  );
  await expect(provider.readVault(vault)).rejects.toThrow("outside");
  expect(await provider.listVaults()).toEqual([
    { id: vault, name: "Available vault" },
  ]);
  await expect(provider.readVault(vault)).resolves.toHaveLength(1);
  list.mockResolvedValueOnce([]);
  await provider.listVaults();
  await expect(provider.readVault(vault)).rejects.toThrow("outside");
});

it("reads a selected credential through one SDK item request and verifies its scope", async () => {
  const { provider, client, item } = fixture();
  const value = await provider.readItem(vault, item.id);
  expect(value.value).toBe("private-content");
  expect(client.items.get).toHaveBeenCalledWith(vault, item.id);
  expect(client.items.list).not.toHaveBeenCalled();
  expect(client.items.getAll).not.toHaveBeenCalled();
  await expect(provider.readItem("outside", item.id)).rejects.toThrow(
    "outside",
  );
  item.vaultId = "wrong-vault";
  await expect(provider.readItem(vault, item.id)).rejects.toThrow("unexpected");
});

it("skips incompatible discovery credentials while preserving strict schema validation", async () => {
  const { client, item } = fixture();
  const incompatible = { ...item, id: "bad-id", title: "Human readable name" };
  client.items.list.mockResolvedValue([
    { ...item, state: ItemState.Active },
    { ...incompatible, state: ItemState.Active },
  ]);
  client.items.getAll.mockResolvedValue({
    individualResponses: [{ content: item }, { content: incompatible }],
  });
  const discovery = new OnePasswordProvider(
    client as unknown as Client,
    config,
    true,
  );
  expect(await discovery.readVault(vault)).toHaveLength(1);
  expect(discovery.diagnostics(vault)[0]).toContain("Human readable name");
  const strict = new OnePasswordProvider(client as unknown as Client, config);
  await expect(strict.readVault(vault)).rejects.toThrow(
    "invalid variable name",
  );
});

it("does not create another credential when discovery hides duplicate titles", async () => {
  const { client, item } = fixture();
  const duplicate = { ...item, id: "duplicate-id" };
  client.items.list.mockResolvedValue([
    { ...item, state: ItemState.Active },
    { ...duplicate, state: ItemState.Active },
  ]);
  client.items.getAll.mockResolvedValue({
    individualResponses: [{ content: item }, { content: duplicate }],
  });
  const provider = new OnePasswordProvider(
    client as unknown as Client,
    config,
    true,
  );
  expect(await provider.readVault(vault)).toEqual([]);
  await expect(provider.save(vault, "KEY", "new", "")).rejects.toThrow(
    "changed",
  );
  expect(client.items.create).not.toHaveBeenCalled();
});

it("rejects renaming to a title belonging to a skipped credential", async () => {
  const { client, item } = fixture();
  const provider = new OnePasswordProvider(
    client as unknown as Client,
    config,
    true,
  );
  const previous = (await provider.readVault(vault))[0];
  client.items.list.mockResolvedValueOnce([
    { ...item, id: "bad-target", title: "TARGET", state: ItemState.Active },
  ]);
  await expect(provider.rename(vault, previous, "TARGET")).rejects.toThrow(
    "changed",
  );
  expect(client.items.put).not.toHaveBeenCalled();
});
