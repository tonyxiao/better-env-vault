import {
  readFile,
  lstat,
  realpath,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  parseEnvSpecDotEnvFile,
  ParsedEnvSpecStaticValue,
  ParsedEnvSpecObjectLiteral,
  type ParsedEnvSpecFile,
  type ParsedEnvSpecConfigItem,
} from "@env-spec/parser";
import { z } from "zod";
import { VaultError, conflict } from "./errors.js";

export const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const environmentName = /^[A-Za-z][A-Za-z0-9_-]*$/;
const environmentConfig = z.strictObject({
  vault: z.string().regex(/^[a-z0-9]{26}$/i),
  extends: z.string().regex(environmentName).optional(),
});
export const configSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1).max(120).optional(),
  provider: z.literal("1password"),
  account: z.string().min(1).max(200),
  auth: z.enum(["desktop", "service-account"]).default("desktop"),
  defaultEnvironment: z.string().regex(environmentName).optional(),
  environments: z.record(z.string().regex(environmentName), environmentConfig),
  legacyFields: z
    .record(z.string().regex(variableName), z.string().min(1))
    .optional(),
});
export type ProjectConfig = z.infer<typeof configSchema>;
export interface SchemaFile {
  path: string;
  text: string;
  fingerprint: string;
  parsed: ParsedEnvSpecFile;
  config: ProjectConfig;
  identity: { dev: number; ino: number; mode: number; realPath: string };
}
export const fingerprint = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// Env Spec normalizes CRLF before parsing. Translate its offsets back to the
// original bytes before using source ranges, including mixed line endings.
function restoreOriginalOffsets(parsed: ParsedEnvSpecFile, text: string) {
  if (!text.includes("\r\n")) return;
  const offsets: number[] = [];
  for (let original = 0; original < text.length; original++) {
    offsets.push(original);
    if (text[original] === "\r" && text[original + 1] === "\n") original++;
  }
  offsets.push(text.length);
  const seen = new Set<object>();
  function visit(value: unknown) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record._location) {
      const location = record._location as {
        start: { offset: number };
        end: { offset: number };
      };
      location.start.offset = offsets[location.start.offset];
      location.end.offset = offsets[location.end.offset];
    }
    for (const [key, child] of Object.entries(record))
      if (key !== "_location") visit(child);
  }
  visit(parsed);
}

export function environmentChain(
  config: ProjectConfig,
  environment: string,
): string[] {
  const chain: string[] = [];
  let current: string | undefined = environment;
  while (current) {
    if (chain.includes(current))
      throw new VaultError("Environment inheritance contains a cycle.");
    if (!Object.hasOwn(config.environments, current))
      throw new VaultError("Environment is not declared in the schema.");
    chain.unshift(current);
    current = config.environments[current].extends;
  }
  return chain;
}

export function parseSchema(text: string): {
  parsed: ParsedEnvSpecFile;
  config: ProjectConfig;
} {
  let parsed: ParsedEnvSpecFile;
  try {
    parsed = parseEnvSpecDotEnvFile(text);
  } catch {
    throw new VaultError("Invalid Env Spec syntax in .env.schema.");
  }
  restoreOriginalOffsets(parsed, text);
  const configs = parsed.decoratorsArray.filter(
    (d) => d.name === "vaultConfig",
  );
  if (configs.length !== 1) {
    throw new VaultError(
      "Declare exactly one static @vaultConfig object or JSON string in the schema header.",
    );
  }
  // Read the native AST without evaluating interpolation or resolver functions.
  // Do not use simplifiedValue: it silently omits dynamic fields and duplicate keys.
  function staticObject(value: unknown): unknown {
    if (value instanceof ParsedEnvSpecStaticValue) return value.value;
    if (value instanceof ParsedEnvSpecObjectLiteral) {
      const result: Record<string, unknown> = Object.create(null);
      for (const entry of value.values) {
        if (Object.hasOwn(result, entry.key))
          throw new Error("Duplicate configuration field");
        result[entry.key] = staticObject(entry.value);
      }
      return result;
    }
    throw new Error("Configuration must be static");
  }
  let config: ProjectConfig;
  try {
    const value = configs[0].value;
    config = configSchema.parse(
      value instanceof ParsedEnvSpecStaticValue
        ? JSON.parse(value.value)
        : staticObject(value),
    );
  } catch {
    throw new VaultError(
      "Invalid @vaultConfig. Expected a static object or JSON string with version 1, provider, account, and named environments with explicit vault IDs.",
    );
  }
  if (!Object.keys(config.environments).length)
    throw new VaultError("Declare at least one environment.");
  for (const name of Object.keys(config.environments))
    environmentChain(config, name);
  if (config.defaultEnvironment)
    environmentChain(config, config.defaultEnvironment);
  const vaultIds = Object.values(config.environments).map((e) => e.vault);
  if (new Set(vaultIds).size !== vaultIds.length)
    throw new VaultError("Each environment must use a different vault.");
  const keys = new Set<string>();
  for (const item of parsed.configItems) {
    if (!variableName.test(item.key) || keys.has(item.key))
      throw new VaultError("Schema variable names must be valid and unique.");
    keys.add(item.key);
    if (item.decoratorsArray.some((d) => d.name === "vaultConfig"))
      throw new VaultError("@vaultConfig belongs in the schema header.");
  }
  // The first release does not load plugins, imports, generators, or persistent caches.
  const allowedRoots = new Set([
    "vaultConfig",
    "defaultRequired",
    "defaultSensitive",
    "envFlag",
    "currentEnv",
  ]);
  if (parsed.decoratorsArray.some((d) => !allowedRoots.has(d.name))) {
    throw new VaultError(
      "Unsupported root decorator. This release supports vaultConfig, defaultRequired, defaultSensitive, envFlag, and currentEnv.",
    );
  }
  if (parsed.orphanCommentBlocks.some((b) => b.decoratorsArray.length))
    throw new VaultError(
      "Move detached decorators into the header or a variable definition.",
    );
  return { parsed, config };
}

export async function loadSchema(path = ".env.schema"): Promise<SchemaFile> {
  const fullPath = resolve(path);
  try {
    const before = await lstat(fullPath);
    if (!before.isFile() || before.isSymbolicLink())
      throw new VaultError("Schema must be a regular file, not a symlink.");
    const text = await readFile(fullPath, "utf8");
    const after = await lstat(fullPath);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs)
      conflict();
    return {
      path: fullPath,
      text,
      fingerprint: fingerprint(text),
      ...parseSchema(text),
      identity: {
        dev: after.dev,
        ino: after.ino,
        mode: after.mode,
        realPath: await realpath(fullPath),
      },
    };
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError(
      "Cannot read .env.schema. Create one with init or select an existing file with --schema.",
    );
  }
}

export function selectEnvironment(
  schema: SchemaFile,
  environment?: string,
): string {
  const selected = environment ?? schema.config.defaultEnvironment;
  if (!selected)
    throw new VaultError(
      "Select --environment or declare defaultEnvironment in @vaultConfig.",
    );
  environmentChain(schema.config, selected);
  return selected;
}

export async function assertUnchanged(schema: SchemaFile) {
  const current = await loadSchema(schema.path);
  if (
    current.fingerprint !== schema.fingerprint ||
    current.identity.ino !== schema.identity.ino ||
    current.identity.dev !== schema.identity.dev ||
    current.identity.realPath !== schema.identity.realPath ||
    current.identity.mode !== schema.identity.mode
  )
    conflict("The schema changed. Refresh before saving.");
}

export async function writeSchema(schema: SchemaFile, text: string) {
  if (text === schema.text) return;
  parseSchema(text);
  await assertUnchanged(schema);
  const temp = join(dirname(schema.path), `.env-schema-${randomUUID()}.tmp`);
  try {
    const file = await open(temp, "wx", schema.identity.mode & 0o777);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await assertUnchanged(schema);
    await rename(temp, schema.path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export function sourceRange(item: ParsedEnvSpecConfigItem): {
  start: number;
  end: number;
} {
  const location = item.data._location;
  if (!location)
    throw new VaultError("This definition cannot be safely edited.");
  return { start: location.start.offset, end: location.end.offset };
}

export function literal(value: string): string {
  if (value.includes("\0"))
    throw new VaultError("Environment values cannot contain NUL.");
  // Single quotes prevent interpolation; Env Spec preserves backslashes literally here.
  const encoded = `'${value.replaceAll("'", "\\'")}'`;
  const parsed = parseEnvSpecDotEnvFile(`VALUE=${encoded}\n`).configItems[0];
  if (
    !(parsed.value instanceof ParsedEnvSpecStaticValue) ||
    parsed.value.unescapedValue !== value
  ) {
    throw new VaultError(
      "This value cannot be safely represented in a schema literal. Keep it in a vault.",
    );
  }
  return encoded;
}

/** Native Env Spec object syntax, with every continuation line remaining a comment. */
export function configurationDecoratorText(
  config: ProjectConfig,
  eol = "\n",
): string {
  const normalized = configSchema.parse(config);
  function hasIdentifierKeys(value: unknown): boolean {
    if (typeof value === "string") return !/[\r\n]/.test(value);
    if (!value || typeof value !== "object") return true;
    return Object.entries(value).every(
      ([key, child]) => variableName.test(key) && hasIdentifierKeys(child),
    );
  }
  // The parser's native object keys cannot contain hyphens. Keep those projects
  // compatible with the existing JSON representation instead of changing names.
  if (!hasIdentifierKeys(normalized))
    return `@vaultConfig=${literal(JSON.stringify(normalized))}`;
  function objectText(value: Record<string, unknown>, depth: number): string {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return (
      "{" +
      eol +
      entries
        .map(([key, child]) => {
          const encoded =
            child && typeof child === "object"
              ? objectText(child as Record<string, unknown>, depth + 1)
              : typeof child === "string"
                ? literal(child)
                : String(child);
          return `# ${"  ".repeat(depth + 1)}${key}=${encoded},`;
        })
        .join(eol) +
      eol +
      `# ${"  ".repeat(depth)}}`
    );
  }
  return `@vaultConfig=${objectText(normalized, 0)}`;
}

export function configurationText(config: ProjectConfig): string {
  return `# ${configurationDecoratorText(config)}\n# @defaultSensitive=true\n# ---\n\n`;
}
