import { ParsedEnvSpecStaticValue } from "@env-spec/parser";
import { z } from "zod";
import {
  assertUnchanged,
  configSchema,
  configurationDecoratorText,
  literal,
  loadSchema,
  parseSchema,
  sourceRange,
  variableName,
  writeSchema,
  type SchemaFile,
} from "./schema.js";
import { conflict, VaultError } from "./errors.js";
import type { Provider, VaultItem } from "./provider.js";
import {
  readVaults,
  resolveEnvironment,
  type VaultSnapshot,
} from "./resolver.js";

const name = z.string().regex(variableName);
const common = {
  fingerprint: z.string(),
  name,
  versions: z.record(z.string(), z.number().int().nullable()),
};
export const editRequest = z.discriminatedUnion("action", [
  z
    .strictObject({
      ...common,
      action: z.literal("set"),
      environment: z.string(),
      value: z.string().max(65536).optional(),
      notes: z.string().max(65536).optional(),
    })
    .refine(
      (request) => request.value !== undefined || request.notes !== undefined,
    ),
  z.strictObject({
    ...common,
    action: z.literal("remove"),
    environment: z.string(),
  }),
  z.strictObject({
    ...common,
    action: z.literal("default"),
    value: z.string().max(65536),
  }),
  z.strictObject({
    ...common,
    action: z.literal("definition"),
    description: z.string().max(4096).optional(),
    type: z.string().max(512).optional(),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
  }),
  z.strictObject({
    ...common,
    action: z.literal("add"),
    description: z.string().max(4096).default(""),
    type: z.string().max(512).default("string"),
    required: z.boolean().default(false),
    sensitive: z.boolean().default(true),
    defaultValue: z.string().max(65536).optional(),
    initialValues: z
      .record(
        z.string(),
        z.strictObject({
          value: z.string().max(65536),
          notes: z.string().max(65536).optional(),
        }),
      )
      .optional(),
  }),
  z.strictObject({ ...common, action: z.literal("rename"), newName: name }),
  z.strictObject({
    ...common,
    action: z.literal("delete"),
    confirmation: z.string(),
  }),
  z.strictObject({
    action: z.literal("config"),
    fingerprint: z.string(),
    config: configSchema,
  }),
]);
export type EditRequest = z.infer<typeof editRequest>;
type Replacement = { start: number; end: number; text: string };
function replace(text: string, changes: Replacement[]) {
  for (const change of changes.sort((a, b) => b.start - a.start))
    text = text.slice(0, change.start) + change.text + text.slice(change.end);
  return text;
}

export function editSchemaText(
  schema: SchemaFile,
  request: EditRequest,
): string {
  const eol = schema.text.includes("\r\n") ? "\r\n" : "\n";
  if (request.action === "config") {
    const decorator = schema.parsed.decoratorsObject.vaultConfig;
    const location = decorator.data._location;
    return replace(schema.text, [
      {
        start: location.start.offset,
        end: location.end.offset,
        text: configurationDecoratorText(request.config, eol),
      },
    ]);
  }
  const item = schema.parsed.configItems.find((i) => i.key === request.name);
  if (request.action === "add") {
    if (item) throw new VaultError("Variable is already declared.");
    if (request.sensitive && request.defaultValue)
      throw new VaultError("Sensitive defaults must stay in 1Password.");
    if (/[\r\n#@]/.test(request.type))
      throw new VaultError("Invalid type decorator.");
    const description = request.description
      .split(/\r?\n/)
      .map((line) => `# ${line.replaceAll("@", "\\@")}${eol}`)
      .join("");
    return (
      schema.text +
      (schema.text.endsWith(eol) ? eol : eol + eol) +
      description +
      `# @type=${request.type} @required=${request.required} @sensitive=${request.sensitive}${eol}${request.name}=${request.defaultValue === undefined ? "" : literal(request.defaultValue)}${eol}`
    );
  }
  if (!item)
    throw new VaultError(
      "Variable is not declared in the schema. Adopt it before editing.",
    );
  const range = sourceRange(item);
  if (request.action === "delete")
    return replace(schema.text, [{ ...range, text: "" }]);
  if (request.action === "set" || request.action === "remove")
    return schema.text;
  const original = schema.text.slice(range.start, range.end);
  const match = new RegExp(`^(?:export\\s+)?${request.name}\\s*=`, "m").exec(
    original,
  );
  if (!match) throw new VaultError("This definition cannot be safely edited.");
  const keyStart =
    range.start +
    match.index +
    (match[0].startsWith("export") ? match[0].indexOf(request.name) : 0);
  if (request.action === "rename") {
    if (schema.parsed.configItems.some((i) => i.key === request.newName))
      throw new VaultError("Destination variable is already declared.");
    // Renames with expressions may leave ref(OLD) dependencies; reject rather than rewrite code.
    if (
      schema.parsed.configItems.some(
        (i) => i.value && !(i.value instanceof ParsedEnvSpecStaticValue),
      )
    )
      throw new VaultError(
        "Renaming requires reviewing schema expressions. Rename this variable manually.",
      );
    if (schema.config.legacyFields?.[request.name])
      throw new VaultError(
        "Remove or update the legacy field mapping before renaming this variable.",
      );
    return replace(schema.text, [
      {
        start: keyStart,
        end: keyStart + request.name.length,
        text: request.newName,
      },
    ]);
  }
  if (request.action === "default") {
    if (item.value && !(item.value instanceof ParsedEnvSpecStaticValue))
      throw new VaultError("Expression defaults are read-only in this editor.");
    const loc = item.data.value?.data._location;
    const assignmentEnd = range.start + match.index + match[0].length;
    return replace(schema.text, [
      {
        start: loc?.start.offset ?? assignmentEnd,
        end: loc?.end.offset ?? assignmentEnd,
        text: literal(request.value),
      },
    ]);
  }
  const changes: Replacement[] = [];
  const additions: string[] = [];
  for (const [key, value] of Object.entries({
    type: request.type,
    required: request.required,
    sensitive: request.sensitive,
  })) {
    if (value === undefined) continue;
    if (key === "type" && /[\r\n#@]/.test(String(value)))
      throw new VaultError("Invalid type decorator.");
    const existing = item.decoratorsObject[key];
    const text = `@${key}=${value}`;
    if (existing) {
      const loc = existing.data._location;
      if (!loc) throw new VaultError("This decorator cannot be safely edited.");
      changes.push({ start: loc.start.offset, end: loc.end.offset, text });
    } else additions.push(text);
    // Remove semantic aliases only when replacing their matching property.
    const alias =
      key === "required"
        ? "optional"
        : key === "sensitive"
          ? "public"
          : undefined;
    if (alias && item.decoratorsObject[alias]) {
      const loc = item.decoratorsObject[alias].data._location;
      changes.push({ start: loc.start.offset, end: loc.end.offset, text: "" });
    }
  }
  if (request.description !== undefined) {
    // Change regular description comments only; keep all decorator comments intact.
    const regular = item.data.preComments.filter((c) => !("decorators" in c));
    for (const comment of regular) {
      const loc = comment.data._location;
      if (loc)
        changes.push({
          start: loc.start.offset,
          end: loc.end.offset,
          text: "",
        });
    }
    additions.unshift(
      ...request.description
        .split(/\r?\n/)
        .map((line) => line.replaceAll("@", "\\@")),
    );
  }
  if (additions.length)
    changes.push({
      start: range.start,
      end: range.start,
      text: additions.map((line) => `# ${line}${eol}`).join(""),
    });
  return replace(schema.text, changes);
}

function checkVersions(
  schema: SchemaFile,
  snapshot: VaultSnapshot,
  request: Exclude<EditRequest, { action: "config" }>,
) {
  const environments =
    request.action === "set" || request.action === "remove"
      ? [request.environment]
      : Object.keys(schema.config.environments);
  for (const env of environments) {
    if (!Object.hasOwn(schema.config.environments, env))
      throw new VaultError("Unknown environment.");
    if (!Object.hasOwn(request.versions, env))
      throw new VaultError(
        "Supply the current item version for each affected environment.",
      );
    const previous = snapshot[env].find((i) => i.name === request.name);
    if ((previous?.version ?? null) !== request.versions[env]) conflict();
  }
}

const queues = new Map<string, Promise<unknown>>();
export async function applyEdit(
  schemaPath: string,
  provider: Provider,
  rawRequest: unknown,
) {
  const parsed = editRequest.safeParse(rawRequest);
  if (!parsed.success) throw new VaultError("Invalid edit request.");
  return serializeEdit(schemaPath, () =>
    performEdit(schemaPath, provider, parsed.data),
  );
}

async function serializeEdit<T>(
  schemaPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(schemaPath) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(operation);
  queues.set(schemaPath, work);
  try {
    return await work;
  } finally {
    if (queues.get(schemaPath) === work) queues.delete(schemaPath);
  }
}

export const bulkDeleteRequest = z.strictObject({
  fingerprint: z.string(),
  names: z
    .array(name)
    .min(1)
    .max(200)
    .refine((names) => new Set(names).size === names.length),
  confirmation: z.literal("DELETE"),
  versions: z.record(name, z.record(z.string(), z.number().int().nullable())),
});

export async function applyDeleteMany(
  schemaPath: string,
  provider: Provider,
  raw: unknown,
) {
  const parsed = bulkDeleteRequest.safeParse(raw);
  if (!parsed.success)
    throw new VaultError(
      "Select unique variables and type DELETE to confirm deletion.",
    );
  return serializeEdit(schemaPath, async () => {
    const request = parsed.data;
    const schema = await loadSchema(schemaPath);
    if (schema.fingerprint !== request.fingerprint) conflict();
    const declared = new Set(schema.parsed.configItems.map((item) => item.key));
    if (request.names.some((name) => !declared.has(name)))
      throw new VaultError(
        "Only declared variables can be deleted. Refresh the schema.",
      );
    const snapshot = await readVaults(schema, provider);
    for (const name of request.names) {
      const versions = request.versions[name];
      if (!versions)
        throw new VaultError(
          "Supply item versions for every selected variable.",
        );
      checkVersions(schema, snapshot, {
        action: "delete",
        name,
        versions,
        fingerprint: request.fingerprint,
        confirmation: name,
      });
    }
    let proposed = schema;
    for (const name of request.names) {
      const text = editSchemaText(proposed, {
        action: "delete",
        name,
        fingerprint: request.fingerprint,
        versions: request.versions[name],
        confirmation: name,
      });
      proposed = { ...proposed, text, ...parseSchema(text) };
    }
    const selected = new Set(request.names);
    const simulated = Object.fromEntries(
      Object.entries(snapshot).map(([environment, items]) => [
        environment,
        items.filter((item) => !selected.has(item.name)),
      ]),
    );
    for (const environment of Object.keys(schema.config.environments)) {
      const result = await resolveEnvironment(proposed, environment, simulated);
      if (
        result.variables.some((variable) =>
          variable.errors.some((error) => error.startsWith("SchemaError")),
        )
      )
        throw new VaultError(
          "Deletion would break remaining schema definitions. Update references or select the dependent variables too.",
        );
    }
    const removed: { environment: string; item: VaultItem }[] = [];
    try {
      for (const [environment, items] of Object.entries(snapshot)) {
        for (const item of items) {
          if (!selected.has(item.name)) continue;
          await assertUnchanged(schema);
          await provider.remove(
            schema.config.environments[environment].vault,
            item,
          );
          removed.push({ environment, item });
        }
      }
      await writeSchema(schema, proposed.text);
      return { saved: true, deleted: request.names };
    } catch (error) {
      const failures: string[] = [];
      for (const { environment, item } of removed.reverse()) {
        try {
          const vault = schema.config.environments[environment].vault;
          if (provider.restore) await provider.restore(vault, item);
          else await provider.save(vault, item.name, item.value, item.notes);
        } catch {
          failures.push(`${environment}:${item.id}`);
        }
      }
      if (
        failures.length ||
        (error instanceof VaultError && error.code === "partial")
      )
        throw new VaultError(
          `Partial deletion. Refresh and inspect affected items in 1Password before retrying: ${failures.join(", ") || "the selected variables"}.`,
          "partial",
          502,
        );
      throw error;
    }
  });
}

async function performEdit(
  schemaPath: string,
  provider: Provider,
  request: EditRequest,
) {
  const schema = await loadSchema(schemaPath);
  if (schema.fingerprint !== request.fingerprint) conflict();
  if (request.action === "config") {
    const text = editSchemaText(schema, request);
    const proposed = { ...schema, text, ...parseSchema(text) };
    // Check definitions in the new environment context without contacting newly configured vaults.
    for (const env of Object.keys(proposed.config.environments))
      await resolveEnvironment(proposed, env, {});
    await writeSchema(schema, text);
    return { saved: true };
  }
  const snapshot = await readVaults(schema, provider);
  checkVersions(schema, snapshot, request);
  if (request.action === "add") {
    for (const environment of Object.keys(request.initialValues ?? {})) {
      if (!Object.hasOwn(schema.config.environments, environment))
        throw new VaultError(
          "Initial values must target environments declared in the schema.",
        );
    }
  }
  if (request.action === "delete" && request.confirmation !== request.name)
    throw new VaultError(
      "Type the variable name to confirm deletion from every environment.",
    );
  if (
    request.action === "rename" &&
    Object.values(snapshot).some((items) =>
      items.some((i) => i.name === request.newName),
    )
  )
    throw new VaultError("Destination name already exists in a vault.");
  const text = editSchemaText(schema, request);
  const proposed = { ...schema, text, ...parseSchema(text) };
  const simulated: VaultSnapshot = Object.fromEntries(
    Object.entries(snapshot).map(([env, items]) => [
      env,
      items.map((i) => ({ ...i })),
    ]),
  );
  if (request.action === "set") {
    const items = simulated[request.environment];
    const item = items.find((i) => i.name === request.name);
    if (item) {
      if (request.value !== undefined) item.value = request.value;
    } else {
      if (request.value === undefined)
        throw new VaultError(
          "Set a value before adding notes to a new override.",
        );
      items.push({
        id: "pending",
        version: 0,
        name: request.name,
        value: request.value,
        notes: request.notes ?? "",
      });
    }
  } else if (request.action === "add") {
    for (const [env, initial] of Object.entries(request.initialValues ?? {})) {
      const item = simulated[env].find((i) => i.name === request.name);
      if (item) item.value = initial.value;
      else
        simulated[env].push({
          id: "pending",
          version: 0,
          name: request.name,
          value: initial.value,
          notes: initial.notes ?? "",
        });
    }
  } else if (request.action === "rename") {
    for (const items of Object.values(simulated))
      for (const item of items)
        if (item.name === request.name) item.name = request.newName;
  } else if (request.action === "remove" || request.action === "delete") {
    for (const env of Object.keys(simulated))
      if (request.action === "delete" || env === request.environment)
        simulated[env] = simulated[env].filter((i) => i.name !== request.name);
  }
  for (const env of Object.keys(schema.config.environments)) {
    const resolved = await resolveEnvironment(proposed, env, simulated);
    const key = request.action === "rename" ? request.newName : request.name;
    const item = resolved.variables.find((v) => v.name === key);
    // Adding an unfilled required variable is allowed; saving a value/default must validate it.
    if (
      ((request.action === "set" &&
        request.value !== undefined &&
        env === request.environment) ||
        (request.action === "add" &&
          Object.hasOwn(request.initialValues ?? {}, env)) ||
        request.action === "default") &&
      item &&
      !item.valid
    )
      throw new VaultError(
        `The proposed value does not satisfy ${key}'s schema requirements.`,
      );
    if (
      (request.action === "definition" || request.action === "add") &&
      item &&
      item.errors.some((e) => e.startsWith("SchemaError"))
    )
      throw new VaultError("Invalid definition metadata.");
    if (request.action === "default" && item?.sensitive)
      throw new VaultError("Sensitive defaults must stay in 1Password.");
  }
  await assertUnchanged(schema);
  const undo: {
    env: string;
    original?: VaultItem;
    saved?: VaultItem;
    kind: "save" | "remove" | "rename";
  }[] = [];
  try {
    if (request.action === "set") {
      const original = snapshot[request.environment].find(
        (i) => i.name === request.name,
      );
      const saved = await provider.save(
        schema.config.environments[request.environment].vault,
        request.name,
        request.value ?? original!.value,
        request.notes ?? original?.notes ?? "",
        original,
      );
      undo.push({ env: request.environment, original, saved, kind: "save" });
    } else if (request.action === "add") {
      for (const [env, initial] of Object.entries(
        request.initialValues ?? {},
      )) {
        const original = snapshot[env].find((i) => i.name === request.name);
        const saved = await provider.save(
          schema.config.environments[env].vault,
          request.name,
          initial.value,
          initial.notes ?? original?.notes ?? "",
          original,
        );
        undo.push({ env, original, saved, kind: "save" });
      }
    } else if (
      request.action === "rename" ||
      request.action === "delete" ||
      request.action === "remove"
    ) {
      for (const env of Object.keys(snapshot)) {
        if (request.action === "remove" && env !== request.environment)
          continue;
        const original = snapshot[env].find((i) => i.name === request.name);
        if (!original) continue;
        if (request.action === "rename") {
          const saved = await provider.rename(
            schema.config.environments[env].vault,
            original,
            request.newName,
          );
          undo.push({ env, original, saved, kind: "rename" });
        } else {
          await provider.remove(
            schema.config.environments[env].vault,
            original,
          );
          undo.push({ env, original, kind: "remove" });
        }
      }
    }
    await writeSchema(schema, text);
    return { saved: true };
  } catch (error) {
    const failed: string[] = [];
    for (const entry of undo.reverse()) {
      try {
        const vault = schema.config.environments[entry.env].vault;
        if (entry.kind === "remove") {
          if (provider.restore) await provider.restore(vault, entry.original!);
          else
            await provider.save(
              vault,
              entry.original!.name,
              entry.original!.value,
              entry.original!.notes,
            );
        } else if (entry.kind === "rename")
          await provider.rename(vault, entry.saved!, entry.original!.name);
        else if (entry.original)
          await provider.save(
            vault,
            entry.original.name,
            entry.original.value,
            entry.original.notes,
            entry.saved,
          );
        else await provider.remove(vault, entry.saved!);
      } catch {
        failed.push(`${entry.env}:${entry.saved?.id ?? entry.original?.id}`);
      }
    }
    if (
      failed.length ||
      (error instanceof VaultError && error.code === "partial")
    )
      throw new VaultError(
        `Partial save. Refresh and inspect affected items in 1Password before retrying: ${failed.join(", ") || (error instanceof VaultError ? error.message : "the requested item")}.`,
        "partial",
        502,
      );
    throw error;
  }
}
