import type { Matrix } from "./matrix-model.js";
import type { ResolvedVariable } from "../../../packages/core/src/resolver.js";

export interface VaultEnvironment {
  id: string;
  name: string;
  account?: string;
}
export interface VaultCatalog {
  environments: VaultEnvironment[];
  matrices: { id: string; matrix: Matrix }[];
  errors: { id: string; name: string; error: string }[];
  auth: "desktop" | "service-account";
}
export interface VaultRow {
  id: string;
  vaultId: string;
  environment: VaultEnvironment;
  matrix: Matrix;
  variable: ResolvedVariable;
}
export function catalogRows(catalog: VaultCatalog): VaultRow[] {
  const environments = new Map(
    catalog.environments.map((env) => [env.id, env]),
  );
  return catalog.matrices
    .flatMap(({ id, matrix }) =>
      matrix.resolutions[0].variables.map((variable) => ({
        id: JSON.stringify([id, variable.itemId]),
        vaultId: id,
        environment: environments.get(id)!,
        matrix,
        variable,
      })),
    )
    .sort(
      (a, b) =>
        a.variable.name.localeCompare(b.variable.name) ||
        a.environment.name.localeCompare(b.environment.name) ||
        a.id.localeCompare(b.id),
    );
}
export function filterVaultRows(
  rows: VaultRow[],
  search: string,
  environments: ReadonlySet<string>,
) {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(
    (row) =>
      (!environments.size || environments.has(row.vaultId)) &&
      terms.every((term) =>
        `${row.variable.name} ${row.environment.name} ${row.environment.account ?? ""}`
          .toLowerCase()
          .includes(term),
      ),
  );
}
export function maskCatalog(catalog: VaultCatalog): VaultCatalog {
  return {
    ...catalog,
    matrices: catalog.matrices.map(({ id, matrix }) => {
      const { editableValues: _editable, ...metadata } = matrix;
      return {
        id,
        matrix: {
          ...metadata,
          resolutions: matrix.resolutions.map((resolution) => ({
            ...resolution,
            variables: resolution.variables.map(
              ({ value: _value, defaultValue: _default, ...variable }) =>
                variable,
            ),
          })),
        },
      };
    }),
  };
}

export interface RevealedVaultValue {
  editableValue: string;
  value: string;
  explicitValue: string;
  notes: string;
}
/** Opened cells only; clearing prevents late requests from repopulating memory. */
export class VaultValueCache {
  private entries = new Map<
    string,
    {
      rowId: string;
      pending: Promise<RevealedVaultValue>;
      value?: RevealedVaultValue;
    }
  >();
  private key(row: VaultRow) {
    return JSON.stringify([
      row.id,
      row.matrix.fingerprint,
      row.variable.explicit?.version,
    ]);
  }
  peek(row: VaultRow) {
    return this.entries.get(this.key(row))?.value;
  }
  get(row: VaultRow, load: () => Promise<RevealedVaultValue>) {
    const key = this.key(row);
    const current = this.entries.get(key);
    if (current) return current.pending;
    const entry: {
      rowId: string;
      pending: Promise<RevealedVaultValue>;
      value?: RevealedVaultValue;
    } = { rowId: row.id, pending: Promise.resolve().then(load) };
    this.entries.set(key, entry);
    void entry.pending.then(
      (value) => {
        if (this.entries.get(key) === entry) entry.value = value;
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return entry.pending;
  }
  invalidate(rowId: string) {
    for (const [key, entry] of this.entries)
      if (entry.rowId === rowId) this.entries.delete(key);
  }
  reconcile(rows: VaultRow[]) {
    const keys = new Set(rows.map((row) => this.key(row)));
    for (const key of this.entries.keys())
      if (!keys.has(key)) this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
}
