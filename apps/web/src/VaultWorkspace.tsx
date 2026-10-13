import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DataGrid,
  SelectColumn,
  type Column,
  type DataGridHandle,
  type RenderEditCellProps,
  type SortColumn,
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
import type { Matrix } from "./matrix-model.js";
import { Textarea } from "./components/ui/textarea.js";
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
  sortVaultRows,
  maskCatalog,
  type VaultCatalog,
  type VaultRow,
  VaultValueCache,
  type RevealedVaultValue,
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
  code?: string;
  field: "value" | "notes";
}
function VaultValueEditor({
  row,
  rowIdx,
  column,
  field = "value",
  onClose,
  hideEpoch,
  visible,
  operation,
  cachedValue,
  save,
  reveal,
  register,
  navigate,
  retainDraft,
  draftValue,
}: RenderEditCellProps<VaultRow> & {
  field?: "value" | "notes";
  hideEpoch: number;
  visible: boolean;
  operation?: Operation;
  cachedValue?: RevealedVaultValue;
  save: (row: VaultRow, payload: Record<string, unknown>) => Promise<boolean>;
  reveal: (row: VaultRow) => Promise<{ editableValue?: string }>;
  register: (
    id: string,
    field: string,
    commit?: () => void,
    pause?: () => void,
  ) => void;
  retainDraft: (row: VaultRow, payload: Record<string, unknown>) => void;
  draftValue?: string;
  navigate: (
    rowIdx: number,
    columnIdx: number,
    direction: EditDirection,
  ) => void;
}) {
  const snapshot = useRef(row).current;
  const pausing = useRef(false);
  const onCommitReady = useCallback(
    (commit?: () => void) =>
      register(row.id, field, commit, () => {
        pausing.current = true;
        commit?.();
        pausing.current = false;
        onClose(false);
      }),
    [register, row.id, field],
  );
  const submit = (value: string) => {
    onClose(false);
    const payload = {
      action: "set",
      name: snapshot.variable.name,
      environment: "vault",
      [field]: value,
      fingerprint: snapshot.matrix.fingerprint,
      versions: snapshot.matrix.versions[snapshot.variable.name],
    };
    if (pausing.current) {
      retainDraft(snapshot, payload);
      return Promise.resolve(true);
    }
    return save(snapshot, payload);
  };
  return (
    <SpreadsheetEditor
      variable={
        field === "notes"
          ? { ...row.variable, value: row.notes, sensitive: false }
          : row.variable
      }
      inputLabel={
        field === "notes"
          ? `Notes for ${row.variable.name} in ${row.environment.name}`
          : undefined
      }
      environment={row.environment.name}
      compact
      shiftEnterNewline={field === "notes"}
      hideEpoch={hideEpoch}
      initialValue={
        field === "notes"
          ? { value: row.notes }
          : visible
            ? { value: row.variable.value }
            : cachedValue
              ? { value: cachedValue.editableValue }
              : undefined
      }
      draftValue={
        operation?.status === "error" &&
        typeof operation.payload[field] === "string"
          ? (operation.payload[field] as string)
          : draftValue
      }
      onLoad={() =>
        field === "notes"
          ? Promise.resolve({ editableValue: snapshot.notes })
          : reveal(snapshot)
      }
      onSave={submit}
      onLeave={submit}
      onCancel={() => onClose(false)}
      onCommitReady={onCommitReady}
      onNavigate={(direction) => {
        onClose(false, false);
        navigate(rowIdx, column.idx, direction);
      }}
    />
  );
}

export function VaultWorkspace({
  mutationToken,
  onDisconnect,
  startupError = "",
}: {
  mutationToken: string;
  startupError?: string;
  onDisconnect: () => void;
}) {
  const [catalog, setCatalog] = useState<VaultCatalog>();
  const catalogRef = useRef<VaultCatalog | undefined>(undefined);
  const valueCache = useRef(new VaultValueCache());
  const [loading, setLoading] = useState(true);
  const [readPending, setReadPending] = useState(false);
  const [sortColumns, setSortColumns] = useState<readonly SortColumn[]>([
    { columnKey: "name", direction: "ASC" },
  ]);
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
  const [drafts, setDrafts] = useState<
    Record<
      string,
      {
        row: VaultRow;
        payload: Record<string, unknown>;
        field: "value" | "notes";
      }
    >
  >({});
  function retainDraft(row: VaultRow, payload: Record<string, unknown>) {
    setDrafts((previous) => {
      const next = { ...previous };
      const { value: _value, notes: _notes, ...metadata } = payload;
      for (const field of ["value", "notes"] as const) {
        if (typeof payload[field] === "string")
          next[JSON.stringify([row.id, field])] = {
            row,
            field,
            payload: { ...metadata, [field]: payload[field] },
          };
      }
      return next;
    });
  }

  const [review, setReview] = useState<{
    row: VaultRow;
    operation: Operation;
    draft: string;
    latest?: string;
  }>();
  const [reviewBusy, setReviewBusy] = useState(false);
  const saving = Object.values(operations).some((op) => op.status === "saving");
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
  const [gridWidth, setGridWidth] = useState(0);
  const [resizedWidths, setResizedWidths] = useState<Record<string, number>>(
    {},
  );
  const [freezeNames, setFreezeNames] = useState(
    () => window.matchMedia("(min-width: 640px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 640px)");
    const update = () => setFreezeNames(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const activeCommit = useRef<(() => void) | undefined>(undefined);
  const activePause = useRef<(() => void) | undefined>(undefined);
  const activeRow = useRef<string | undefined>(undefined);
  const activeField = useRef<string | undefined>(undefined);
  const register = useCallback(
    (id: string, field: string, commit?: () => void, pause?: () => void) => {
      activeCommit.current = commit;
      activePause.current = commit ? pause : undefined;
      activeRow.current = commit ? id : undefined;
      activeField.current = commit ? field : undefined;
    },
    [],
  );
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
    valueCache.current.clear();
    visibleIntent.current = false;
    ++visibility.current;
    setAllVisible(false);
    setSortColumns((previous) =>
      previous.filter((sort) => sort.columnKey !== "value"),
    );
    setRevealing(false);
    setHideEpoch((e) => e + 1);
    setDetails(undefined);
    setCatalog((previous) => (previous ? maskCatalog(previous) : previous));
  }, []);
  const load = useCallback(
    async (fresh = false, quiet = false) => {
      if (fresh) valueCache.current.clear();
      const id = ++loadId.current;
      const generation = visibility.current;
      if (!quiet) setLoading(true);
      setReadPending(true);
      setError("");
      try {
        let data = await api<VaultCatalog>(
          `/api/catalog${fresh ? "?fresh=1" : ""}`,
        );
        if (!alive.current || id !== loadId.current) return;
        catalogRef.current = maskCatalog(data);
        valueCache.current.reconcile(catalogRows(data));
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
        const available = new Set(catalogRows(data).map((row) => row.id));
        setSelected(
          (previous) =>
            new Set([...previous].filter((id) => available.has(id))),
        );
      } catch (error) {
        if (alive.current && id === loadId.current) {
          hide();
          setError((error as Error).message);
        }
      } finally {
        if (alive.current && id === loadId.current) {
          setLoading(false);
          setReadPending(false);
        }
      }
    },
    [api, hide],
  );
  useEffect(() => {
    if (!mutationToken) return;
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      valueCache.current.clear();
      ++loadId.current;
      ++visibility.current;
    };
  }, [load, mutationToken]);
  const rows = useMemo(() => (catalog ? catalogRows(catalog) : []), [catalog]);
  const filtered = useMemo(
    () =>
      sortVaultRows(filterVaultRows(rows, search, environments), sortColumns),
    [rows, search, environments, sortColumns],
  );
  useLayoutEffect(() => {
    const element = grid.current?.element;
    if (!element) return;
    const measure = () => setGridWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [!!catalog]);
  function reveal(row: VaultRow) {
    return valueCache.current.get(row, async () => {
      try {
        return await api<RevealedVaultValue>(
          `/api/reveal?project=${encodeURIComponent(row.vaultId)}`,
          {
            name: row.variable.name,
            environment: "vault",
            fingerprint: row.matrix.fingerprint,
            itemId: row.variable.itemId,
            version: row.variable.explicit?.version,
          },
        );
      } catch (error) {
        valueCache.current.clear();
        throw error;
      }
    });
  }
  function patchMatrix(id: string, matrix: Matrix, generation: number) {
    ++loadId.current;
    setLoading(false);
    setReadPending(false);
    setCatalog((previous) => {
      if (!previous) return previous;
      const current = previous.matrices.find(
        (entry) => entry.id === id,
      )?.matrix;
      if ((current?.revision ?? 0) > (matrix.revision ?? 0)) return previous;
      const next = {
        ...previous,
        matrices: previous.matrices.map((entry) =>
          entry.id === id
            ? {
                id,
                matrix:
                  visibleIntent.current && generation === visibility.current
                    ? matrix
                    : maskCatalog({ ...previous, matrices: [{ id, matrix }] })
                        .matrices[0].matrix,
              }
            : entry,
        ),
      };
      catalogRef.current = maskCatalog(next);
      valueCache.current.reconcile(catalogRows(next));
      return next;
    });
  }
  async function reviewConflict(row: VaultRow, operation: Operation) {
    setReviewBusy(true);
    setError("");
    try {
      const matrix = await api<Matrix>(
        `/api/matrix?project=${encodeURIComponent(row.vaultId)}&fresh=1`,
      );
      // A conflict refresh masks this environment until values are explicitly revealed again.
      hide();
      patchMatrix(row.vaultId, matrix, visibility.current);
      const freshRow = catalogRows({
        environments: [row.environment],
        matrices: [{ id: row.vaultId, matrix }],
        errors: [],
        auth: "desktop",
      }).find((candidate) => candidate.id === row.id);
      if (!freshRow)
        throw new Error(
          "This secret was deleted. Your draft is retained in the save error; copy it before discarding.",
        );
      setReview({
        row: freshRow,
        operation,
        draft: String(operation.payload[operation.field] ?? ""),
        latest: operation.field === "notes" ? freshRow.notes : undefined,
      });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setReviewBusy(false);
    }
  }
  async function save(
    row: Omit<VaultRow, "variable"> & {
      variable: Pick<VaultRow["variable"], "name">;
    },
    payload: Record<string, unknown>,
  ) {
    const draftRow = rows.find((candidate) => candidate.id === row.id);
    if (draftRow && payload.action === "set") retainDraft(draftRow, payload);
    if (pending.current.has(row.id)) return false;
    valueCache.current.invalidate(row.id);
    pending.current.add(row.id);
    setOperations((previous) => ({
      ...previous,
      [row.id]: {
        payload,
        status: "saving",
        field:
          payload.notes !== undefined && payload.value === undefined
            ? "notes"
            : "value",
      },
    }));
    setNotice("");
    const generation = visibility.current;
    try {
      const result = await api<{ matrix: Matrix }>(
        `/api/edit?project=${encodeURIComponent(row.vaultId)}`,
        {
          fingerprint: row.matrix.fingerprint,
          ...payload,
          reveal: visibleIntent.current,
        },
      );
      if (!alive.current) return true;
      patchMatrix(row.vaultId, result.matrix, generation);
      // Clear the guard before making the row editable; no async refresh window.
      pending.current.delete(row.id);
      setDrafts((previous) => {
        const next = { ...previous };
        for (const field of ["value", "notes"] as const) {
          const key = JSON.stringify([row.id, field]);
          if (
            typeof payload[field] === "string" &&
            next[key]?.payload[field] === payload[field]
          )
            delete next[key];
        }
        return next;
      });
      setOperations((previous) => {
        const next = { ...previous };
        delete next[row.id];
        return next;
      });
      if (alive.current)
        setNotice(
          `Saved ${payload.notes !== undefined && payload.value === undefined ? "notes for " : ""}${row.variable.name} in ${row.environment.name}.`,
        );
      return true;
    } catch (error) {
      if (alive.current)
        setOperations((previous) => ({
          ...previous,
          [row.id]: {
            payload,
            status: "error",
            field:
              payload.notes !== undefined && payload.value === undefined
                ? "notes"
                : "value",
            error: (error as Error).message,
            code: error instanceof RequestError ? error.code : undefined,
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
  function navigate(
    rowIdx: number,
    columnIdx: number,
    direction: EditDirection,
  ) {
    let nextRow = rowIdx,
      nextColumn = columnIdx;
    const valueColumn = columns.findIndex((column) => column.key === "value");
    const notesColumn = columns.findIndex((column) => column.key === "notes");
    if (direction === "up" || direction === "down")
      nextRow += direction === "up" ? -1 : 1;
    else if (direction === "next") {
      if (nextColumn === valueColumn) nextColumn = notesColumn;
      else {
        nextColumn = valueColumn;
        nextRow++;
      }
    } else {
      if (nextColumn === notesColumn) nextColumn = valueColumn;
      else {
        nextColumn = notesColumn;
        nextRow--;
      }
    }
    if (nextRow < 0 || nextRow >= filtered.length) return;
    // Keep the destination predictable even when that item is still saving.
    grid.current?.setActivePosition(
      { rowIdx: nextRow, idx: nextColumn },
      {
        enableEditor: !pending.current.has(filtered[nextRow].id),
      },
    );
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
    { ...SelectColumn, width: 36, minWidth: 36, frozen: freezeNames },
    {
      key: "name",
      name: "Secret",
      sortable: true,
      minWidth: 220,
      width: resizedWidths.name ?? (freezeNames ? 300 : 220),
      resizable: true,
      frozen: freezeNames,
      renderCell: ({ row }) => (
        <div className="variable-cell">
          <code title={row.variable.name}>{row.variable.name}</code>
        </div>
      ),
    },
    {
      key: "environment",
      name: "Environment",
      sortable: true,
      minWidth: 160,
      width: resizedWidths.environment ?? 170,
      resizable: true,
      renderCell: ({ row }) => (
        <div className="vault-environment-cell">
          <strong
            title={`${row.environment.name} · ${row.environment.account ?? ""} · ${row.vaultId}`}
          >
            {row.environment.name}
          </strong>
          {row.environment.account &&
          catalog?.environments.filter(
            (env) => env.name === row.environment.name,
          ).length! > 1 ? (
            <span>{row.environment.account}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "value",
      name: "Value",
      sortable: allVisible,
      minWidth: allVisible ? 260 : 160,
      resizable: true,
      width:
        resizedWidths.value ??
        (allVisible
          ? Math.max(
              260,
              gridWidth -
                36 -
                (resizedWidths.name ?? (freezeNames ? 300 : 220)) -
                (resizedWidths.environment ?? 170) -
                (resizedWidths.notes ?? 280),
            )
          : 160),
      cellClass: "environment-value-cell",
      editable: (row) =>
        !loading &&
        !readPending &&
        !deleting &&
        operations[row.id]?.status !== "saving",
      editorOptions: {
        commitOnOutsideClick: false,
        closeOnExternalRowChange: false,
      },
      renderEditCell: (props) => (
        <VaultValueEditor
          {...props}
          visible={allVisible}
          hideEpoch={hideEpoch}
          operation={
            operations[props.row.id]?.field === "value"
              ? operations[props.row.id]
              : undefined
          }
          cachedValue={valueCache.current.peek(props.row)}
          save={save}
          reveal={reveal}
          register={register}
          retainDraft={retainDraft}
          draftValue={
            drafts[JSON.stringify([props.row.id, "value"])]?.payload.value as
              | string
              | undefined
          }
          navigate={navigate}
        />
      ),
      renderCell: ({ row, rowIdx, column }) => {
        const operation =
          operations[row.id]?.field === "value"
            ? operations[row.id]
            : undefined;
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
              title={operation?.error}
              disabled={
                loading ||
                readPending ||
                deleting ||
                operations[row.id]?.status === "saving"
              }
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
            </Button>
            {operation?.status === "saving" ? (
              <span
                role="status"
                className="field-progress"
                aria-label={`Saving ${row.variable.name} in ${row.environment.name}`}
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin"
                />
              </span>
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
                className="cell-retry"
                aria-label={`${operation.code === "conflict" ? "Review draft for" : "Retry saving"} ${row.variable.name} in ${row.environment.name}`}
                onClick={() =>
                  void (operation.code === "conflict"
                    ? reviewConflict(row, operation)
                    : save(row, operation.payload))
                }
              >
                <RotateCcw />
              </Button>
            ) : null}
          </div>
        );
      },
    },
    {
      key: "notes",
      name: "Notes",
      sortable: true,
      minWidth: 180,
      width:
        resizedWidths.notes ??
        (allVisible
          ? 280
          : Math.max(
              280,
              gridWidth -
                36 -
                (resizedWidths.name ?? (freezeNames ? 300 : 220)) -
                (resizedWidths.environment ?? 170) -
                (resizedWidths.value ?? 160),
            )),
      resizable: true,
      cellClass: "environment-value-cell notes-value-cell",
      editable: (row) =>
        !loading &&
        !readPending &&
        !deleting &&
        operations[row.id]?.status !== "saving",
      editorOptions: {
        commitOnOutsideClick: false,
        closeOnExternalRowChange: false,
      },
      renderEditCell: (props) => (
        <VaultValueEditor
          {...props}
          field="notes"
          visible
          hideEpoch={hideEpoch}
          operation={
            operations[props.row.id]?.field === "notes"
              ? operations[props.row.id]
              : undefined
          }
          save={save}
          reveal={reveal}
          register={register}
          retainDraft={retainDraft}
          draftValue={
            drafts[JSON.stringify([props.row.id, "notes"])]?.payload.notes as
              | string
              | undefined
          }
          navigate={navigate}
        />
      ),
      renderCell: ({ row, rowIdx, column }) => {
        const operation =
          operations[row.id]?.field === "notes"
            ? operations[row.id]
            : undefined;
        const shown =
          operation?.status === "saving" &&
          typeof operation.payload.notes === "string"
            ? operation.payload.notes
            : row.notes;
        return (
          <div
            className="matrix-cell"
            aria-busy={operation?.status === "saving"}
          >
            <Button
              variant="ghost"
              className="value-cell notes-cell"
              tabIndex={-1}
              disabled={
                loading ||
                readPending ||
                deleting ||
                operations[row.id]?.status === "saving"
              }
              aria-label={`Edit notes for ${row.variable.name} in ${row.environment.name}`}
              title={operation?.error ?? (shown || "Add notes")}
              onClick={() =>
                grid.current?.setActivePosition(
                  { rowIdx, idx: column.idx },
                  { enableEditor: true },
                )
              }
            >
              <span className="value">
                {shown || <span className="text-muted-foreground">—</span>}
              </span>
            </Button>
            {operation?.status === "saving" ? (
              <span
                role="status"
                className="field-progress"
                aria-label={`Saving notes for ${row.variable.name} in ${row.environment.name}`}
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin"
                />
              </span>
            ) : null}
            {operation?.status === "error" ? (
              <Button
                variant="ghost"
                size="icon-xs"
                className="cell-retry"
                aria-label={`${operation.code === "conflict" ? "Review notes draft for" : "Retry saving notes for"} ${row.variable.name} in ${row.environment.name}`}
                onClick={() =>
                  void (operation.code === "conflict"
                    ? reviewConflict(row, operation)
                    : save(row, operation.payload))
                }
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
  const loadingLabel = !mutationToken
    ? "Connecting this browser…"
    : revealing
      ? "Revealing values…"
      : catalog
        ? "Refreshing secrets…"
        : "Loading 1Password secrets…";
  return (
    <div className="app vault-app">
      <header>
        <a className="brand" href="/" aria-label="Better Env Vault home">
          <span className="mark">E</span>Better Env Vault
        </a>
        <span
          className="local"
          title={`1Password · ${(catalog?.auth ?? document.querySelector<HTMLMetaElement>('meta[name="bev-auth"]')?.content) === "service-account" ? "Service account" : "Desktop authentication"}`}
        >
          {(catalog?.auth ??
            document.querySelector<HTMLMetaElement>('meta[name="bev-auth"]')
              ?.content) === "service-account"
            ? "Service account"
            : "1Password"}
        </span>
      </header>
      <main>
        {startupError ? (
          <div role="alert" className="alert error">
            {startupError}
            <Button variant="outline" onClick={() => location.reload()}>
              Retry connection
            </Button>
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="alert error">
            {error}
          </div>
        ) : null}
        {Object.entries(operations)
          .filter(([, operation]) => operation.status === "error")
          .map(([id, operation]) => {
            const row = rows.find((row) => row.id === id);
            return (
              <div key={id} role="alert" className="alert error">
                <span>
                  {String(operation.payload.name)}: {operation.error} Your draft
                  is retained.
                </span>
                {row ? (
                  <Button
                    variant="outline"
                    disabled={reviewBusy}
                    onClick={() => void reviewConflict(row, operation)}
                  >
                    Review draft
                  </Button>
                ) : (
                  <Input
                    readOnly
                    type={
                      operation.field === "value" && !allVisible
                        ? "password"
                        : "text"
                    }
                    aria-label={`Retained draft for ${String(operation.payload.name)}`}
                    value={String(operation.payload[operation.field] ?? "")}
                  />
                )}
                <Button
                  variant="outline"
                  onClick={() => {
                    setOperations((previous) => {
                      const next = { ...previous };
                      delete next[id];
                      return next;
                    });
                    setDrafts((previous) => {
                      const next = { ...previous };
                      delete next[JSON.stringify([id, operation.field])];
                      return next;
                    });
                  }}
                >
                  Discard draft
                </Button>
              </div>
            );
          })}
        {Object.entries(drafts)
          .filter(
            ([, draft]) =>
              operations[draft.row.id]?.field !== draft.field ||
              !operations[draft.row.id],
          )
          .map(([key, draft]) => (
            <div key={key} className="alert" role="status">
              <span>
                Unsaved {draft.field} draft for {draft.row.variable.name} in{" "}
                {draft.row.environment.name}.
              </span>
              <Button
                variant="outline"
                disabled={reviewBusy}
                onClick={() =>
                  void reviewConflict(draft.row, { ...draft, status: "error" })
                }
              >
                Review draft
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  setDrafts((previous) => {
                    const next = { ...previous };
                    delete next[key];
                    return next;
                  })
                }
              >
                Discard draft
              </Button>
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
              activePause.current?.();
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
                activePause.current?.();
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
              {catalog.environments.filter((other) => other.name === env.name)
                .length > 1 && env.account
                ? ` · ${env.account}`
                : ""}
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
              placeholder="Search secrets, environments, or notes…"
              value={search}
              onChange={(e) => {
                activePause.current?.();
                setSearch(e.target.value);
              }}
            />
          </div>
          {(loading || readPending || revealing) && !startupError ? (
            <div
              className="loading-status toolbar-loading"
              role="status"
              aria-live="polite"
              aria-label={loadingLabel}
            >
              <LoaderCircle className="size-4 animate-spin" />
              <span>{loadingLabel}</span>
            </div>
          ) : null}
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh secrets"
            title="Refresh secrets"
            disabled={loading || readPending || saving || !mutationToken}
            onClick={() => {
              activePause.current?.();
              setDetails(undefined);
              void load(true);
            }}
          >
            <RefreshCw
              className={loading || readPending ? "animate-spin" : undefined}
            />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label={
              allVisible || revealing ? "Hide all values" : "Reveal all values"
            }
            aria-pressed={allVisible || revealing}
            disabled={
              loading || (saving && !allVisible && !revealing) || !rows.length
            }
            onClick={() => {
              activePause.current?.();
              void toggleValues();
            }}
          >
            <EyeIcon hidden={allVisible || revealing} />
          </Button>
          <Button
            disabled={loading || saving || !catalog?.matrices.length}
            onClick={() => {
              activePause.current?.();
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
        <section className="matrix-wrap" aria-busy={loading || readPending}>
          <DataGrid
            ref={grid}
            className="environment-grid vault-grid rdg-light"
            aria-label="Secrets across environments"
            rows={filtered}
            sortColumns={sortColumns}
            onSortColumnsChange={(next) => {
              activePause.current?.();
              grid.current?.setActivePosition({ rowIdx: -1, idx: 0 });
              setSortColumns(next);
            }}
            columns={columns}
            onColumnResize={(column, width) =>
              setResizedWidths((previous) => ({
                ...previous,
                [column.key]: width,
              }))
            }
            rowKeyGetter={(row) => row.id}
            selectedRows={selected}
            onSelectedRowsChange={setSelected}
            rowHeight={36}
            headerRowHeight={32}
            style={{
              height: `min(${Math.max(104, 32 + filtered.length * 36)}px, calc(100dvh - 182px))`,
            }}
            onCellKeyDown={(args, event) => {
              if (args.mode === "EDIT") {
                event.preventGridDefault();
                return;
              }
              if (
                (event.key === "Enter" || event.key === "F2") &&
                args.row &&
                (args.column?.key === "value" || args.column?.key === "notes")
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
                event.column.key !== activeField.current ||
                event.row.id !== activeRow.current
              )
                activeCommit.current?.();
            }}
          />
          <footer className="matrix-footer">
            <span title="Enter saves; Tab saves and moves; Shift+Enter adds a line in Notes; Escape cancels">
              Enter save · Tab move · Shift+Enter notes newline · Esc cancel
            </span>
            <span>
              {catalog
                ? `${filtered.length} of ${rows.length} secrets`
                : "Waiting for 1Password…"}
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
                    deleting || selected.size > 200 || pending.current.size > 0
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
                {catalog
                  ? allVisible
                    ? "Values visible"
                    : "Values hidden"
                  : ""}
              </span>
            )}
          </footer>
        </section>
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
      </main>
      {review ? (
        <Dialog
          title={`Review draft for ${review.row.variable.name}`}
          onClose={() => setReview(undefined)}
        >
          <p>
            The secret changed since you started editing. Compare the latest{" "}
            {review.operation.field} with your draft before saving.
          </p>
          <label>
            Latest {review.operation.field}
            <Textarea
              readOnly
              aria-label="Latest field"
              value={review.latest ?? "Hidden"}
            />
          </label>
          {review.latest === undefined ? (
            <Button
              disabled={reviewBusy}
              onClick={async () => {
                setReviewBusy(true);
                try {
                  const result = await reveal(review.row);
                  setReview((current) =>
                    current === review
                      ? { ...current, latest: result.editableValue }
                      : current,
                  );
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  setReviewBusy(false);
                }
              }}
            >
              Reveal latest value
            </Button>
          ) : null}
          <label>
            Your draft
            <Textarea
              aria-label="Retained draft"
              value={review.draft}
              onChange={(e) => setReview({ ...review, draft: e.target.value })}
            />
          </label>
          <Button
            disabled={reviewBusy || review.latest === undefined}
            onClick={() => {
              const current = review;
              setReview(undefined);
              void save(current.row, {
                action: "set",
                name: current.row.variable.name,
                environment: "vault",
                [current.operation.field]: current.draft,
                fingerprint: current.row.matrix.fingerprint,
                versions:
                  current.row.matrix.versions[current.row.variable.name],
              });
            }}
          >
            Save reviewed draft
          </Button>
          <Button variant="outline" onClick={() => setReview(undefined)}>
            Keep draft
          </Button>
        </Dialog>
      ) : null}
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
                  {matrix.config.account ? ` · ${matrix.config.account}` : ""}
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
                notes: "",
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
