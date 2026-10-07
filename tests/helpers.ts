import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configurationText,
  loadSchema,
  type ProjectConfig,
} from "../packages/core/src/schema.js";
import { conflict } from "../packages/core/src/errors.js";
import type { Provider, VaultItem } from "../packages/core/src/provider.js";

export const config: ProjectConfig = {
  version: 1,
  provider: "1password",
  auth: "desktop",
  account: "example-account",
  defaultEnvironment: "dev",
  environments: {
    dev: { vault: "a".repeat(26) },
    staging: { vault: "b".repeat(26), extends: "dev" },
    prod: { vault: "c".repeat(26), extends: "staging" },
  },
};
export async function fixture(definitions: string) {
  const directory = await mkdtemp(join(tmpdir(), "bev-test-"));
  const path = join(directory, ".env.schema");
  await writeFile(path, configurationText(config) + definitions, {
    mode: 0o640,
  });
  return loadSchema(path);
}
export class MemoryProvider implements Provider {
  vaults: Record<string, VaultItem[]> = Object.fromEntries(
    Object.values(config.environments).map((e) => [e.vault, []]),
  );
  calls = 0;
  failAt?: number;
  private nextId = 0;
  async readVault(vault: string) {
    return structuredClone(this.vaults[vault] ?? []);
  }
  async save(
    vault: string,
    name: string,
    value: string,
    notes: string,
    previous?: VaultItem,
  ) {
    if (++this.calls === this.failAt)
      throw new Error("injected secret-bearing error");
    const items = this.vaults[vault];
    const existing = items.find((i) => i.name === name);
    if (
      (previous && existing?.version !== previous.version) ||
      (!previous && existing)
    )
      conflict();
    if (existing) {
      if (existing.value !== value || existing.notes !== notes) {
        existing.value = value;
        existing.notes = notes;
        existing.version++;
      }
      return structuredClone(existing);
    }
    const item = { id: String(++this.nextId), version: 1, name, value, notes };
    items.push(item);
    return structuredClone(item);
  }
  async remove(vault: string, previous: VaultItem) {
    if (++this.calls === this.failAt) throw new Error("injected");
    if (
      this.vaults[vault].find((i) => i.id === previous.id)?.version !==
      previous.version
    )
      conflict();
    this.vaults[vault] = this.vaults[vault].filter((i) => i.id !== previous.id);
  }
  async rename(vault: string, previous: VaultItem, name: string) {
    if (++this.calls === this.failAt) throw new Error("injected");
    const item = this.vaults[vault].find((i) => i.id === previous.id);
    if (item?.version !== previous.version) conflict();
    item.name = name;
    item.version++;
    return structuredClone(item);
  }
}
