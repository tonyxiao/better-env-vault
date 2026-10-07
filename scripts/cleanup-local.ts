/** Recover disposable vaults after an interrupted/expired desktop SDK test. */
import { readFile, writeFile, unlink } from "node:fs/promises";
import { createClient, DesktopAuth } from "@1password/sdk";
import { z } from "zod";

const statePath = ".local/cleanup.json";
const stateSchema = z.strictObject({
  account: z.string().min(1),
  vaults: z.array(z.string().regex(/^[a-z0-9]{26}$/i)),
});
try {
  const state = stateSchema.parse(
    JSON.parse(await readFile(statePath, "utf8")),
  );
  const client = await createClient({
    auth: new DesktopAuth(state.account),
    integrationName: "Better Env Vault",
    integrationVersion: "0.1.0",
  });
  const available = await client.vaults.list();
  for (const id of state.vaults) {
    const vault = available.find((v) => v.id === id);
    if (!vault) continue;
    if (!vault.title.startsWith("Better Env Vault test "))
      throw new Error("not a test vault");
    await client.vaults.delete(id);
  }
  const after = await client.vaults.list();
  if (after.some((v) => state.vaults.includes(v.id)))
    throw new Error("cleanup incomplete");
  await writeFile(
    ".local/cleanup-result.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        cleanupVerified: true,
        vaultsRemoved: state.vaults.length,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await unlink(statePath);
  console.log(
    `Cleanup verified: ${state.vaults.length} recorded disposable vaults are absent.`,
  );
} catch {
  console.error(
    "Cleanup could not complete. Unlock 1Password and approve the SDK request; recovery IDs remain in .local/cleanup.json.",
  );
  process.exitCode = 1;
}
