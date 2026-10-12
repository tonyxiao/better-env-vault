import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataGrid,
  SelectColumn,
  type Column,
  type DataGridHandle,
  type RenderEditCellProps,
} from "react-data-grid";
import {
  Info,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import {
  NativeSelect,
  NativeSelectOption,
} from "./components/ui/native-select.js";
import {
  SpreadsheetEditor,
  EyeIcon,
  type EditDirection,
} from "./MatrixCell.js";
import { Dialog, Editor, ProjectDialog } from "./edit-dialogs.js";
import {
  catalogRows,
  filterVaultRows,
  maskCatalog,
  type VaultCatalog,
  type VaultRow,
} from "./vault-model.js";

class RequestError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
interface Operation {
  payload: Record<string, unknown>;
  status: "saving" | "error";
  error?: string;
}
function VaultValueEditor({
  row,
  rowIdx,
  onClose,
  hideEpoch,
  visible,
  operation,
  save,
  reveal,
  register,
  navigate,
}: RenderEditCellProps<VaultRow> & {
  hideEpoch: number;
  visible: boolean;
  operation?: Operation;
  save: (row: VaultRow, payload: Record<string, unknown>) => Promise<boolean>;
  reveal: (row: VaultRow) => Promise<{ editableValue?: string }>;
  register: (id: string, commit?: () => void) => void;
  navigate: (rowIdx: number, direction: EditDirection) => void;
}) {
  const snapshot = useRef(row).current;
  const onCommitReady = useCallback(
    (commit?: () => void) => register(row.id, commit),
    [register, row.id],
  );
  const submit = (value: string) => {
    onClose(false);
    return save(snapshot, {
      action: "set",
      name: snapshot.variable.name,
      environment: "vault",
      value,
      fingerprint: snapshot.matrix.fingerprint,
      versions: snapshot.matrix.versions[snapshot.variable.name],
    });
  };
  return (
    <SpreadsheetEditor
      variable={row.variable}
      environment={row.environment.name}
      origin={`Stored in ${row.environment.name}`}
      hideEpoch={hideEpoch}
      initialValue={visible ? { value: row.variable.value } : undefined}
      draftValue={
        operation?.status === "error" &&
        typeof operation.payload.value === "string"
          ? operation.payload.value
          : undefined
      }
      onLoad={() => reveal(snapshot)}
      onSave={submit}
      onLeave={submit}
      onCancel={() => onClose(false)}
      onCommitReady={onCommitReady}
      onNavigate={(direction) => {
        onClose(false, false);
        navigate(rowIdx, direction);
      }}
    />
  );
}

export function VaultWorkspace({
  mutationToken,
  onDisconnect,
}: {
  mutationToken: string;
  onDisconnect: () => void;
}) {
  const [catalog, setCatalog] = useState<VaultCatalog>();
  const catalogRef = useRef<VaultCatalog | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [environments, setEnvironments] = useState<Set<string>>(new Set());
  const environmentRef = useRef(environments);
  environmentRef.current = environments;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allVisible, setAllVisible] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [hideEpoch, setHideEpoch] = useState(0);
  const visibility = useRef(0);
  const visibleIntent = useRef(false);
  const loadId = useRef(0);
  const alive = useRef(true);
  const [operations, setOperations] = useState<Record<string, Operation>>({});
  const pending = useRef(new Set<string>());
  const [details, setDetails] = useState<{
    row: VaultRow;
    trigger: HTMLElement;
  }>();
  const [addStage, setAddStage] = useState<"choose" | "create">();
  const [addEnvironment, setAddEnvironment] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteRows, setDeleteRows] = useState<VaultRow[]>();
  const [confirmation, setConfirmation] = useState("");
  const grid = useRef<DataGridHandle>(null);
  const activeCommit = useRef<(() => void) | undefined>(undefined);
  const activeRow = useRef<string | undefined>(undefined);
  const register = useCallback((id: string, commit?: () => void) => {
    activeCommit.current = commit;
    activeRow.current = commit ? id : undefined;
  }, []);
  const api = useCallback(
    async <T,>(url: string, body?: unknown): Promise<T> => {
      const response = await fetch(url, {
        cache: "no-store",
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Bev-Mutation": mutationToken,
              },
              body: JSON.stringify(body),
            }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.code === "session") onDisconnect();
        throw new RequestError(data.error ?? "Request failed.", data.code);
      }
      return data;
    },
    [mutationToken, onDisconnect],
  );
  const hide = useCallback(() => {
    visibleIntent.current = false;
    ++visibility.current;
    setAllVisible(false);
    setRevealing(false);
    setHideEpoch((e) => e + 1);
    setDetails(undefined);
    setCatalog((previous) => (previous ? maskCatalog(previous) : previous));
  }, []);
  const load = useCallback(
    async (fresh = false, quiet = false) => {
      const id = ++loadId.current;
      const generation = visibility.current;
      if (!quiet) setLoading(true);
      setError("");
      try {
        let data = await api<VaultCatalog>(
          `/api/catalog${fresh ? "?fresh=1" : ""}`,
        );
        if (!alive.current || id !== loadId.current) return;
        catalogRef.current = maskCatalog(data);
        if (visibleIntent.current && generation === visibility.current) {
          data = await api<VaultCatalog>("/api/catalog/reveal", {
            fingerprints: Object.fromEntries(
              data.matrices
                .filter(
                  ({ id }) =>
                    !environmentRef.current.size ||
                    environmentRef.current.has(id),
                )
                .map(({ id, matrix }) => [id, matrix.fingerprint]),
            ),
          });
        }
        if (!alive.current || id !== loadId.current) return;
        setCatalog(
          visibleIntent.current && generation === visibility.current
            ? data
            : maskCatalog(data),
        );
        setSelected(
          (previous) =>
            new Set(
              [...previous].filter((id) =>
                catalogRows(data).some((row) => row.id === id),
              ),
            ),
        );
      } catch (error) {
        if (alive.current && id === loadId.current) {
          hide();
          setError((error as Error).message);
        }
      } finally {
        if (alive.current && id === loadId.current && !quiet) setLoading(false);
      }
    },
    [api, hide],
  );
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      ++loadId.current;
      ++visibility.current;
    };
  }, [load]);
  const rows = useMemo(() => (catalog ? catalogRows(catalog) : []), [catalog]);
  const filtered = useMemo(
    () => filterVaultRows(rows, search, environments),
    [rows, search, environments],
  );
  async function reveal(row: VaultRow) {
    return api<{
      editableValue: string;
      value: string;
      explicitValue: string;
      notes: string;
    }>(`/api/reveal?project=${encodeURIComponent(row.vaultId)}`, {
      name: row.variable.name,
      environment: "vault",
      fingerprint: row.matrix.fingerprint,
    });
  }
  async function save(
    row: Omit<VaultRow, "variable"> & {
      variable: Pick<VaultRow["variable"], "name">;
    },
    payload: Record<string, unknown>,
  ) {
    if (pending.current.has(row.id)) return false;
    pending.current.add(row.id);
    setOperations((previous) => ({
      ...previous,
      [row.id]: { payload, status: "saving" },
    }));
    setNotice("");
    try {
      await api(`/api/edit?project=${encodeURIComponent(row.vaultId)}`, {
        fingerprint: row.matrix.fingerprint,
        ...payload,
      });
      if (!alive.current) return true;
      setOperations((previous) => {
        const next = { ...previous };
        delete next[row.id];
        return next;
      });
      await load(false, true);
      if (alive.current)
        setNotice(`Saved ${row.variable.name} in ${row.environment.name}.`);
      return true;
    } catch (error) {
      if (alive.current)
        setOperations((previous) => ({
          ...previous,
          [row.id]: {
            payload,
            status: "error",
            error: (error as Error).message,
          },
        }));
      return false;
    } finally {
      pending.current.delete(row.id);
    }
  }
  async function toggleValues() {
    if (allVisible || revealing) {
      hide();
      return;
    }
    visibleIntent.current = true;
    const generation = ++visibility.current;
    setRevealing(true);
    setError("");
    try {
      const current = catalogRef.current;
      if (!current) return;
      const revealed = await api<VaultCatalog>("/api/catalog/reveal", {
        fingerprints: Object.fromEntries(
          current.matrices
            .filter(
              ({ id }) =>
                !environmentRef.current.size || environmentRef.current.has(id),
            )
            .map(({ id, matrix }) => [id, matrix.fingerprint]),
        ),
      });
      if (
        alive.current &&
        generation === visibility.current &&
        visibleIntent.current
      ) {
        setCatalog(revealed);
        setAllVisible(true);
      }
    } catch (error) {
      if (alive.current && generation === visibility.current) {
        hide();
        setError((error as Error).message);
      }
    } finally {
      if (alive.current && generation === visibility.current)
        setRevealing(false);
    }
  }
  function navigate(rowIdx: number, direction: EditDirection) {
    const step = direction === "up" || direction === "previous" ? -1 : 1;
    for (let i = rowIdx + step; i >= 0 && i < filtered.length; i += step) {
      if (operations[filtered[i].id]?.status !== "saving") {
        grid.current?.setActivePosition(
          { rowIdx: i, idx: 3 },
          { enableEditor: true },
        );
        return;
      }
    }
  }
  async function deleteSelected() {
    if (!deleteRows || confirmation !== "DELETE" || deleting) return;
    const batch = deleteRows;
    setDeleting(true);
    setDeleteRows(undefined);
    setError("");
    const completed: string[] = [];
    let deletionError = "";
    try {
      const groups = new Map<string, VaultRow[]>();
      for (const row of batch)
        groups.set(row.vaultId, [...(groups.get(row.vaultId) ?? []), row]);
      for (const [id, selectedRows] of groups) {
        await api(`/api/delete-many?project=${encodeURIComponent(id)}`, {
          names: selectedRows.map((r) => r.variable.name),
          fingerprint: selectedRows[0].matrix.fingerprint,
          versions: Object.fromEntries(
            selectedRows.map((r) => [
              r.variable.name,
              r.matrix.versions[r.variable.name],
            ]),
          ),
          confirmation: "DELETE",
        });
        completed.push(...selectedRows.map((r) => r.id));
      }
      setNotice(
        `Deleted ${completed.length} secrets from their selected environments.`,
      );
    } catch (error) {
      deletionError = `${completed.length ? `${completed.length} secrets were deleted before the remaining deletion failed. ` : ""}${(error as Error).message}`;
    } finally {
      setSelected(
        (previous) =>
          new Set([...previous].filter((id) => !completed.includes(id))),
      );
      await load(false, true);
      if (deletionError) setError(deletionError);
      setDeleting(false);
    }
  }
  const columns: Column<VaultRow>[] = [
    { ...SelectColumn, width: 36, minWidth: 36, frozen: true },
    {
      key: "name",
      name: "Secret",
      minWidth: 220,
      width: 330,
      resizable: true,
      frozen: true,
      renderCell: ({ row }) => (
        <div className="variable-cell">
          <code>{row.variable.name}</code>
        </div>
      ),
    },
    {
      key: "environment",
      name: "Environment",
      minWidth: 160,
      width: 240,
      resizable: true,
      renderCell: ({ row }) => (
        <div className="vault-environment-cell">
          <strong title={row.vaultId}>{row.environment.name}</strong>
          {row.environment.account ? (
            <span>{row.environment.account}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "value",
      name: "Value",
      minWidth: 260,
      resizable: true,
      cellClass: "environment-value-cell",
      editable: (row) => !deleting && operations[row.id]?.status !== "saving",
      editorOptions: {
        commitOnOutsideClick: false,
        closeOnExternalRowChange: false,
      },
      renderEditCell: (props) => (
        <VaultValueEditor
          {...props}
          visible={allVisible}
          hideEpoch={hideEpoch}
          operation={operations[props.row.id]}
          save={save}
          reveal={reveal}
          register={register}
          navigate={navigate}
        />
      ),
      renderCell: ({ row, rowIdx, column }) => {
        const operation = operations[row.id];
        const shown =
          operation?.status === "saving" &&
          typeof operation.payload.value === "string" &&
          allVisible
            ? operation.payload.value
            : row.variable.value;
        return (
          <div
            className="matrix-cell"
            aria-busy={operation?.status === "saving"}
          >
            <Button
              variant="ghost"
              className="value-cell explicit"
              tabIndex={-1}
              aria-label={`Edit ${row.variable.name} in ${row.environment.name}`}
              disabled={deleting || operation?.status === "saving"}
              onClick={() =>
                grid.current?.setActivePosition(
                  { rowIdx, idx: column.idx },
                  { enableEditor: true },
                )
              }
            >
              <span className="value">
                {allVisible
                  ? shown === ""
                    ? "(empty)"
                    : (shown ?? "••••••••")
                  : "••••••••"}
              </span>
              <span
                className={`origin ${operation?.status === "error" ? "field-error-message" : ""}`}
                role={operation?.status === "error" ? "alert" : undefined}
              >
                {operation?.error ?? `Stored in ${row.environment.name}`}
              </span>
            </Button>
            {operation?.status === "saving" ? (
              <LoaderCircle
                aria-label={`Saving ${row.variable.name} in ${row.environment.name}`}
                className="size-4 animate-spin"
              />
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                className="cell-details"
                tabIndex={-1}
                aria-label={`Details for ${row.variable.name} in ${row.environment.name}`}
                onClick={(event) =>
                  setDetails({ row, trigger: event.currentTarget })
                }
              >
                <Info />
              </Button>
            )}
            {operation?.status === "error" ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Retry saving ${row.variable.name} in ${row.environment.name}`}
                onClick={() => void save(row, operation.payload)}
              >
                <RotateCcw />
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];
  const addingMatrix = catalog?.matrices.find((m) => m.id === addEnvironment);
  return (
    <div className="app">
      <header>
        <a className="brand" href="/" aria-label="Better Env Vault home">
          <span className="mark">E</span>Better Env Vault
        </a>
        <span className="local">● Local workspace</span>
      </header>
      <main>
        <div className="heading">
          <div>
            <p className="eyebrow">1PASSWORD SECRETS</p>
            <h1>All your environments, together.</h1>
            <p className="subheading">
              Search every secret. Filter by environment. Edit values in place.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => {
              activeCommit.current?.();
              setDetails(undefined);
              void load(true);
            }}
          >
            <RefreshCw />
            Refresh
          </Button>
        </div>
        <div className="vault-summary">
          <span>
            {rows.length} secrets · {catalog?.environments.length ?? 0}{" "}
            environments
          </span>
          <span>
            1Password ·{" "}
            {catalog?.auth === "service-account"
              ? "Service account"
              : "Desktop authentication"}
          </span>
        </div>
        {error ? (
          <div role="alert" className="alert error">
            {error}
          </div>
        ) : null}
        {Object.entries(operations)
          .filter(
            ([id, operation]) =>
              operation.status === "error" &&
              !rows.some((row) => row.id === id),
          )
          .map(([id, operation]) => (
            <div key={id} role="alert" className="alert error">
              {operation.error}
            </div>
          ))}
        {catalog?.errors.map((env) => (
          <div role="alert" className="alert error" key={env.id}>
            {env.name}: {env.error}
          </div>
        ))}
        <section
          className="environment-filters"
          aria-label="Environment filters"
        >
          <Button
            variant={environments.size ? "outline" : "default"}
            size="sm"
            aria-pressed={!environments.size}
            onClick={() => {
              activeCommit.current?.();
              hide();
              setEnvironments(new Set());
            }}
          >
            All environments
          </Button>
          {catalog?.environments.map((env) => (
            <Button
              key={env.id}
              variant={environments.has(env.id) ? "default" : "outline"}
              size="sm"
              aria-label={`Filter environment ${env.name}${env.account ? ` (${env.account})` : ""}`}
              aria-pressed={environments.has(env.id)}
              title={`${env.name} (${env.id})`}
              onClick={() => {
                activeCommit.current?.();
                hide();
                setEnvironments((previous) => {
                  const next = new Set(previous);
                  if (next.has(env.id)) next.delete(env.id);
                  else next.add(env.id);
                  return next;
                });
              }}
            >
              {env.name}
              <span className="filter-count">
                {rows.filter((row) => row.vaultId === env.id).length}
              </span>
            </Button>
          ))}
        </section>
        <div className="toolbar">
          <div className="search">
            <label className="sr-only" htmlFor="vault-search">
              Search secrets across environments
            </label>
            <Input
              id="vault-search"
              placeholder="Search secret names or environments…"
              value={search}
              onChange={(e) => {
                activeCommit.current?.();
                setSearch(e.target.value);
              }}
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            aria-label={
              allVisible || revealing ? "Hide all values" : "Reveal all values"
            }
            aria-pressed={allVisible || revealing}
            disabled={loading || !rows.length}
            onClick={() => void toggleValues()}
          >
            <EyeIcon hidden={allVisible || revealing} />
          </Button>
          <Button
            disabled={loading || !catalog?.matrices.length}
            onClick={() => {
              setAddEnvironment(
                catalog!.matrices.find(({ id }) => environments.has(id))?.id ??
                  catalog!.matrices[0].id,
              );
              setAddStage("choose");
            }}
          >
            <Plus />
            Add variable
          </Button>
        </div>
        {loading && !catalog ? (
          <p role="status">Loading secrets across environments…</p>
        ) : null}
        {catalog ? (
          <section className="matrix-wrap">
            <DataGrid
              ref={grid}
              className="environment-grid vault-grid rdg-light"
              aria-label="Secrets across environments"
              rows={filtered}
              columns={columns}
              rowKeyGetter={(row) => row.id}
              selectedRows={selected}
              onSelectedRowsChange={setSelected}
              rowHeight={64}
              headerRowHeight={44}
              style={{
                height: Math.max(240, Math.min(620, 44 + filtered.length * 64)),
              }}
              onCellKeyDown={(args, event) => {
                if (args.mode === "EDIT") {
                  event.preventGridDefault();
                  return;
                }
                if (
                  (event.key === "Enter" || event.key === "F2") &&
                  args.row &&
                  args.column?.key === "value"
                ) {
                  event.preventDefault();
                  event.preventGridDefault();
                  args.setActivePosition(
                    { rowIdx: args.rowIdx, idx: args.column.idx },
                    { enableEditor: true },
                  );
                }
              }}
              onCellMouseDown={(event) => {
                if (
                  event.column.key !== "value" ||
                  event.row.id !== activeRow.current
                )
                  activeCommit.current?.();
              }}
            />
            <footer className="matrix-footer">
              <span>
                {filtered.length} of {rows.length} secrets
              </span>
              {selected.size ? (
                <>
                  <strong>{selected.size} selected</strong>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear selection
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={
                      deleting ||
                      selected.size > 200 ||
                      pending.current.size > 0
                    }
                    onClick={() => {
                      setConfirmation("");
                      setDeleteRows(rows.filter((row) => selected.has(row.id)));
                    }}
                  >
                    <Trash2 />
                    Delete selected
                  </Button>
                </>
              ) : (
                <span>
                  {allVisible
                    ? "Values are visible."
                    : "Values stay masked until revealed."}
                </span>
              )}
            </footer>
          </section>
        ) : null}
        {catalog && !filtered.length ? (
          <p role="status">
            {rows.length
              ? "No secrets match your search and environment filters."
              : "No secrets found. Add a variable to an environment to get started."}
          </p>
        ) : null}
        <div className="save-status" role="status" aria-live="polite">
          {notice}
        </div>
        <p className="footnote">
          Enter saves down · Tab moves to the next secret · Escape cancels ·
          Alt+Enter adds a newline.
          <br />
          Each save changes only that secret’s environment.
        </p>
      </main>
      {details ? (
        <Editor
          key={details.row.id}
          cell={{
            environment: "vault",
            variable: details.row.variable,
            trigger: details.trigger,
          }}
          matrix={details.row.matrix}
          busy={false}
          saveError={operations[details.row.id]?.error ?? ""}
          onClose={() => setDetails(undefined)}
          onSource={() => {}}
          onReveal={() => reveal(details.row)}
          onSave={(payload) => {
            const row = details.row;
            setDetails(undefined);
            return save(row, payload);
          }}
        />
      ) : null}
      {addStage === "choose" ? (
        <Dialog
          title="Choose an environment"
          onClose={() => setAddStage(undefined)}
        >
          <p>New secrets belong to one environment.</p>
          <label>
            Environment
            <NativeSelect
              aria-label="New secret environment"
              value={addEnvironment}
              onChange={(e) => setAddEnvironment(e.target.value)}
            >
              {catalog?.matrices.map(({ id, matrix }) => (
                <NativeSelectOption key={id} value={id}>
                  {matrix.config.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <Button
            onClick={() => {
              setAddStage("create");
              setNotice("");
            }}
          >
            Continue
          </Button>
        </Dialog>
      ) : null}
      {addStage === "create" && addingMatrix && catalog ? (
        <ProjectDialog
          mode="add"
          matrix={addingMatrix.matrix}
          initialName=""
          busy={false}
          saveError=""
          onClose={() => setAddStage(undefined)}
          onSave={(payload) => {
            const env = catalog.environments.find(
              (e) => e.id === addingMatrix.id,
            )!;
            setAddStage(undefined);
            return save(
              {
                id: `add:${addingMatrix.id}:${payload.name}`,
                vaultId: addingMatrix.id,
                environment: env,
                matrix: addingMatrix.matrix,
                variable: { name: String(payload.name) },
              },
              payload,
            );
          }}
        />
      ) : null}
      {deleteRows ? (
        <Dialog
          title={`Delete ${deleteRows.length} secrets`}
          onClose={() => setDeleteRows(undefined)}
        >
          <p>
            Delete these secrets from their listed environments. Each
            environment is processed separately.
          </p>
          <ul className="delete-variable-list">
            {deleteRows.map((row) => (
              <li key={row.id}>
                <code>{row.variable.name}</code> · {row.environment.name}
              </li>
            ))}
          </ul>
          <label>
            Type DELETE to confirm
            <Input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <Button variant="outline" onClick={() => setDeleteRows(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirmation !== "DELETE"}
              onClick={() => void deleteSelected()}
            >
              Delete secrets
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
