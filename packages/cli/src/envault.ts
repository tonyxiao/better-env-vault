#!/usr/bin/env node
import { Command } from "commander";
import { safeError } from "../../core/src/errors.js";
import { serve, webOptions } from "./serve.js";

const program = webOptions(
  new Command()
    .name("envault")
    .version("0.1.0")
    .description(
      "Open the local secret editor for an .env.schema file. The server stops when this CLI exits.",
    )
    .argument("[schema]", "Path to .env.schema", ".env.schema"),
);

program.action(async (schema: string, options) => {
  await serve({ ...options, schemas: [schema] });
});

try {
  await program.parseAsync();
} catch (error) {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
}
