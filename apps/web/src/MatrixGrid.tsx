import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import {
  DataGrid,
  SelectColumn,
  type Column,
  type DataGridHandle,
  type RenderEditCellProps,
  type SortColumn,
  type RenderHeaderCellProps,
} from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { focusGridCell, useSearchShortcuts } from "./use-search-shortcuts.js";
import { Info, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "./components/ui/button.js";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "./components/ui/tooltip.js";
import {
  SpreadsheetEditor,
  originLabel,
  type EditDirection,
} from "./MatrixCell.js";
import {
  fieldKey,
  type Cell,
  type Matrix,
  type SaveOperation,
} from "./matrix-model.js";
import type { ResolvedVariable } from "../../../packages/core/src/resolver.js";

interface ActiveEdit {
  rowIdx: number;
  idx: number;
  commit: () => void;
}

interface GridRow {
  name: string;
  definition: ResolvedVariable;
  cells: Record<string, ResolvedVariable>;
}
interface Props {
  project: string;
  matrix: Matrix;
  displayMatrix: Matrix;
  variables: ResolvedVariable[];
  allVisible: boolean;
  busy: boolean;
  hideEpoch: number;
  resetEpoch: number;
  search: string;
  onSearchChange: (search: string) => void;
  operations: Record<string, SaveOperation>;
  selectedRows: ReadonlySet<string>;
  onSelectedRowsChange: (selected: Set<string>) => void;
  deleting: ReadonlySet<string>;
  onSave: (payload: Record<string, unknown>) => Promise<boolean>;
  onReveal: (
    environment: string,
    name: string,
  ) => Promise<{ editableValue?: string; value?: string }>;
  onDetails: (cell: Cell) => void;
}

function GridEditor({
  row,
  column,
  rowIdx,
  onClose,
  environment,
  matrix,
  allVisible,
  hideEpoch,
  onSave,
  onReveal,
  registerCommit,
  onNavigate,
  draftValue,
  initiallyExpanded = false,
}: RenderEditCellProps<GridRow> & {
  draftValue?: string;
  initiallyExpanded?: boolean;
  environment: string;
  matrix: Matrix;
  allVisible: boolean;
  hideEpoch: number;
  onSave: Props["onSave"];
  onReveal: Props["onReveal"];
  registerCommit: (entry: ActiveEdit | undefined) => void;
  onNavigate: (rowIdx: number, idx: number, direction: EditDirection) => void;
}) {
  const onCommitReady = useCallback(
    (commit: (() => void) | undefined) => {
      registerCommit(commit ? { rowIdx, idx: column.idx, commit } : undefined);
    },
    [rowIdx, column.idx, registerCommit],
  );
  const variable =
    environment === "schema" ? row.definition : row.cells[environment];
  // Capture the optimistic-concurrency versions when editing begins. Background
  // refreshes must not turn an old draft into an unchecked overwrite.
  const versions = useRef(matrix.versions[row.name]).current;
  const fingerprint = useRef(matrix.fingerprint).current;
  const initialValue = {
    value:
      environment === "schema"
        ? variable.defaultValue
        : (matrix.editableValues?.[environment]?.[row.name] ??
          matrix.resolutions
            .find((resolution) => resolution.environment === environment)
            ?.variables.find((entry) => entry.name === row.name)?.value),
  };
  function submit(payload: Record<string, unknown>) {
    const result = onSave({ fingerprint, ...payload });
    onClose(false);
    return result;
  }
  return (
    <SpreadsheetEditor
      variable={variable}
      environment={environment}
      initiallyExpanded={initiallyExpanded}
      hideEpoch={hideEpoch}
      draftValue={draftValue}
      initialValue={initialValue}
      onLoad={() =>
        environment === "schema"
          ? Promise.resolve({ editableValue: variable.defaultValue })
          : onReveal(environment, row.name)
      }
      onSave={(value) =>
        submit({
          action: environment === "schema" ? "default" : "set",
          name: row.name,
          environment: environment === "schema" ? undefined : environment,
          value,
          versions,
        })
      }
      onLeave={(value) =>
        onSave({
          fingerprint,
          action: environment === "schema" ? "default" : "set",
          name: row.name,
          environment: environment === "schema" ? undefined : environment,
          value,
          versions,
        })
      }
      onCancel={() => onClose(false)}
      onCommitReady={onCommitReady}
      onNavigate={(direction) => {
        onClose(false, false);
        onNavigate(rowIdx, column.idx, direction);
      }}
    />
  );
}

export function MatrixGrid(props: Props) {
  const {
    project,
    matrix,
    displayMatrix,
    variables,
    allVisible,
    busy,
    hideEpoch,
    resetEpoch,
    search,
    onSearchChange,
    operations,
    selectedRows,
    onSelectedRowsChange,
    deleting,
    onSave,
    onReveal,
    onDetails,
  } = props;
  const grid = useRef<DataGridHandle>(null);
  const expandedEditor = useRef<string | undefined>(undefined);
  const activePosition = useRef<
    | { name?: string; columnKey: string; rowIdx: number; idx: number }
    | undefined
  >(undefined);
  const searchBookmark = useRef<
    { query: string; position: typeof activePosition.current } | undefined
  >(undefined);

  const activeEdit = useRef<ActiveEdit | undefined>(undefined);
  const registerCommit = useCallback((entry: ActiveEdit | undefined) => {
    activeEdit.current = entry;
  }, []);
  const [freezeVariables, setFreezeVariables] = useState(
    () => window.matchMedia("(min-width: 640px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)");
    const change = () => setFreezeVariables(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const [sortColumns, setSortColumns] = useState<readonly SortColumn[]>([]);
  const unsortedRows = useMemo(() => {
    const environments = new Map(
      displayMatrix.resolutions.map((resolution) => [
        resolution.environment,
        new Map(
          resolution.variables.map((variable) => [variable.name, variable]),
        ),
      ]),
    );
    return variables.map((definition) => ({
      name: definition.name,
      definition,
      cells: Object.fromEntries(
        matrix.environments.map((env) => [
          env,
          environments.get(env)!.get(definition.name)!,
        ]),
      ),
    }));
  }, [variables, matrix.environments, displayMatrix]);
  const sortValues = useMemo(
    () =>
      Object.fromEntries(
        matrix.resolutions.map((resolution) => [
          resolution.environment,
          new Map(
            resolution.variables.map((variable) => [
              variable.name,
              variable.value ?? "",
            ]),
          ),
        ]),
      ),
    [matrix],
  );
  const sortDefaults = useMemo(
    () =>
      new Map(
        matrix.resolutions[0].variables.map((variable) => [
          variable.name,
          variable.defaultValue ?? "",
        ]),
      ),
    [matrix],
  );
  const rows = useMemo(
    () =>
      [...unsortedRows].sort((left, right) => {
        for (const sort of sortColumns) {
          const value = (row: GridRow) =>
            sort.columnKey === "variable"
              ? row.name
              : sort.columnKey === "schema"
                ? (sortDefaults.get(row.name) ?? "")
                : (sortValues[sort.columnKey]?.get(row.name) ?? "");
          const order = value(left).localeCompare(value(right), undefined, {
            numeric: true,
          });
          if (order) return sort.direction === "DESC" ? -order : order;
        }
        return 0;
      }),
    [unsortedRows, sortColumns, sortDefaults, sortValues],
  );
  useEffect(() => {
    grid.current?.setActivePosition({ rowIdx: -1, idx: 0 });
  }, [resetEpoch]);
  function operation(name: string, environment: string) {
    return operations[fieldKey(project, name, environment)];
  }
  function editable(row: GridRow, environment: string) {
    return (
      !busy &&
      !deleting.has(row.name) &&
      operation(row.name, environment)?.status !== "saving" &&
      operation(row.name, "definition")?.status !== "saving" &&
      (environment !== "schema" ||
        (!row.definition.sensitive && row.definition.editable))
    );
  }
  function navigate(rowIdx: number, idx: number, direction: EditDirection) {
    const keys = [
      "select",
      "variable",
      ...(matrix.mode === "vault" ? [] : ["schema"]),
      ...matrix.environments,
    ];
    let nextRow = rowIdx,
      nextIdx = idx;
    for (let step = 0; step < rows.length * keys.length; step++) {
      if (direction === "up" || direction === "down")
        nextRow += direction === "up" ? -1 : 1;
      else {
        nextIdx += direction === "previous" ? -1 : 1;
        if (nextIdx >= keys.length) {
          nextIdx = 2;
          nextRow++;
        }
        if (nextIdx < 2) {
          nextIdx = keys.length - 1;
          nextRow--;
        }
      }
      if (nextRow < 0 || nextRow >= rows.length) return;
      if (editable(rows[nextRow], keys[nextIdx])) {
        grid.current?.setActivePosition(
          { rowIdx: nextRow, idx: nextIdx },
          { enableEditor: true },
        );
        return;
      }
    }
  }
  function field(
    row: GridRow,
    environment: string,
    rowIdx: number,
    idx: number,
  ) {
    const variable =
      environment === "schema" ? row.definition : row.cells[environment];
    const active = operation(row.name, environment);
    const saving = active?.status === "saving";
    const preview =
      saving && typeof active.payload.value === "string"
        ? active.payload.value
        : undefined;
    const value =
      environment === "schema" ? variable.defaultValue : variable.value;
    const shown = preview ?? value;
    const text =
      variable.sensitive && !allVisible
        ? (environment === "schema"
            ? variable.hasDefault
            : variable.state !== "missing") || preview !== undefined
          ? "••••••••"
          : environment === "schema"
            ? "No default"
            : "Not set"
        : shown === undefined
          ? environment === "schema"
            ? "No default"
            : "Not set"
          : shown === ""
            ? "(empty)"
            : shown;
    return (
      <div
        className={`matrix-cell ${saving ? "saving-cell" : ""}`}
        aria-busy={saving}
      >
        <Button
          variant="ghost"
          className={`value-cell ${environment === "schema" ? "schema-default" : variable.state} ${!variable.valid ? "invalid" : ""}`}
          tabIndex={-1}
          disabled={!editable(row, environment)}
          aria-label={
            environment === "schema"
              ? `Edit default for ${row.name}`
              : `Edit ${row.name} in ${environment}`
          }
          onClick={() =>
            grid.current?.setActivePosition(
              { rowIdx, idx },
              { enableEditor: true },
            )
          }
        >
          <span className="value">{text}</span>
          <span
            className={`origin ${active?.status === "error" ? "field-error-message" : ""}`}
            role={active?.status === "error" ? "alert" : undefined}
            title={active?.error}
          >
            {active?.status === "error"
              ? active.error
              : environment === "schema"
                ? "Schema default"
                : matrix.mode === "vault"
                  ? "Stored in vault"
                  : `${!variable.valid ? "Invalid · " : ""}${originLabel(variable)}`}
          </span>
        </Button>
        {saving ? (
          <span
            className="field-progress"
            role="status"
            aria-label={`Saving ${row.name} in ${environment}`}
          >
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            <span className="sr-only">Saving…</span>
          </span>
        ) : environment !== "schema" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            className="cell-details"
            aria-label={`Details for ${row.name} in ${environment}`}
            title="Value details and advanced editing"
            disabled={busy || deleting.has(row.name)}
            onClick={(event) => {
              event.stopPropagation();
              grid.current?.setActivePosition({ rowIdx, idx });
              onDetails({
                environment,
                variable,
                trigger: event.currentTarget,
              });
            }}
          >
            <Info aria-hidden="true" />
          </Button>
        ) : null}
        {active?.status === "error" ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="cell-retry"
            aria-label={`Retry saving ${row.name} in ${environment}`}
            title={`${active.error} — Retry save`}
            onClick={() => void onSave(active.payload)}
          >
            <RotateCcw aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    );
  }
  const columns: Column<GridRow>[] = [
    { ...SelectColumn, width: 36, minWidth: 36, frozen: freezeVariables },
    {
      key: "variable",
      name: "Variable",
      sortable: true,
      width: freezeVariables ? 260 : 180,
      minWidth: 180,
      frozen: freezeVariables,
      resizable: true,
      renderHeaderCell: ({ sortDirection }) => (
        <span>
          Variable <span className="variable-count">{variables.length}</span>
          {sortDirection ? (
            <span aria-hidden="true">
              {" "}
              {sortDirection === "ASC" ? "↑" : "↓"}
            </span>
          ) : null}
        </span>
      ),
      renderCell: ({ row }) => (
        <div
          className="variable-cell"
          title={row.definition.description || row.name}
        >
          <code title={row.name}>{row.name}</code>
          {deleting.has(row.name) ? (
            <span
              className="row-deleting"
              role="status"
              aria-label={`Deleting ${row.name}`}
            >
              <LoaderCircle
                className="size-3 animate-spin"
                aria-hidden="true"
              />{" "}
              Deleting…
            </span>
          ) : null}
          {matrix.mode !== "vault" ? (
            <p>{row.definition.description || "No description"}</p>
          ) : null}
          <div className="badges">
            {matrix.mode !== "vault" ? (
              <span>{row.definition.type}</span>
            ) : null}
            {row.definition.required ? <span>required</span> : null}
            <span>{row.definition.sensitive ? "sensitive" : "public"}</span>
          </div>
        </div>
      ),
    },
    ...[
      ...(matrix.mode === "vault" ? [] : ["schema"]),
      ...matrix.environments,
    ].map((environment) => ({
      key: environment,
      name: environment === "schema" ? "Schema default" : environment,
      sortable: true,
      minWidth: 220,
      resizable: true,
      cellClass: (row: GridRow) => {
        const variable = row.cells[environment];
        return `environment-value-cell ${environment === "schema" ? "" : !variable.valid ? "invalid-cell" : variable.state === "explicit" ? "explicit-cell" : ""}`;
      },
      editable: (row: GridRow) => editable(row, environment),
      editorOptions: {
        commitOnOutsideClick: false,
        closeOnExternalRowChange: false,
      },
      renderHeaderCell: ({ sortDirection }: RenderHeaderCellProps<GridRow>) => {
        const vault = matrix.vaults?.[environment];
        const id = vault?.id ?? matrix.config.environments[environment]?.vault;
        const description =
          environment === "schema"
            ? "Base layer"
            : matrix.mode === "vault"
              ? "Independent environment"
              : matrix.config.environments[environment].extends
                ? `Inherits ${matrix.config.environments[environment].extends}`
                : "Inherits schema default";
        return (
          <div>
            <span className="column-label">{description}</span>
            <div className="environment-heading">
              <strong
                title={
                  environment === "schema"
                    ? "Defaults declared in .env.schema"
                    : `${vault?.name ?? "Vault name unavailable"} (${id})`
                }
              >
                {environment === "schema"
                  ? "Schema default"
                  : matrix.mode === "vault"
                    ? (vault?.name ?? "Vault")
                    : environment}
              </strong>
              {sortDirection ? (
                <span aria-hidden="true">
                  {sortDirection === "ASC" ? "↑" : "↓"}
                </span>
              ) : null}
              {environment !== "schema" ? (
                <Tooltip disableHoverableContent>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="vault-info"
                      aria-label={`Vault info for ${environment}`}
                      title={`${vault?.name ?? "Vault name unavailable"} (${id})`}
                    >
                      <Info aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="vault-tooltip">
                    <strong>{vault?.name ?? "Vault name unavailable"}</strong>
                    <span>1Password vault</span>
                    <code>{id}</code>
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
        );
      },
      renderCell: ({
        row,
        rowIdx,
        column,
      }: {
        row: GridRow;
        rowIdx: number;
        column: { idx: number };
      }) => field(row, environment, rowIdx, column.idx),
      renderEditCell: (editor: RenderEditCellProps<GridRow>) => (
        <GridEditor
          {...editor}
          initiallyExpanded={
            expandedEditor.current ===
            JSON.stringify([editor.row.name, environment])
          }
          environment={environment}
          matrix={matrix}
          allVisible={allVisible}
          hideEpoch={hideEpoch}
          onSave={onSave}
          onReveal={onReveal}
          draftValue={
            operation(editor.row.name, environment)?.status === "error" &&
            typeof operation(editor.row.name, environment)?.payload.value ===
              "string"
              ? (operation(editor.row.name, environment)!.payload
                  .value as string)
              : undefined
          }
          registerCommit={registerCommit}
          onNavigate={navigate}
        />
      ),
    })),
  ];
  const restoreSearchCell = useEffectEvent(() => {
    const position = searchBookmark.current?.position;
    if (!position) return;
    const found = rows.findIndex((row) => row.name === position.name);
    const rowIdx =
      position.rowIdx < 0
        ? -1
        : found >= 0
          ? found
          : Math.min(position.rowIdx, rows.length - 1);
    const idx = columns.findIndex(
      (column) => column.key === position.columnKey,
    );
    if (rowIdx >= -1)
      focusGridCell(grid.current, {
        rowIdx,
        idx: idx >= 0 ? idx : position.idx,
      });
  });
  useSearchShortcuts(
    "search",
    () => {
      if (rows.length) focusGridCell(grid.current, { rowIdx: 0, idx: 2 });
    },
    () => {
      searchBookmark.current = {
        query: search,
        position: activePosition.current,
      };
      activeEdit.current?.commit();
    },
    () => {
      if (!searchBookmark.current?.position) return false;
      onSearchChange(searchBookmark.current.query);
      requestAnimationFrame(() => restoreSearchCell());
    },
  );
  const rowHeight = 72;
  const height = Math.min(620, 56 + rows.length * rowHeight);
  return (
    <DataGrid
      ref={grid}
      className="environment-grid rdg-light"
      aria-label="Environment values"
      columns={columns}
      rows={rows}
      sortColumns={sortColumns}
      onSortColumnsChange={(next) => {
        activeEdit.current?.commit();
        grid.current?.setActivePosition({ rowIdx: -1, idx: 0 });
        setSortColumns(next);
      }}
      rowKeyGetter={(row) => row.name}
      selectedRows={selectedRows}
      onSelectedRowsChange={onSelectedRowsChange}
      isRowSelectionDisabled={(row) => busy || deleting.has(row.name)}
      headerRowHeight={56}
      rowHeight={rowHeight}
      style={{ height: Math.max(184, height) }}
      onCellMouseDown={(args) => {
        expandedEditor.current = undefined;
        const current = activeEdit.current;
        if (
          current &&
          (current.rowIdx !== args.rowIdx || current.idx !== args.column.idx)
        )
          current.commit();
      }}
      onActivePositionChange={({ row, rowIdx, column }) => {
        activePosition.current = {
          name: row?.name,
          rowIdx,
          idx: column?.idx ?? 0,
          columnKey: column?.key ?? "",
        };
      }}
      onCellKeyDown={(args, event) => {
        if (args.mode === "EDIT") {
          event.preventGridDefault();
          if (event.key === "Escape") {
            event.preventDefault();
            args.onClose(false);
          }
          return;
        }
        if (
          (event.key === "Enter" || event.key === "F2") &&
          args.row &&
          args.column &&
          args.column.key !== "variable" &&
          args.column.key !== SelectColumn.key
        ) {
          event.preventDefault();
          event.preventGridDefault();
          expandedEditor.current =
            event.key === "Enter" &&
            event.shiftKey &&
            (event.metaKey || event.ctrlKey)
              ? JSON.stringify([args.row.name, args.column.key])
              : undefined;
          if (editable(args.row, args.column.key))
            args.setActivePosition(
              { rowIdx: args.rowIdx, idx: args.column.idx },
              { enableEditor: true },
            );
        }
      }}
      renderers={{
        noRowsFallback: (
          <div className="empty">
            <h2>No matching variables</h2>
            <p>Try another search or filter.</p>
          </div>
        ),
      }}
    />
  );
}
