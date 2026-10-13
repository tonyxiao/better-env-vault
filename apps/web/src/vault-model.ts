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
export type VaultCatalogEvent =
  | {
      type: "start";
      environments: VaultEnvironment[];
      auth: VaultCatalog["auth"];
    }
  | { type: "vault"; id: string; matrix: Matrix; error?: string }
  | { type: "error"; id: string; error: string }
  | { type: "complete" };

export function applyCatalogEvent(
  catalog: VaultCatalog,
  event: VaultCatalogEvent,
): VaultCatalog {
  if (event.type === "start")
    return {
      environments: event.environments,
      matrices: [],
      errors: [],
      auth: event.auth,
    };
  if (event.type === "complete") return catalog;
  const environment = catalog.environments.find((env) => env.id === event.id);
  if (!environment) throw new Error("Unknown environment in catalog stream.");
  let matrices = catalog.matrices;
  if (event.type === "vault") {
    const current = matrices.find((entry) => entry.id === event.id)?.matrix;
    if ((current?.revision ?? 0) > (event.matrix.revision ?? 0)) return catalog;
    matrices = [
      ...matrices.filter((entry) => entry.id !== event.id),
      { id: event.id, matrix: event.matrix },
    ];
  }
  const order = new Map(
    catalog.environments.map((env, index) => [env.id, index]),
  );
  return {
    ...catalog,
    matrices: [...matrices].sort((a, b) => order.get(a.id)! - order.get(b.id)!),
    errors: [
      ...catalog.errors.filter((error) => error.id !== event.id),
      ...(event.error
        ? [{ id: event.id, name: environment.name, error: event.error }]
        : []),
    ].sort((a, b) => order.get(a.id)! - order.get(b.id)!),
  };
}
export interface VaultRow {
  id: string;
  vaultId: string;
  environment: VaultEnvironment;
  matrix: Matrix;
  variable: ResolvedVariable;
  notes: string;
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
        notes: matrix.notes?.[variable.name] ?? "",
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
        `${row.variable.name} ${row.environment.name} ${row.environment.account ?? ""} ${row.notes} ${row.variable.value ?? ""}`
          .toLowerCase()
          .includes(term),
      ),
  );
}
export function sortVaultRows(
  rows: VaultRow[],
  sortColumns: readonly { columnKey: string; direction: "ASC" | "DESC" }[],
) {
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const text = (row: VaultRow, key: string) =>
    key === "name"
      ? row.variable.name
      : key === "environment"
        ? `${row.environment.name} ${row.environment.account ?? ""}`
        : key === "notes"
          ? row.notes
          : key === "value"
            ? (row.variable.value ?? "")
            : "";
  return [...rows].sort((left, right) => {
    for (const sort of sortColumns) {
      const order = collator.compare(
        text(left, sort.columnKey),
        text(right, sort.columnKey),
      );
      if (order) return sort.direction === "DESC" ? -order : order;
    }
    return 0;
  });
}
export function groupVaultRows(rows: readonly VaultRow[], descending = false) {
  const groups = new Map<
    string,
    { environment: VaultEnvironment; rows: VaultRow[] }
  >();
  for (const row of rows) {
    let group = groups.get(row.vaultId);
    if (!group)
      groups.set(
        row.vaultId,
        (group = { environment: row.environment, rows: [] }),
      );
    group.rows.push(row);
  }
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return [...groups.values()].sort((a, b) => {
    const order =
      collator.compare(a.environment.name, b.environment.name) ||
      collator.compare(
        a.environment.account ?? "",
        b.environment.account ?? "",
      ) ||
      a.environment.id.localeCompare(b.environment.id);
    return descending ? -order : order;
  });
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
