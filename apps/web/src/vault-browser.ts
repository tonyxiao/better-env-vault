import { z } from "zod";
import {
  fingerprint,
  variableName,
} from "../../../packages/core/src/schema.js";
import type {
  Provider,
  VaultInfo,
  VaultItem,
} from "../../../packages/core/src/provider.js";
import {
  connectDiscovery,
  type DiscoveryOptions,
} from "../../../packages/core/src/discovery.js";
import {
  conflict,
  safeError,
  VaultError,
} from "../../../packages/core/src/errors.js";
import {
  publicResolution,
  type Resolution,
} from "../../../packages/core/src/resolver.js";
import { SnapshotCache } from "./snapshot-cache.js";

const environment = "vault";
const name = z.string().regex(variableName);
const value = z
  .string()
  .max(65536)
  .refine((s) => !s.includes("\0"));
const common = {
  fingerprint: z.string(),
  reveal: z.boolean().optional(),
  name,
  versions: z.strictObject({ vault: z.number().int().nullable() }),
};
const editRequest = z.discriminatedUnion("action", [
  z
    .strictObject({
      ...common,
      action: z.literal("set"),
      environment: z.literal(environment),
      value: value.optional(),
      notes: value.optional(),
    })
    .refine((r) => r.value !== undefined || r.notes !== undefined),
  z.strictObject({
    ...common,
    action: z.literal("add"),
    initialValues: z.strictObject({
      vault: z.strictObject({ value, notes: value.optional() }),
    }),
  }),
  z.strictObject({ ...common, action: z.literal("rename"), newName: name }),
  z.strictObject({
    ...common,
    action: z.literal("delete"),
    confirmation: z.string(),
  }),
]);
const deleteRequest = z.strictObject({
  fingerprint: z.string(),
  names: z.array(name).min(1).max(200),
  confirmation: z.literal("DELETE"),
  versions: z.record(
    name,
    z.strictObject({ vault: z.number().int().nullable() }),
  ),
});
function identity(vault: VaultInfo, items: VaultItem[]) {
  return fingerprint(
    JSON.stringify([
      vault.id,
      vault.account,
      items.map((i) => [i.name, i.id]).sort((a, b) => a[0].localeCompare(b[0])),
    ]),
  );
}

/** Vaults are isolated workspaces; no schema file is created or synthesized. */
export class VaultBrowser {
  private pending?: Promise<Provider>;
  private vaults = new Map<string, VaultInfo>();
  private snapshots = new SnapshotCache<VaultItem[]>();
  private inventories = new Map<
    string,
    { fingerprint: string; items: Map<string, { id: string; version: number }> }
  >();
  private reveals = new SnapshotCache<VaultItem>();
  private revisions = new Map<string, number>();
  private warnings = new Map<string, string[]>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    private options: DiscoveryOptions,
    private injected?: Provider,
  ) {}
  private provider() {
    return (this.pending ??= this.injected
      ? Promise.resolve(this.injected)
      : connectDiscovery(this.options));
  }
  async projects() {
    try {
      const provider = await this.provider();
      if (!provider.listVaults)
        throw new VaultError("Vault discovery is unavailable.");
      const vaults = await provider.listVaults();
      this.vaults = new Map(vaults.map((v) => [v.id, v]));
      for (const id of this.inventories.keys())
        if (!this.vaults.has(id)) this.inventories.delete(id);
      return vaults
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        )
        .map((vault) => ({
          id: vault.id,
          name: vault.name,
          mode: "vault",
          vaultId: vault.id,
          account: vault.account,
        }));
    } catch (error) {
      this.reset();
      throw error;
    }
  }
  private vault(id: string) {
    const vault = this.vaults.get(id);
    if (!vault) throw new VaultError("Select an accessible vault.");
    return vault;
  }
  private async items(id: string, fresh = false) {
    this.vault(id);
    const provider = await this.provider();
    return this.snapshots.get(
      id,
      id,
      async () => {
        const read = await provider.readVault(id);
        const counts = new Map<string, number>();
        for (const item of read)
          counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
        const warnings = [...(provider.diagnostics?.(id) ?? [])];
        const items = read.filter((item) => {
          if (variableName.test(item.name) && counts.get(item.name) === 1)
            return true;
          warnings.push(
            `Skipped API Credential ${item.name}: invalid or duplicate variable name.`,
          );
          return false;
        });
        this.warnings.set(id, [...new Set(warnings)]);
        this.inventories.set(id, {
          fingerprint: identity(this.vault(id), items),
          items: new Map(
            items.map((item) => [
              item.name,
              { id: item.id, version: item.version },
            ]),
          ),
        });
        return items;
      },
      fresh,
    );
  }
  async catalog(fresh = false, fingerprints?: Record<string, string>) {
    const environments = await this.projects();
    const matrices: {
      id: string;
      matrix: Awaited<ReturnType<VaultBrowser["matrix"]>>;
    }[] = [];
    const errors: { id: string; name: string; error: string }[] = [];
    // Bound requests while reading every environment, including empty vaults.
    for (let offset = 0; offset < environments.length; offset += 2) {
      await Promise.all(
        environments.slice(offset, offset + 2).map(async (env) => {
          try {
            const matrix = await this.matrix(
              env.id,
              fingerprints !== undefined && Object.hasOwn(fingerprints, env.id),
              fingerprints?.[env.id],
              fresh,
            );
            matrices.push({ id: env.id, matrix });
            const warnings = this.warnings.get(env.id) ?? [];
            if (warnings.length)
              errors.push({
                id: env.id,
                name: env.name,
                error: `Some credentials were skipped. ${warnings.join(" ")} Review these items in 1Password.`,
              });
          } catch (error) {
            if (
              error instanceof VaultError &&
              ["conflict", "authentication"].includes(error.code)
            )
              throw error;
            errors.push({
              id: env.id,
              name: env.name,
              error: safeError(error),
            });
          }
        }),
      );
    }
    const order = new Map(environments.map((env, index) => [env.id, index]));
    matrices.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    errors.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return {
      environments,
      matrices,
      errors,
      auth:
        this.options.auth ??
        (this.options.serviceAccountKeychain ||
        process.env.OP_SERVICE_ACCOUNT_TOKEN
          ? "service-account"
          : "desktop"),
    };
  }
  async matrix(id: string, reveal: boolean, expected?: string, fresh = false) {
    const vault = this.vault(id);
    const items = await this.items(id, fresh);
    const stamp = identity(vault, items);
    if (reveal && expected !== stamp) conflict();
    return this.matrixFromItems(id, items, reveal);
  }
  private matrixFromItems(id: string, items: VaultItem[], reveal: boolean) {
    const vault = this.vault(id);
    const stamp = identity(vault, items);
    const resolution: Resolution = {
      environment,
      chain: [],
      valid: true,
      unmanaged: [],
      variables: [...items]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((item) => ({
          name: item.name,
          description: "",
          type: "string",
          required: false,
          sensitive: true,
          value: item.value,
          hasDefault: false,
          source: environment,
          itemId: item.id,
          state: "explicit",
          valid: true,
          errors: [],
          explicit: { id: item.id, version: item.version },
          editable: true,
        })),
    };
    return {
      mode: "vault",
      revision: this.revisions.get(id) ?? 0,
      fingerprint: stamp,
      config: {
        version: 1,
        provider: "1password",
        auth: "desktop",
        account: vault.account ?? "",
        name: vault.name,
        environments: { vault: { vault: id } },
      },
      schemaPath: "",
      notes: Object.fromEntries(items.map((item) => [item.name, item.notes])),
      environments: [environment],
      vaults: { vault: { id, name: vault.name } },
      resolutions: [reveal ? resolution : publicResolution(resolution)],
      versions: Object.fromEntries(
        items.map((i) => [i.name, { vault: i.version }]),
      ),
      ...(reveal
        ? {
            editableValues: {
              vault: Object.fromEntries(items.map((i) => [i.name, i.value])),
            },
          }
        : {}),
    };
  }
  async reveal(id: string, input: unknown) {
    const parsed = z
      .strictObject({
        environment: z.literal(environment),
        name,
        fingerprint: z.string(),
        itemId: z.string().min(1).optional(),
        version: z.number().int().positive().optional(),
      })
      .refine(
        (data) => (data.itemId === undefined) === (data.version === undefined),
      )
      .safeParse(input);
    if (!parsed.success) throw new VaultError("Invalid reveal request.");
    this.vault(id);
    const provider = await this.provider();
    const cached = this.snapshots.peek(id, id);
    let item: VaultItem | undefined;
    if (cached || !provider.readItem || !this.inventories.has(id)) {
      const items = cached ? await cached : await this.items(id);
      if (parsed.data.fingerprint !== identity(this.vault(id), items))
        conflict();
      item = items.find((i) => i.name === parsed.data.name);
    } else {
      const inventory = this.inventories.get(id)!;
      if (inventory.fingerprint !== parsed.data.fingerprint) conflict();
      const entry = inventory.items.get(parsed.data.name);
      if (!entry) throw new VaultError("Unknown vault variable.");
      item = await this.reveals.get(
        JSON.stringify([id, entry.id]),
        String(entry.version),
        () => provider.readItem!(id, entry.id),
      );
      if (
        item.id !== entry.id ||
        item.name !== parsed.data.name ||
        item.version !== entry.version
      )
        conflict();
    }
    if (!item) throw new VaultError("Unknown vault variable.");
    if (
      parsed.data.itemId !== undefined &&
      (item.id !== parsed.data.itemId || item.version !== parsed.data.version)
    )
      conflict();
    return {
      value: item.value,
      explicitValue: item.value,
      editableValue: item.value,
      notes: item.notes,
    };
  }
  private async serialize<T>(
    id: string,
    work: () => Promise<T>,
    preserveSnapshot = false,
  ) {
    this.vault(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work);
    this.queues.set(id, pending);
    let succeeded = false;
    try {
      const result = await pending;
      succeeded = true;
      return result;
    } finally {
      // Invalidate item reveals before discarding their inventory.
      for (const entry of this.inventories.get(id)?.items.values() ?? [])
        this.reveals.invalidate(JSON.stringify([id, entry.id]));
      if (!succeeded || !preserveSnapshot) {
        this.snapshots.invalidate(id);
        this.inventories.delete(id);
      }

      if (this.queues.get(id) === pending) this.queues.delete(id);
    }
  }
  async edit(id: string, input: unknown) {
    const parsed = editRequest.safeParse(input);
    if (!parsed.success)
      throw new VaultError(
        "Invalid vault edit. Schema operations are unavailable in vault mode.",
      );
    const data = parsed.data;
    return this.serialize(
      id,
      async () => {
        const items = [...(await this.items(id, true))];
        if (data.fingerprint !== identity(this.vault(id), items)) conflict();
        const item = items.find((i) => i.name === data.name);
        if ((item?.version ?? null) !== data.versions.vault) conflict();
        const provider = await this.provider();
        if (data.action === "add") {
          if (item) conflict();
          items.push(
            await provider.save(
              id,
              data.name,
              data.initialValues.vault.value,
              data.initialValues.vault.notes ?? "",
            ),
          );
        } else {
          if (!item) conflict();
          if (data.action === "set")
            items[items.indexOf(item)] = await provider.save(
              id,
              item.name,
              data.value ?? item.value,
              data.notes ?? item.notes,
              item,
            );
          if (data.action === "rename") {
            if (items.some((i) => i.name === data.newName && i.id !== item.id))
              conflict();
            items[items.indexOf(item)] = await provider.rename(
              id,
              item,
              data.newName,
            );
          }
          if (data.action === "delete") {
            if (data.confirmation !== item.name)
              throw new VaultError(
                "Type the variable name to confirm deletion.",
              );
            await provider.remove(id, item);
            items.splice(items.indexOf(item), 1);
          }
        }
        await this.snapshots.get(id, id, async () => items, true);
        this.inventories.set(id, {
          fingerprint: identity(this.vault(id), items),
          items: new Map(
            items.map((item) => [
              item.name,
              { id: item.id, version: item.version },
            ]),
          ),
        });
        this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
        return {
          saved: true,
          matrix: this.matrixFromItems(id, items, data.reveal === true),
        };
      },
      true,
    );
  }
  async deleteMany(id: string, input: unknown) {
    const parsed = deleteRequest.safeParse(input);
    if (
      !parsed.success ||
      new Set(parsed.data.names).size !== parsed.data.names.length
    )
      throw new VaultError("Invalid vault deletion request.");
    const data = parsed.data;
    return this.serialize(id, async () => {
      const items = await this.items(id, true);
      if (data.fingerprint !== identity(this.vault(id), items)) conflict();
      const selected = data.names.map((name) => {
        const item = items.find((i) => i.name === name);
        if (!item || item.version !== data.versions[name]?.vault) conflict();
        if (item.raw && (item.raw.files.length || item.raw.document))
          throw new VaultError(
            "Items with attachments must be deleted in 1Password.",
          );
        return item;
      });
      const provider = await this.provider();
      if (selected.length > 1 && !provider.restore)
        throw new VaultError(
          "This provider cannot safely restore a failed bulk deletion.",
        );
      const removed: VaultItem[] = [];
      try {
        for (const item of selected) {
          await provider.remove(id, item);
          removed.push(item);
        }
      } catch (error) {
        let partial = error instanceof VaultError && error.code === "partial";
        for (const item of removed.reverse()) {
          try {
            await provider.restore!(id, item);
          } catch {
            partial = true;
          }
        }
        if (partial)
          throw new VaultError(
            "Vault deletion was partially completed. Refresh and inspect the selected items in 1Password before retrying.",
            "partial",
            502,
          );
        throw error;
      }
      return { deleted: selected.length };
    });
  }
  reset() {
    this.pending = undefined;
    this.snapshots.clear();
    this.inventories.clear();
    this.reveals.clear();
    this.warnings.clear();
  }
}
