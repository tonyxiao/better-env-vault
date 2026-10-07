import { internal } from "varlock";
import { ParsedEnvSpecStaticValue } from "@env-spec/parser";
import type { SchemaFile } from "./schema.js";
import { environmentChain } from "./schema.js";
import type { Provider, VaultItem } from "./provider.js";
import { VaultError } from "./errors.js";

export interface ResolvedVariable {
  name: string;
  description: string;
  type: string;
  required: boolean;
  sensitive: boolean;
  value?: string;
  defaultValue?: string;
  hasDefault: boolean;
  source?: string;
  itemId?: string;
  state: "explicit" | "inherited" | "default" | "missing";
  valid: boolean;
  errors: string[];
  explicit?: { id: string; version: number };
  editable: boolean;
}
export interface Resolution {
  environment: string;
  chain: string[];
  variables: ResolvedVariable[];
  unmanaged: { name: string; environment: string; id: string }[];
  valid: boolean;
}
export type VaultSnapshot = Record<string, VaultItem[]>;

export async function readVaults(
  schema: SchemaFile,
  provider: Provider,
  environments = Object.keys(schema.config.environments),
): Promise<VaultSnapshot> {
  const snapshot: VaultSnapshot = Object.create(null);
  // Two requests at a time avoid overwhelming desktop authorization or service limits.
  for (let offset = 0; offset < environments.length; offset += 2) {
    await Promise.all(
      environments.slice(offset, offset + 2).map(async (env) => {
        const items = await provider.readVault(
          schema.config.environments[env].vault,
        );
        const names = new Set<string>();
        for (const item of items) {
          if (names.has(item.name))
            throw new VaultError(`Duplicate items for ${item.name}.`);
          names.add(item.name);
        }
        snapshot[env] = items;
      }),
    );
  }
  return snapshot;
}

export async function schemaGraph(
  schema: SchemaFile,
  environment: string,
  overrides: Record<string, string | undefined> = {},
) {
  try {
    const graph = new internal.EnvGraph();
    graph.overrideValues = overrides;
    graph.processEnvOverride = {};
    graph.envFlagFallback = environment;
    graph._skipCacheMode = true;
    graph.registerRootDecorator({ name: "vaultConfig" });
    const source = new internal.DotEnvFileDataSource(schema.path, {
      overrideContents: schema.text,
    });
    await graph.setRootDataSource(source);
    await graph.finishLoad();
    if (!source.isValid)
      throw new VaultError(
        "Schema decorators are invalid or unsupported. Check the Env Spec definitions.",
      );
    await graph.resolveEnvValues();
    if (!source.isValid)
      throw new VaultError("Schema root metadata could not be resolved.");
    return graph;
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError(
      "Schema resolution failed. Check expressions and decorators.",
    );
  }
}

export async function resolveEnvironment(
  schema: SchemaFile,
  environment: string,
  snapshot: VaultSnapshot,
): Promise<Resolution> {
  const chain = environmentChain(schema.config, environment);
  const keys = new Set(schema.parsed.configItems.map((i) => i.key));
  const overrides: Record<string, string> = Object.create(null);
  const origins = new Map<string, { environment: string; item: VaultItem }>();
  const unmanaged: Resolution["unmanaged"] = [];
  for (const env of chain) {
    for (const item of snapshot[env] ?? []) {
      if (!keys.has(item.name)) {
        unmanaged.push({ name: item.name, environment: env, id: item.id });
        continue;
      }
      overrides[item.name] = item.value;
      origins.set(item.name, { environment: env, item });
    }
  }
  const graph = await schemaGraph(schema, environment, overrides);
  const defaults = await schemaGraph(schema, environment);
  const variables = schema.parsed.configItems.map((definition) => {
    const item = graph.configSchema[definition.key];
    const base = defaults.configSchema[definition.key];
    const origin = origins.get(definition.key);
    // Sensitive literal defaults are forbidden even when a vault would shadow them.
    if (
      (item.isSensitive || base.isSensitive) &&
      definition.value instanceof ParsedEnvSpecStaticValue &&
      definition.value.value !== undefined &&
      definition.value.value !== ""
    ) {
      throw new VaultError(
        `Sensitive ${definition.key} has a literal schema default. Move its value to 1Password.`,
      );
    }
    const value = item.resolvedEnvStringValue;
    const errors = item.errors
      .filter((e) => !e.isWarning)
      .map(
        (e) =>
          `${e.constructor.name}: check ${definition.key}'s schema requirements.`,
      );
    if (value?.includes("\0"))
      errors.push("Environment values cannot contain NUL.");
    // Reveal neither values nor upstream error messages in diagnostics.
    const state: ResolvedVariable["state"] = origin
      ? origin.environment === environment
        ? "explicit"
        : "inherited"
      : value === undefined
        ? "missing"
        : "default";
    return {
      name: definition.key,
      description: definition.description,
      type:
        definition.decoratorsObject.type?.data.value?.toString() ?? "string",
      required: item.isRequired,
      sensitive: item.isSensitive || base.isSensitive,
      value,
      defaultValue: base.resolvedEnvStringValue,
      hasDefault: base.resolvedEnvStringValue !== undefined,
      source:
        origin?.environment ?? (value === undefined ? undefined : "schema"),
      itemId: origin?.item.id,
      state,
      valid: item.isValid && errors.length === 0,
      errors,
      explicit:
        origin?.environment === environment
          ? { id: origin.item.id, version: origin.item.version }
          : undefined,
      editable:
        !definition.value ||
        definition.value instanceof ParsedEnvSpecStaticValue,
    };
  });
  return {
    environment,
    chain,
    variables,
    unmanaged,
    valid: variables.every((v) => v.valid),
  };
}

export function publicResolution(resolution: Resolution) {
  return {
    ...resolution,
    variables: resolution.variables.map(
      ({ value, defaultValue, ...record }) => ({
        ...record,
        ...(!record.sensitive ? { value, defaultValue } : {}),
      }),
    ),
  };
}

export function exportValues(resolution: Resolution): Record<string, string> {
  if (!resolution.valid)
    throw new VaultError(
      "Environment validation failed: " +
        resolution.variables
          .filter((v) => !v.valid)
          .map((v) => v.name)
          .join(", "),
    );
  return Object.fromEntries(
    resolution.variables
      .filter((v) => v.value !== undefined)
      .map((v) => [v.name, v.value!]),
  );
}
