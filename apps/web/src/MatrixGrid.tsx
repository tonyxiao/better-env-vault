import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  DataGrid,
  type Column,
  type DataGridHandle,
  type RenderEditCellProps,
} from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { Info, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { InlineEditor, originLabel } from "./MatrixCell.js";
import {
  fieldKey,
  type Cell,
  type Matrix,
  type SaveOperation,
} from "./matrix-model.js";
import type { ResolvedVariable } from "../../../packages/core/src/resolver.js";

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
  operations: Record<string, SaveOperation>;
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
  setExpanded,
  onNavigate,
  draftValue,
}: RenderEditCellProps<GridRow> & {
  draftValue?: string;
  environment: string;
  matrix: Matrix;
  allVisible: boolean;
  hideEpoch: number;
  onSave: Props["onSave"];
  onReveal: Props["onReveal"];
  setExpanded: Dispatch<SetStateAction<string | undefined>>;
  onNavigate: (rowIdx: number, idx: number, backward: boolean) => void;
}) {
  useEffect(() => {
    setExpanded(row.name);
    return () => setExpanded(undefined);
  }, [row.name, setExpanded]);
  const variable =
    environment === "schema" ? row.definition : row.cells[environment];
  // Capture the optimistic-concurrency versions when editing begins. Background
  // refreshes must not turn an old draft into an unchecked overwrite.
  const versions = useRef(matrix.versions[row.name]).current;
  const fingerprint = useRef(matrix.fingerprint).current;
  const initialValue =
    environment === "schema"
      ? { value: variable.defaultValue }
      : allVisible
        ? {
            value:
              matrix.editableValues?.[environment]?.[row.name] ??
              variable.value,
          }
        : variable.state === "missing" ||
            (!variable.sensitive && variable.state === "default")
          ? { value: variable.value }
          : undefined;
  function submit(payload: Record<string, unknown>) {
    const result = onSave({ fingerprint, ...payload });
    onClose(false);
    return result;
  }
  return (
    <InlineEditor
      variable={variable}
      environment={environment}
      busy={false}
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
      onRemove={
        environment === "schema"
          ? undefined
          : () =>
              submit({
                action: "remove",
                name: row.name,
                environment,
                versions,
              })
      }
      onCancel={() => onClose(false)}
      onNavigate={(backward) => {
        onClose(false, false);
        onNavigate(rowIdx, column.idx, backward);
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
    operations,
    onSave,
    onReveal,
    onDetails,
  } = props;
  const grid = useRef<DataGridHandle>(null);
  const [expanded, setExpanded] = useState<string>();
  const [freezeVariables, setFreezeVariables] = useState(
    () => window.matchMedia("(min-width: 640px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 640px)");
    const change = () => setFreezeVariables(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const errorRows = useMemo(
    () =>
      new Set(
        Object.values(operations)
          .filter(
            (operation) =>
              operation.project === project && operation.status === "error",
          )
          .map((operation) => operation.name),
      ),
    [operations, project],
  );
  const rows = useMemo(() => {
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
  useEffect(() => {
    grid.current?.setActivePosition({ rowIdx: -1, idx: 0 });
    setExpanded(undefined);
  }, [resetEpoch]);
  function operation(name: string, environment: string) {
    return operations[fieldKey(project, name, environment)];
  }
  function editable(row: GridRow, environment: string) {
    return (
      !busy &&
      operation(row.name, environment)?.status !== "saving" &&
      operation(row.name, "definition")?.status !== "saving" &&
      (environment !== "schema" ||
        (!row.definition.sensitive && row.definition.editable))
    );
  }
  function navigate(rowIdx: number, idx: number, backward: boolean) {
    const keys = ["variable", "schema", ...matrix.environments];
    let nextRow = rowIdx,
      nextIdx = idx;
    for (let step = 0; step < rows.length * keys.length; step++) {
      nextIdx += backward ? -1 : 1;
      if (nextIdx >= keys.length) {
        nextIdx = 1;
        nextRow++;
      }
      if (nextIdx < 1) {
        nextIdx = keys.length - 1;
        nextRow--;
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
          <span className="origin">
            {environment === "schema"
              ? "Schema default"
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
            disabled={busy}
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
          <div className="field-error" role="alert">
            <span>{active.error}</span>
            <Button
              size="xs"
              variant="outline"
              aria-label={`Retry saving ${row.name} in ${environment}`}
              onClick={() => void onSave(active.payload)}
            >
              <RotateCcw aria-hidden="true" /> Retry
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  const columns: Column<GridRow>[] = [
    {
      key: "variable",
      name: "Variable",
      width: freezeVariables ? 260 : 180,
      minWidth: 180,
      frozen: freezeVariables,
      resizable: true,
      renderHeaderCell: () => (
        <span>
          Variable <span className="variable-count">{variables.length}</span>
        </span>
      ),
      renderCell: ({ row }) => (
        <div className="variable-cell">
          <code>{row.name}</code>
          <p>{row.definition.description || "No description"}</p>
          <div className="badges">
            <span>{row.definition.type}</span>
            {row.definition.required ? <span>required</span> : null}
            <span>{row.definition.sensitive ? "sensitive" : "public"}</span>
          </div>
        </div>
      ),
    },
    ...["schema", ...matrix.environments].map((environment) => ({
      key: environment,
      name: environment === "schema" ? "Schema default" : environment,
      minWidth: 220,
      resizable: true,
      editable: (row: GridRow) => editable(row, environment),
      editorOptions: {
        commitOnOutsideClick: false,
        closeOnExternalRowChange: false,
      },
      renderHeaderCell: () => (
        <div>
          <span className="column-label">
            {environment === "schema"
              ? "Base layer"
              : matrix.config.environments[environment].extends
                ? `Inherits ${matrix.config.environments[environment].extends}`
                : "Inherits schema default"}
          </span>
          <strong>
            {environment === "schema" ? "Schema default" : environment}
          </strong>
          {environment !== "schema" ? <span className="env-dot" /> : null}
        </div>
      ),
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
          environment={environment}
          matrix={displayMatrix}
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
          setExpanded={setExpanded}
          onNavigate={navigate}
        />
      ),
    })),
  ];
  function rowHeight(row: GridRow) {
    if (expanded === row.name) return 290;
    return errorRows.has(row.name) ? 180 : 112;
  }
  const height = Math.min(
    620,
    72 + rows.reduce((total, row) => total + rowHeight(row), 0),
  );
  return (
    <DataGrid
      ref={grid}
      className="environment-grid rdg-light"
      aria-label="Environment values"
      columns={columns}
      rows={rows}
      rowKeyGetter={(row) => row.name}
      headerRowHeight={72}
      rowHeight={rowHeight}
      style={{ height: Math.max(184, height) }}
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
          args.column.key !== "variable"
        ) {
          event.preventDefault();
          event.preventGridDefault();
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
