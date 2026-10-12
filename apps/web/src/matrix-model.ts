import type { ProjectConfig } from "../../../packages/core/src/schema.js";
import type {
  Resolution,
  ResolvedVariable,
} from "../../../packages/core/src/resolver.js";

export interface Matrix {
  mode?: "schema" | "vault";
  fingerprint: string;
  config: ProjectConfig;
  schemaPath: string;
  environments: string[];
  vaults?: Record<string, { id: string; name?: string }>;
  resolutions: Resolution[];
  versions: Record<string, Record<string, number | null>>;
  editableValues?: Record<string, Record<string, string | undefined>>;
}
export interface Cell {
  environment: string;
  variable: ResolvedVariable;
  trigger?: HTMLElement;
}
export interface SaveOperation {
  project: string;
  name: string;
  environment: string;
  status: "saving" | "error";
  error?: string;
  payload: Record<string, unknown>;
}
export const fieldKey = (project: string, name: string, environment: string) =>
  JSON.stringify([project, name, environment]);
export function operationField(payload: Record<string, unknown>) {
  return {
    name: String(payload.name ?? "settings"),
    environment:
      payload.action === "default"
        ? "schema"
        : String(
            payload.environment ??
              (payload.action === "add" ? "add" : "definition"),
          ),
  };
}
