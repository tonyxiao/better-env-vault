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
        const items = await provider.readVault(id);
        const names = new Set<string>();
        for (const item of items) {
          if (!variableName.test(item.name) || names.has(item.name))
            throw new VaultError(
              "This vault contains invalid or duplicate API Credential names. Review them in 1Password.",
            );
          names.add(item.name);
        }
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
            matrices.push({
              id: env.id,
              matrix: await this.matrix(
                env.id,
                fingerprints !== undefined &&
                  Object.hasOwn(fingerprints, env.id),
                fingerprints?.[env.id],
                fresh,
              ),
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
      })
      .safeParse(input);
    if (!parsed.success) throw new VaultError("Invalid reveal request.");
    const items = await this.items(id);
    if (parsed.data.fingerprint !== identity(this.vault(id), items)) conflict();
    const item = items.find((i) => i.name === parsed.data.name);
    if (!item) throw new VaultError("Unknown vault variable.");
    return {
      value: item.value,
      explicitValue: item.value,
      editableValue: item.value,
      notes: item.notes,
    };
  }
  private async serialize<T>(id: string, work: () => Promise<T>) {
    this.vault(id);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work);
    this.queues.set(id, pending);
    try {
      return await pending;
    } finally {
      this.snapshots.invalidate(id);
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
    return this.serialize(id, async () => {
      const items = await this.items(id, true);
      if (data.fingerprint !== identity(this.vault(id), items)) conflict();
      const item = items.find((i) => i.name === data.name);
      if ((item?.version ?? null) !== data.versions.vault) conflict();
      const provider = await this.provider();
      if (data.action === "add") {
        if (item) conflict();
        await provider.save(
          id,
          data.name,
          data.initialValues.vault.value,
          data.initialValues.vault.notes ?? "",
        );
      } else {
        if (!item) conflict();
        if (data.action === "set")
          await provider.save(
            id,
            item.name,
            data.value ?? item.value,
            data.notes ?? item.notes,
            item,
          );
        if (data.action === "rename") {
          if (items.some((i) => i.name === data.newName && i.id !== item.id))
            conflict();
          await provider.rename(id, item, data.newName);
        }
        if (data.action === "delete") {
          if (data.confirmation !== item.name)
            throw new VaultError("Type the variable name to confirm deletion.");
          await provider.remove(id, item);
        }
      }
      return { saved: true };
    });
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
  }
}
