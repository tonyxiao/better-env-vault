import {
  createClient,
  DesktopAuth,
  ItemCategory,
  ItemFieldType,
  ItemState,
  DesktopSessionExpiredError,
  AuthExpiredError,
  RateLimitExceededError,
  type Client,
  type Item,
} from "@1password/sdk";
import type { ProjectConfig } from "./schema.js";
import { variableName } from "./schema.js";
import { VaultError, conflict } from "./errors.js";
import { readServiceAccountToken } from "./keychain.js";

export interface VaultItem {
  id: string;
  version: number;
  name: string;
  value: string;
  notes: string;
  raw?: Item;
}
export interface VaultInfo {
  id: string;
  name: string;
  account?: string;
}

export interface Provider {
  listVaults?(): Promise<VaultInfo[]>;
  takeInitialVaults?(): VaultInfo[] | undefined;
  diagnostics?(vaultId: string): string[];
  readVault(vaultId: string): Promise<VaultItem[]>;
  readItem?(vaultId: string, itemId: string): Promise<VaultItem>;
  save(
    vaultId: string,
    name: string,
    value: string,
    notes: string,
    previous?: VaultItem,
  ): Promise<VaultItem>;
  remove(vaultId: string, previous: VaultItem): Promise<void>;
  rename(
    vaultId: string,
    previous: VaultItem,
    name: string,
  ): Promise<VaultItem>;
  restore?(vaultId: string, previous: VaultItem): Promise<VaultItem>;
}

export function normalizeItems(
  items: Item[],
  config: ProjectConfig,
  onSkipped?: (message: string) => void,
): VaultItem[] {
  const counts = new Map<string, number>();
  for (const item of items.filter(
    (item) => item.category === ItemCategory.ApiCredentials,
  ))
    counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
  const normalized: VaultItem[] = [];
  for (const item of items.filter(
    (item) => item.category === ItemCategory.ApiCredentials,
  )) {
    try {
      if (!variableName.test(item.title))
        throw new VaultError(
          `An API Credential item has an invalid variable name: ${item.title}.`,
        );
      if (counts.get(item.title)! > 1)
        throw new VaultError(
          `Duplicate API Credential items for ${item.title}.`,
        );
      const fieldId = config.legacyFields?.[item.title] ?? "credential";
      const fields = item.fields.filter((field) => field.id === fieldId);
      if (fields.length !== 1)
        throw new VaultError(
          `Missing or ambiguous credential field for ${item.title}.`,
        );
      normalized.push({
        id: item.id,
        version: item.version,
        name: item.title,
        value: fields[0].value,
        notes: item.notes,
        raw: item,
      });
    } catch (error) {
      if (!onSkipped) throw error;
      onSkipped((error as Error).message);
    }
  }
  return normalized;
}

export class OnePasswordProvider implements Provider {
  private allowed: Set<string>;
  private initialVaults?: VaultInfo[];
  takeInitialVaults() {
    const vaults = this.initialVaults;
    this.initialVaults = undefined;
    return vaults;
  }
  private warnings = new Map<string, string[]>();
  diagnostics(vaultId: string) {
    return this.warnings.get(vaultId) ?? [];
  }
  constructor(
    public client: Client,
    private config: ProjectConfig,
    private discovery = false,
  ) {
    this.allowed = new Set(
      Object.values(config.environments).map((e) => e.vault),
    );
  }
  static async connect(config: ProjectConfig, discovery = false) {
    try {
      const token =
        config.auth === "service-account"
          ? config.serviceAccountKeychain
            ? await readServiceAccountToken(config.serviceAccountKeychain)
            : process.env.OP_SERVICE_ACCOUNT_TOKEN
          : undefined;
      if (config.auth === "service-account" && !token)
        throw new VaultError(
          "Set serviceAccountKeychain in .env.schema or OP_SERVICE_ACCOUNT_TOKEN in the CLI/server environment.",
        );
      const client = await createClient({
        auth: token ?? new DesktopAuth(config.account),
        integrationName: "Better Env Vault",
        integrationVersion: "0.1.0",
      });
      const provider = new OnePasswordProvider(client, config, discovery);
      // Listing through this authenticated client checks every configured ID against its account/scope.
      const vaults = await client.vaults.list();
      if (discovery) provider.allowed = new Set(vaults.map((v) => v.id));
      for (const id of provider.allowed)
        if (!vaults.some((v) => v.id === id))
          throw new VaultError(
            "A configured vault is unavailable in the selected 1Password account.",
          );
      provider.initialVaults = vaults
        .filter((vault) => provider.allowed.has(vault.id))
        .map((vault) => ({ id: vault.id, name: vault.title }));
      return provider;
    } catch (error) {
      throw error instanceof VaultError
        ? error
        : new VaultError(
            "1Password connection failed. Unlock the desktop app and enable SDK integration, or check your service account permissions.",
            "provider",
            502,
          );
    }
  }
  async listVaults(): Promise<VaultInfo[]> {
    const initial = this.takeInitialVaults();
    if (initial) return initial;
    const vaults = await this.call(() => this.client.vaults.list());
    if (this.discovery) this.allowed = new Set(vaults.map((v) => v.id));
    return vaults
      .filter((vault) => this.allowed.has(vault.id))
      .map((vault) => ({ id: vault.id, name: vault.title }));
  }
  private check(vaultId: string) {
    this.initialVaults = undefined;
    if (!this.allowed.has(vaultId))
      throw new VaultError("Vault is outside this project.");
  }
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof VaultError) throw error;
      if (
        error instanceof DesktopSessionExpiredError ||
        error instanceof AuthExpiredError
      )
        throw new VaultError(
          "1Password authorization expired. Unlock the app and refresh to reconnect, or renew your service-account token.",
          "authentication",
          502,
        );
      if (error instanceof RateLimitExceededError)
        throw new VaultError(
          "1Password rate limit reached. Wait before refreshing.",
          "rate-limit",
          429,
        );
      throw new VaultError(
        "1Password operation failed. Check authorization and permissions, then refresh before retrying.",
        "provider",
        502,
      );
    }
  }
  async readVault(vaultId: string) {
    this.check(vaultId);
    return this.call(async () => {
      const list = (await this.client.items.list(vaultId)).filter(
        (i) =>
          i.category === ItemCategory.ApiCredentials &&
          i.state === ItemState.Active,
      );
      const items: Item[] = [];
      // Batch requests are sequential; each batch bounds decrypted data and SDK request sizes.
      for (let offset = 0; offset < list.length; offset += 50) {
        const batch = await this.client.items.getAll(
          vaultId,
          list.slice(offset, offset + 50).map((i) => i.id),
        );
        if (
          batch.individualResponses.length !==
          Math.min(50, list.length - offset)
        )
          throw new VaultError(
            "1Password returned an incomplete item batch.",
            "provider",
            502,
          );
        for (const response of batch.individualResponses) {
          if (response.error || !response.content)
            throw new VaultError(
              "An item could not be read. Refresh and check permissions.",
              "provider",
              502,
            );
          if (response.content.vaultId !== vaultId)
            throw new VaultError(
              "1Password returned an item from an unexpected vault.",
              "provider",
              502,
            );
          items.push(response.content);
        }
      }
      const warnings: string[] = [];
      const normalized = normalizeItems(
        items,
        this.config,
        this.discovery ? (message) => warnings.push(message) : undefined,
      );
      this.warnings.set(vaultId, warnings);
      return normalized;
    });
  }
  async readItem(vaultId: string, itemId: string): Promise<VaultItem> {
    this.check(vaultId);
    return this.call(async () => {
      const item = await this.client.items.get(vaultId, itemId);
      if (
        item.vaultId !== vaultId ||
        item.id !== itemId ||
        item.category !== ItemCategory.ApiCredentials
      )
        throw new VaultError(
          "1Password returned an unexpected credential item.",
          "provider",
          502,
        );
      return normalizeItems([item], this.config)[0];
    });
  }
  private async fresh(vaultId: string, previous: VaultItem): Promise<Item> {
    this.check(vaultId);
    const item = await this.client.items.get(vaultId, previous.id);
    if (item.version !== previous.version || item.title !== previous.name)
      conflict();
    return item;
  }
  async save(
    vaultId: string,
    name: string,
    value: string,
    notes: string,
    previous?: VaultItem,
  ) {
    this.check(vaultId);
    if (!variableName.test(name) || value.includes("\0"))
      throw new VaultError("Invalid variable name or value.");
    return this.call(async () => {
      let result: Item;
      if (previous) {
        const item = await this.fresh(vaultId, previous);
        if (previous.value === value && previous.notes === notes)
          return previous;
        const fieldId = this.config.legacyFields?.[name] ?? "credential";
        const field = item.fields.find((f) => f.id === fieldId);
        if (!field) throw new VaultError("Credential field is missing.");
        field.value = value;
        item.notes = notes;
        result = await this.client.items.put(item);
      } else {
        if (
          this.config.legacyFields?.[name] &&
          this.config.legacyFields[name] !== "credential"
        )
          throw new VaultError(
            "Remove the legacy field mapping before creating a new credential item for this variable.",
          );
        // Discovery may skip malformed/duplicate credentials in the editor,
        // but an existing title must still block creating another duplicate.
        const existing = await this.client.items.list(vaultId);
        if (
          existing.some(
            (i) =>
              i.category === ItemCategory.ApiCredentials &&
              i.state === ItemState.Active &&
              i.title === name,
          )
        )
          conflict();
        result = await this.client.items.create({
          vaultId,
          title: name,
          category: ItemCategory.ApiCredentials,
          notes,
          fields: [
            {
              id: "credential",
              title: "credential",
              fieldType: ItemFieldType.Concealed,
              value,
            },
          ],
        });
      }
      try {
        const verified = await this.client.items.get(vaultId, result.id);
        const normalized = normalizeItems([verified], this.config)[0];
        if (normalized.value !== value || normalized.notes !== notes)
          throw new Error("verification");
        return normalized;
      } catch {
        throw new VaultError(
          `1Password save could not be verified for item ${result.id}. Refresh and inspect it before retrying.`,
          "partial",
          502,
        );
      }
    });
  }
  async remove(vaultId: string, previous: VaultItem) {
    return this.call(async () => {
      const item = await this.fresh(vaultId, previous);
      if (item.files.length || item.document)
        throw new VaultError(
          "Items with attachments cannot be deleted by this editor. Review them in 1Password.",
        );
      // SDK deletion has no conditional version parameter. This recheck narrows, but cannot eliminate, the external race.
      await this.client.items.delete(vaultId, previous.id);
      try {
        if ((await this.readVault(vaultId)).some((i) => i.id === previous.id))
          throw new Error("verification");
      } catch {
        throw new VaultError(
          `Deletion could not be verified for item ${previous.id}.`,
          "partial",
          502,
        );
      }
    });
  }
  async rename(vaultId: string, previous: VaultItem, name: string) {
    if (!variableName.test(name))
      throw new VaultError("Invalid variable name.");
    return this.call(async () => {
      const item = await this.fresh(vaultId, previous);
      if (this.discovery) {
        const existing = await this.client.items.list(vaultId);
        if (
          existing.some(
            (i) =>
              i.id !== previous.id &&
              i.category === ItemCategory.ApiCredentials &&
              i.state === ItemState.Active &&
              i.title === name,
          )
        )
          conflict();
      }
      item.title = name;
      const updated = await this.client.items.put(item);
      try {
        const verified = await this.client.items.get(vaultId, updated.id);
        if (verified.title !== name) throw new Error("verification");
        return normalizeItems([verified], this.config)[0];
      } catch {
        throw new VaultError(
          `Rename could not be verified for item ${updated.id}.`,
          "partial",
          502,
        );
      }
    });
  }
  async restore(vaultId: string, previous: VaultItem) {
    this.check(vaultId);
    return this.call(async () => {
      if (
        (await this.readVault(vaultId)).some(
          (item) => item.name === previous.name,
        )
      )
        conflict();
      if (!previous.raw || previous.raw.files.length || previous.raw.document)
        throw new VaultError(
          "Deleted item cannot be safely recreated.",
          "partial",
          502,
        );
      const { fields, sections, notes, tags, websites, category } =
        previous.raw;
      const item = await this.client.items.create({
        vaultId,
        title: previous.name,
        fields,
        sections,
        notes,
        tags,
        websites,
        category,
      });
      const restored = normalizeItems(
        [await this.client.items.get(vaultId, item.id)],
        this.config,
      )[0];
      if (
        restored.value !== previous.value ||
        restored.notes !== previous.notes
      )
        throw new VaultError(
          `Restoration could not be verified for item ${item.id}.`,
          "partial",
          502,
        );
      return restored;
    });
  }
}
