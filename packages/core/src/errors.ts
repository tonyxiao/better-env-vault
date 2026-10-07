export class VaultError extends Error {
  constructor(
    message: string,
    public code = "configuration",
    public status = 400,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export function safeError(error: unknown): string {
  return error instanceof VaultError
    ? error.message
    : "Operation failed. Check 1Password authorization and try again.";
}

export function conflict(
  message = "This data changed. Refresh before saving.",
): never {
  throw new VaultError(message, "conflict", 409);
}
