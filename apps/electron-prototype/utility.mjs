const [mode, account] = process.argv.slice(2);

if (mode === "block") {
  process.stdout.write("UTILITY_BLOCKED\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (mode === "sdk") {
  try {
    process.stdout.write("SDK_IMPORTING\n");
    const { createClient, DesktopAuth } = await import("@1password/sdk");
    process.stdout.write("SDK_AUTHENTICATING\n");
    await createClient({
      auth: new DesktopAuth(account || undefined),
      integrationName: "Better Env Vault",
      integrationVersion: "0.1.0",
    });
    process.stdout.write("SDK_AUTHENTICATED\n");
    process.parentPort.postMessage({
      status: "authenticated",
      account: account || "automatic",
    });
  } catch (error) {
    process.parentPort.postMessage({
      status: "error",
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
