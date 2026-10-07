import { describe, it, expect } from "vitest";
import {
  parseEnvSpecDotEnvFile,
  ParsedEnvSpecObjectLiteral,
} from "@env-spec/parser";
import { readFile, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ItemCategory, ItemFieldType, type Item } from "@1password/sdk";
import { config, fixture, MemoryProvider } from "./helpers.js";
import {
  configurationText,
  environmentChain,
  loadSchema,
  parseSchema,
  literal,
  writeSchema,
} from "../packages/core/src/schema.js";
import {
  exportValues,
  publicResolution,
  readVaults,
  resolveEnvironment,
} from "../packages/core/src/resolver.js";
import { normalizeItems } from "../packages/core/src/provider.js";
import { applyEdit, editSchemaText } from "../packages/core/src/edit.js";
import {
  childEnvironment,
  direnvDump,
  shellExport,
} from "../packages/core/src/export.js";

describe("schema and project boundary", () => {
  it("requires one schema config, valid IDs, unique environment vaults, and acyclic parents", () => {
    expect(() => parseSchema("KEY=\n")).toThrow("vaultConfig");
    expect(() =>
      parseSchema(configurationText({ ...config, environments: {} })),
    ).toThrow("environment");
    expect(() =>
      parseSchema(
        configurationText({
          ...config,
          environments: { dev: { vault: "a".repeat(26), extends: "dev" } },
        }),
      ),
    ).toThrow("cycle");
    expect(() => environmentChain(config, "unknown")).toThrow("declared");
    expect(environmentChain(config, "prod")).toEqual([
      "dev",
      "staging",
      "prod",
    ]);
    expect(() =>
      parseSchema(configurationText(config) + "KEY=\nKEY=\n"),
    ).toThrow("unique");
    expect(() =>
      parseSchema(
        configurationText(config).replace("# ---", "# @import=./other\n# ---"),
      ),
    ).toThrow("Unsupported");
  });
  it("generates readable native metadata that the Env Spec parser reads directly", () => {
    const text = configurationText(config);
    const parsed = parseEnvSpecDotEnvFile(text + "TOKEN=\n");
    const metadata = parsed.decoratorsArray.find(
      (decorator) => decorator.name === "vaultConfig",
    )!;
    expect(metadata.value).toBeInstanceOf(ParsedEnvSpecObjectLiteral);
    expect(
      (metadata.value as ParsedEnvSpecObjectLiteral).simplifiedValue,
    ).toEqual(config);
    expect(text).toContain("#     prod={\n#       vault=");
    expect(parseSchema(text).config).toEqual(config);
  });
  it("retains compatibility with JSON headers and non-identifier environment names", () => {
    const legacy = `# @vaultConfig=${literal(JSON.stringify(config))}\n# ---\nTOKEN=\n`;
    expect(parseSchema(legacy).config).toEqual(config);
    const hyphenated = {
      ...config,
      defaultEnvironment: "dev-us",
      environments: { "dev-us": config.environments.dev },
    };
    expect(configurationText(hyphenated)).toMatch(/^# @vaultConfig='/);
    expect(parseSchema(configurationText(hyphenated)).config).toEqual(
      hyphenated,
    );
    const multiline = { ...config, name: "Example\nProject" };
    expect(parseSchema(configurationText(multiline)).config).toEqual(multiline);
  });
  it("rejects duplicate metadata keys and dynamic fields even when optional", () => {
    const text = configurationText(config);
    expect(() =>
      parseSchema(text.replace("version=1,", "version=1, version=1,")),
    ).toThrow("Invalid @vaultConfig");
    expect(() =>
      parseSchema(text.replace("#   auth='desktop',", "#   auth=ref(AUTH),")),
    ).toThrow("Invalid @vaultConfig");
    expect(() =>
      parseSchema(
        text.replace(
          "#   account='example-account',",
          '#   account="${ACCOUNT}",',
        ),
      ),
    ).toThrow("Invalid @vaultConfig");
    expect(() =>
      parseSchema(
        text.replace("#       extends='dev',", "#       extends=ref(PARENT),"),
      ),
    ).toThrow("Invalid @vaultConfig");
  });
  it("updates multiline metadata and migrates JSON headers while preserving CRLF and variable bytes", async () => {
    const definition = "# @public\nKEY='unchanged' # trailing comment\n";
    const native = await fixture(definition);
    const legacy = `# @vaultConfig=${literal(JSON.stringify(config))}\n# @defaultSensitive=false # custom setting\n# ---\n\n${definition}`;
    for (const input of [native.text, legacy].map((text) =>
      text.replaceAll("\n", "\r\n"),
    )) {
      await writeFile(native.path, input);
      const schema = await loadSchema(native.path);
      const next = { ...config, name: "Readable project" };
      const edited = editSchemaText(schema, {
        action: "config",
        fingerprint: schema.fingerprint,
        config: next,
      });
      expect(parseSchema(edited).config).toEqual(next);
      expect(edited).toContain("# @vaultConfig={\r\n");
      expect(edited).not.toMatch(/(?<!\r)\n/);
      expect(edited.endsWith(definition.replaceAll("\n", "\r\n"))).toBe(true);
      if (input === legacy.replaceAll("\n", "\r\n"))
        expect(edited).toContain("# @defaultSensitive=false # custom setting");
    }
  });
  it("round trips literal interpolation characters and multiline defaults", () => {
    const value = "quotes ' and \\ and $VAR\nsecond line";
    expect(
      parseSchema(
        configurationText(config) + `# @public\nKEY=${literal(value)}\n`,
      ).parsed.toSimpleObj().KEY,
    ).toBe(value);
  });
  it("rejects stale schema writes and preserves permissions", async () => {
    const schema = await fixture("# @public\nKEY=old\n");
    await writeSchema(schema, schema.text.replace("KEY=old", "KEY=new"));
    expect((await stat(schema.path)).mode & 0o777).toBe(0o640);
    await expect(writeSchema(schema, schema.text + "\n")).rejects.toThrow(
      "schema changed",
    );
  });
});

describe("shared resolver", () => {
  it("resolves each ancestor, distinguishes explicit empty values, and masks secrets", async () => {
    const schema = await fixture(
      "# @public @required\nCOLOR=base\n\n# @optional\nSECRET=\n\n# @public @optional\nABSENT=\n",
    );
    const provider = new MemoryProvider();
    await provider.save(
      config.environments.dev.vault,
      "COLOR",
      "dev",
      "keep notes",
    );
    await provider.save(config.environments.staging.vault, "COLOR", "", "");
    await provider.save(
      config.environments.dev.vault,
      "SECRET",
      "private-content",
      "",
    );
    const resolved = await resolveEnvironment(
      schema,
      "prod",
      await readVaults(schema, provider),
    );
    expect(resolved.variables[0]).toMatchObject({
      value: "",
      source: "staging",
      state: "inherited",
    });
    expect(resolved.variables[1]).toMatchObject({
      source: "dev",
      sensitive: true,
      value: "private-content",
    });
    expect(resolved.variables[2].state).toBe("missing");
    expect(JSON.stringify(publicResolution(resolved))).not.toContain(
      "private-content",
    );
    expect(publicResolution(resolved).variables[1]).not.toHaveProperty("value");
  });
  it("treats matching values as explicit and ignores unmanaged items and caller shell", async () => {
    const schema = await fixture(
      "# @public\nCOLOR=base\n\n# @required\nUNFILLED=\n",
    );
    const provider = new MemoryProvider();
    await provider.save(config.environments.prod.vault, "COLOR", "base", "");
    await provider.save(
      config.environments.prod.vault,
      "UNMANAGED",
      "unmanaged-content",
      "",
    );
    process.env.UNFILLED = "contaminating-content";
    try {
      const r = await resolveEnvironment(
        schema,
        "prod",
        await readVaults(schema, provider),
      );
      expect(r.variables[0].state).toBe("explicit");
      expect(r.variables[1].state).toBe("missing");
      expect(r.unmanaged).toHaveLength(1);
      expect(() => exportValues(r)).toThrow("UNFILLED");
    } finally {
      delete process.env.UNFILLED;
    }
  });
  it("uses Varlock type validation without exposing the invalid value", async () => {
    const schema = await fixture(
      "# @public @required @type=number(min=1,max=5)\nCOUNT=2\n",
    );
    const provider = new MemoryProvider();
    await provider.save(
      config.environments.dev.vault,
      "COUNT",
      "secret-invalid-number",
      "",
    );
    const r = await resolveEnvironment(
      schema,
      "dev",
      await readVaults(schema, provider),
    );
    expect(r.valid).toBe(false);
    expect(JSON.stringify(r.variables[0].errors)).not.toContain(
      "secret-invalid-number",
    );
  });
  it("supports environment-dependent requirements and pure expressions", async () => {
    const schema = await fixture(
      '# @public\nHOST=example.test\n\n# @public @optional\nURL=concat("https://",ref(HOST))\n\n# @required=forEnv(prod)\nTOKEN=\n',
    );
    const provider = new MemoryProvider();
    const snapshot = await readVaults(schema, provider);
    const dev = await resolveEnvironment(schema, "dev", snapshot);
    const prod = await resolveEnvironment(schema, "prod", snapshot);
    expect(dev.variables[1].value).toBe("https://example.test");
    expect(dev.variables[2].required).toBe(false);
    expect(prod.variables[2].required).toBe(true);
  });
  it("rejects sensitive literals even when shadowed by an override", async () => {
    const schema = await fixture("TOKEN=literal-private-value\n");
    const provider = new MemoryProvider();
    await provider.save(
      config.environments.dev.vault,
      "TOKEN",
      "vault-value",
      "",
    );
    await expect(
      resolveEnvironment(schema, "dev", await readVaults(schema, provider)),
    ).rejects.toThrow("literal schema default");
  });
});

describe("provider normalization", () => {
  const item = {
    id: "id",
    version: 1,
    title: "KEY",
    category: ItemCategory.ApiCredentials,
    notes: "notes",
    fields: [
      {
        id: "credential",
        value: "",
        title: "credential",
        fieldType: ItemFieldType.Concealed,
      },
    ],
  } as Item;
  it("keeps empty credentials and notes, ignores other item categories", () => {
    expect(
      normalizeItems(
        [item, { ...item, category: ItemCategory.SecureNote }],
        config,
      ),
    ).toHaveLength(1);
    expect(normalizeItems([item], config)[0]).toMatchObject({
      value: "",
      notes: "notes",
    });
  });
  it("rejects duplicates, invalid titles, and absent credential fields", () => {
    expect(() => normalizeItems([item, item], config)).toThrow("Duplicate");
    expect(() =>
      normalizeItems([{ ...item, title: "not a variable" }], config),
    ).toThrow("invalid");
    expect(() => normalizeItems([{ ...item, fields: [] }], config)).toThrow(
      "credential",
    );
  });
});

describe("shell and process integration", () => {
  it("sources hostile characters without executing them and unsets declared missing keys", async () => {
    const value = "' $VAR $(echo BAD) `echo BAD` \\ \"\nUnicode ☃\n";
    const script = shellExport({ TEST_VALUE: value }, ["MISSING"]);
    const { stdout } = await promisify(execFile)(
      "bash",
      [
        "-c",
        script +
          "\nnode -e 'process.stdout.write(JSON.stringify({value:process.env.TEST_VALUE,missing:process.env.MISSING}))'",
      ],
      { env: { ...process.env, MISSING: "unrelated" } },
    );
    expect(JSON.parse(stdout)).toEqual({ value });
    expect(() => shellExport({ KEY: "\0" })).toThrow("NUL");
  });
  it("removes stale declared values and provider credentials from child processes", () => {
    expect(
      childEnvironment({ KEY: "resolved" }, ["KEY", "MISSING"], {
        KEY: "old",
        MISSING: "old",
        OP_SERVICE_ACCOUNT_TOKEN: "private",
        OP_SESSION_example: "session",
        PATH: "/bin",
      }),
    ).toEqual({ KEY: "resolved", PATH: "/bin" });
  });
  it("uses real direnv encoding when direnv is available", async () => {
    try {
      await promisify(execFile)("direnv", ["version"]);
    } catch {
      return;
    }
    const dumped = await direnvDump({
      PATH: process.env.PATH,
      BEV_TEST: "value with\nnewline",
    });
    const { stdout } = await promisify(execFile)("bash", [
      "-c",
      'eval "$(printf "%s" "$1" | direnv apply_dump /dev/stdin)"; node -e \'process.stdout.write(JSON.stringify(process.env.BEV_TEST))\'',
      "test",
      dumped.trim(),
    ]);
    expect(JSON.parse(stdout)).toBe("value with\nnewline");
  });
});

describe("coordinated editing", () => {
  it("creates a secret and initial environment values together, without writing them into the schema", async () => {
    const schema = await fixture("# @public\nOTHER=base\n");
    const provider = new MemoryProvider();
    await applyEdit(schema.path, provider, {
      action: "add",
      name: "NEW_TOKEN",
      sensitive: true,
      required: true,
      type: "string",
      fingerprint: schema.fingerprint,
      versions: { dev: null, staging: null, prod: null },
      initialValues: {
        dev: { value: "sensitive-initial-value", notes: "Dev note" },
        prod: { value: "prod-secret" },
      },
    });
    const updated = await loadSchema(schema.path);
    expect(updated.text).not.toContain("sensitive-initial-value");
    expect(updated.text).not.toContain("prod-secret");
    const snapshot = await readVaults(updated, provider);
    expect(
      (await resolveEnvironment(updated, "staging", snapshot)).variables.find(
        (v) => v.name === "NEW_TOKEN",
      ),
    ).toMatchObject({
      value: "sensitive-initial-value",
      state: "inherited",
      source: "dev",
    });
    expect(
      (await resolveEnvironment(updated, "prod", snapshot)).variables.find(
        (v) => v.name === "NEW_TOKEN",
      ),
    ).toMatchObject({ value: "prod-secret", state: "explicit" });
    expect(snapshot.dev.find((i) => i.name === "NEW_TOKEN")?.notes).toBe(
      "Dev note",
    );
  });
  it("preserves the secret when only override notes change", async () => {
    const schema = await fixture("# @optional\nTOKEN=\n");
    const provider = new MemoryProvider();
    await provider.save(
      config.environments.dev.vault,
      "TOKEN",
      "secret-retained",
      "old notes",
    );
    await applyEdit(schema.path, provider, {
      action: "set",
      name: "TOKEN",
      environment: "dev",
      fingerprint: schema.fingerprint,
      versions: { dev: 1 },
      notes: "Updated notes",
    });
    expect(
      (await provider.readVault(config.environments.dev.vault))[0],
    ).toMatchObject({ value: "secret-retained", notes: "Updated notes" });
    await expect(
      applyEdit(schema.path, provider, {
        action: "set",
        name: "TOKEN",
        environment: "prod",
        fingerprint: schema.fingerprint,
        versions: { prod: null },
        notes: "No override here",
      }),
    ).rejects.toThrow("Set a value");
  });
  it("rolls back initial values when adding across environments fails", async () => {
    const schema = await fixture("# @public\nOTHER=base\n");
    const provider = new MemoryProvider();
    provider.failAt = 2;
    await expect(
      applyEdit(schema.path, provider, {
        action: "add",
        name: "NEW_TOKEN",
        fingerprint: schema.fingerprint,
        versions: { dev: null, staging: null, prod: null },
        initialValues: { dev: { value: "secret" }, prod: { value: "secret" } },
      }),
    ).rejects.toThrow();
    expect(await readFile(schema.path, "utf8")).toBe(schema.text);
    expect(await provider.readVault(config.environments.dev.vault)).toEqual([]);
  });
  it("validates typed initial values and rejects unknown destinations before writing", async () => {
    const schema = await fixture("# @public\nOTHER=base\n");
    const provider = new MemoryProvider();
    const request = {
      action: "add",
      name: "NEW_NUMBER",
      sensitive: false,
      type: "number(min=1)",
      fingerprint: schema.fingerprint,
      versions: { dev: null, staging: null, prod: null },
    };
    await expect(
      applyEdit(schema.path, provider, {
        ...request,
        initialValues: { dev: { value: "invalid" } },
      }),
    ).rejects.toThrow("requirements");
    await expect(
      applyEdit(schema.path, provider, {
        ...request,
        initialValues: { unknown: { value: "2" } },
      }),
    ).rejects.toThrow("declared");
    expect(provider.calls).toBe(0);
    expect(await readFile(schema.path, "utf8")).toBe(schema.text);
  });
  it("rejects invalid metadata when adding a definition", async () => {
    const schema = await fixture("# @public\nKEY=base\n");
    const provider = new MemoryProvider();
    await expect(
      applyEdit(schema.path, provider, {
        action: "add",
        name: "NEW_KEY",
        type: "unknownType",
        sensitive: false,
        fingerprint: schema.fingerprint,
        versions: { dev: null, staging: null, prod: null },
      }),
    ).rejects.toThrow("metadata");
    expect(await readFile(schema.path, "utf8")).toBe(schema.text);
  });
  it("creates an override, preserves notes, removes it, and returns to inheritance", async () => {
    const schema = await fixture("# @public @optional\nKEY=base\n");
    const provider = new MemoryProvider();
    await applyEdit(schema.path, provider, {
      action: "set",
      name: "KEY",
      fingerprint: schema.fingerprint,
      versions: { dev: null },
      environment: "dev",
      value: "override",
      notes: "keep me",
    });
    const previous = (
      await provider.readVault(config.environments.dev.vault)
    )[0];
    await applyEdit(schema.path, provider, {
      action: "set",
      name: "KEY",
      fingerprint: schema.fingerprint,
      versions: { dev: previous.version },
      environment: "dev",
      value: "new",
    });
    const updated = (
      await provider.readVault(config.environments.dev.vault)
    )[0];
    expect(updated.notes).toBe("keep me");
    await expect(
      applyEdit(schema.path, provider, {
        action: "remove",
        name: "KEY",
        fingerprint: schema.fingerprint,
        versions: { dev: previous.version },
        environment: "dev",
      }),
    ).rejects.toThrow("changed");
    await applyEdit(schema.path, provider, {
      action: "remove",
      name: "KEY",
      fingerprint: schema.fingerprint,
      versions: { dev: updated.version },
      environment: "dev",
    });
    expect(
      (
        await resolveEnvironment(
          schema,
          "dev",
          await readVaults(schema, provider),
        )
      ).variables[0],
    ).toMatchObject({ state: "default", value: "base" });
  });
  it("changes only the selected default bytes, preserving other expressions, quoting, and CRLF", async () => {
    const schema = await fixture(
      '# @public\r\nKEY="old" # trailing\r\n\r\n# untouched\r\n# @public\r\nOTHER=concat("hello", "world")\r\n',
    );
    const edited = editSchemaText(schema, {
      action: "default",
      name: "KEY",
      value: "new",
      fingerprint: schema.fingerprint,
      versions: {},
    });
    expect(edited).toBe(schema.text.replace('KEY="old"', "KEY='new'"));
  });
  it("updates an empty assignment safely", async () => {
    const schema = await fixture("# @public\nKEY= # trailing\n");
    const edited = editSchemaText(schema, {
      action: "default",
      name: "KEY",
      value: "new",
      fingerprint: schema.fingerprint,
      versions: {},
    });
    expect(parseSchema(edited).parsed.toSimpleObj().KEY).toBe("new");
    expect(edited).toContain("# trailing");
  });
  it("rejects unsafe sensitivity changes and invalid typed defaults before writes", async () => {
    const schema = await fixture("# @public @type=number(min=1)\nCOUNT=2\n");
    const provider = new MemoryProvider();
    const common = {
      name: "COUNT",
      fingerprint: schema.fingerprint,
      versions: { dev: null, staging: null, prod: null },
    };
    await expect(
      applyEdit(schema.path, provider, {
        ...common,
        action: "default",
        value: "invalid",
      }),
    ).rejects.toThrow("requirements");
    await expect(
      applyEdit(schema.path, provider, {
        ...common,
        action: "definition",
        sensitive: true,
      }),
    ).rejects.toThrow("literal");
    expect(await readFile(schema.path, "utf8")).toBe(schema.text);
  });
  it("rolls back prior renames after a later vault failure", async () => {
    const schema = await fixture("# @public\nKEY=base\n");
    const provider = new MemoryProvider();
    await provider.save(config.environments.dev.vault, "KEY", "dev", "notes");
    await provider.save(config.environments.prod.vault, "KEY", "prod", "notes");
    provider.failAt = provider.calls + 2;
    await expect(
      applyEdit(schema.path, provider, {
        action: "rename",
        name: "KEY",
        newName: "NEW_KEY",
        fingerprint: schema.fingerprint,
        versions: { dev: 1, staging: null, prod: 1 },
      }),
    ).rejects.toThrow();
    expect(
      (await provider.readVault(config.environments.dev.vault))[0],
    ).toMatchObject({ name: "KEY", value: "dev", notes: "notes" });
    expect(await readFile(schema.path, "utf8")).toBe(schema.text);
  });
  it("adopts unmanaged items without copying values into the schema", async () => {
    const schema = await fixture("# @public\nOTHER=base\n");
    const provider = new MemoryProvider();
    await provider.save(
      config.environments.dev.vault,
      "TOKEN",
      "private-content",
      "",
    );
    await applyEdit(schema.path, provider, {
      action: "add",
      name: "TOKEN",
      sensitive: true,
      required: false,
      type: "string",
      description: "A token",
      fingerprint: schema.fingerprint,
      versions: { dev: 1, staging: null, prod: null },
    });
    const text = await readFile(schema.path, "utf8");
    expect(text).toContain("TOKEN=");
    expect(text).not.toContain("private-content");
    expect(
      (
        await resolveEnvironment(
          await loadSchema(schema.path),
          "dev",
          await readVaults(schema, provider),
        )
      ).variables.find((v) => v.name === "TOKEN")?.value,
    ).toBe("private-content");
  });
});
