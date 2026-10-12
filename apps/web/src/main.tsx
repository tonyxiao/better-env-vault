import { setNonce } from "get-nonce";
import {
  NativeSelect,
  NativeSelectOption,
} from "./components/ui/native-select.js";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./components/ui/tooltip.js";
import { LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ResolvedVariable } from "../../../packages/core/src/resolver.js";
import "./style.css";
import { EyeIcon } from "./MatrixCell.js";
import { MatrixGrid } from "./MatrixGrid.js";
import { Dialog, Editor, ProjectDialog } from "./edit-dialogs.js";
import { VaultWorkspace } from "./VaultWorkspace.js";
import {
  fieldKey,
  operationField,
  type Cell,
  type Matrix,
  type SaveOperation,
} from "./matrix-model.js";

interface Project {
  id: string;
  name: string;
  schemaPath?: string;
  mode?: "schema" | "vault";
  vaultId?: string;
  account?: string;
}
function maskedMatrix(matrix: Matrix): Matrix {
  const { editableValues: _editableValues, ...metadata } = matrix;
  return {
    ...metadata,
    resolutions: matrix.resolutions.map((resolution) => ({
      ...resolution,
      variables: resolution.variables.map(
        ({ value, defaultValue, ...variable }) => ({
          ...variable,
          ...(!variable.sensitive ? { value, defaultValue } : {}),
        }),
      ),
    })),
  };
}
class ApiError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(data.error ?? "Request failed.", data.code);
  return data;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [vaultMode, setVaultMode] = useState(false);
  const [project, setProject] = useState("");
  const [matrix, setMatrix] = useState<Matrix>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsConnection, setNeedsConnection] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [cell, setCell] = useState<Cell>();
  const [modal, setModal] = useState<"add" | "settings" | "delete">();
  const [addName, setAddName] = useState("");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [deletions, setDeletions] = useState<
    Record<string, ReadonlySet<string>>
  >({});
  const pendingDeletes = useRef(new Set<string>());
  const [gridResetEpoch, setGridResetEpoch] = useState(0);
  const [operations, setOperations] = useState<Record<string, SaveOperation>>(
    {},
  );
  const pending = useRef(new Set<string>());
  const projectRef = useRef(project);
  projectRef.current = project;
  const [revealedMatrix, setRevealedMatrix] = useState<Matrix>();
  const [allVisible, setAllVisible] = useState(false);
  const [revealingAll, setRevealingAll] = useState(false);
  const [hideEpoch, setHideEpoch] = useState(0);
  const visibleIntent = useRef(false);
  const visibilityGeneration = useRef(0);
  const matrixRef = useRef<Matrix | undefined>(undefined);
  const token = useRef("");
  const loadId = useRef(0);
  const disconnect = useCallback(() => {
    setNeedsConnection(true);
    setProjects([]);
    setProject("");
    setMatrix(undefined);
    setCell(undefined);
    setModal(undefined);
    setError("");
    setNotice("");
    setOperations({});
    setSelectedRows(new Set());
    setGridResetEpoch((epoch) => epoch + 1);
    setRevealedMatrix(undefined);
    setAllVisible(false);
    setRevealingAll(false);
    visibleIntent.current = false;
    ++visibilityGeneration.current;
    matrixRef.current = undefined;
    token.current = "";
    ++loadId.current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fragment = new URLSearchParams(location.hash.slice(1));
    const launchToken = fragment.get("session");
    // Clear the launch credential immediately, before any request or rendering.
    if (launchToken) history.replaceState(null, "", location.pathname);
    void (async () => {
      try {
        if (launchToken) {
          try {
            await request("/api/session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: launchToken }),
            });
          } catch (error) {
            if (!(error instanceof ApiError && error.code === "session"))
              throw error;
          }
        }
        const response = await request<{
          projects: Project[];
          mutationToken: string;
          mode?: "schema" | "vault";
        }>("/api/projects");
        if (cancelled) return;
        token.current = response.mutationToken;
        setVaultMode(response.mode === "vault");
        setProjects(response.projects);
        setProject(
          response.mode === "vault" ? "" : (response.projects[0]?.id ?? ""),
        );
      } catch (error) {
        if (!cancelled) {
          if (error instanceof ApiError && error.code === "session")
            disconnect();
          else setError((error as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [disconnect]);

  const refresh = useCallback(
    async (fresh = false, quiet = false) => {
      if (!project) return;
      const id = ++loadId.current;
      if (!quiet) setBusy(true);
      setError("");
      const generation = visibilityGeneration.current;
      try {
        let response: Matrix;
        if (visibleIntent.current && matrixRef.current) {
          try {
            response = await request<Matrix>(
              `/api/reveal-all?project=${encodeURIComponent(project)}${fresh ? "&fresh=1" : ""}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Bev-Mutation": token.current,
                },
                body: JSON.stringify({
                  fingerprint: matrixRef.current.fingerprint,
                }),
              },
            );
          } catch (error) {
            if (!(error instanceof ApiError && error.code === "conflict"))
              throw error;
            visibleIntent.current = false;
            setAllVisible(false);
            setRevealedMatrix(undefined);
            setHideEpoch((epoch) => epoch + 1);
            response = await request<Matrix>(
              `/api/matrix?project=${encodeURIComponent(project)}${fresh ? "&fresh=1" : ""}`,
            );
          }
        } else
          response = await request<Matrix>(
            `/api/matrix?project=${encodeURIComponent(project)}${fresh ? "&fresh=1" : ""}`,
          );
        if (loadId.current === id) {
          const masked = maskedMatrix(response);
          matrixRef.current = masked;
          setMatrix(masked);
          if (
            visibleIntent.current &&
            visibilityGeneration.current === generation
          ) {
            setRevealedMatrix(response);
            setAllVisible(true);
          }
        }
      } catch (error) {
        if (loadId.current === id) {
          visibleIntent.current = false;
          setAllVisible(false);
          setRevealedMatrix(undefined);
          setHideEpoch((epoch) => epoch + 1);
          if (error instanceof ApiError && error.code === "session")
            disconnect();
          else setError((error as Error).message);
        }
      } finally {
        if (!quiet && loadId.current === id) setBusy(false);
      }
    },
    [project, disconnect],
  );
  useEffect(() => {
    setMatrix(undefined);
    setCell(undefined);
    setModal(undefined);
    setSelectedRows(new Set());
    setFilter("all");
    setGridResetEpoch((epoch) => epoch + 1);
    setRevealedMatrix(undefined);
    setAllVisible(false);
    setRevealingAll(false);
    visibleIntent.current = false;
    ++visibilityGeneration.current;
    matrixRef.current = undefined;
    void refresh();
    return () => {
      ++loadId.current;
    };
  }, [refresh]);

  async function mutate(payload: Record<string, unknown>): Promise<boolean> {
    const current = matrixRef.current;
    if (!current) return false;
    const targetProject = project;
    const { name, environment } = operationField(payload);
    const key = fieldKey(targetProject, name, environment);
    if (pending.current.has(key)) return false;
    pending.current.add(key);
    const operation: SaveOperation = {
      project: targetProject,
      name,
      environment,
      status: "saving",
      payload,
    };
    setOperations((previous) => ({ ...previous, [key]: operation }));
    setCell(undefined);
    setModal(undefined);
    setError("");
    setNotice("");
    try {
      await request(`/api/edit?project=${encodeURIComponent(targetProject)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bev-Mutation": token.current,
        },
        body: JSON.stringify({ fingerprint: current.fingerprint, ...payload }),
      });
      if (projectRef.current === targetProject) {
        await refresh(false, true);
        if (projectRef.current === targetProject)
          setNotice(
            vaultMode
              ? "Saved to this 1Password vault."
              : "Saved. Values are available on the next environment load.",
          );
      }
      setOperations((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "session") {
        disconnect();
        return false;
      }
      const message =
        error instanceof Error ? error.message : "The value was not saved.";
      setOperations((previous) => ({
        ...previous,
        [key]: { ...operation, status: "error", error: message },
      }));
      if (
        projectRef.current === targetProject &&
        !["set", "remove", "default"].includes(String(payload.action))
      )
        setError(message);
      return false;
    } finally {
      pending.current.delete(key);
    }
  }
  useEffect(() => {
    if (!matrix) return;
    const declared = new Set(
      matrix.resolutions[0]?.variables.map((variable) => variable.name),
    );
    setSelectedRows((previous) => {
      const next = new Set([...previous].filter((name) => declared.has(name)));
      return next.size === previous.size ? previous : next;
    });
  }, [matrix]);

  async function deleteVariables(payload: {
    names: string[];
    fingerprint: string;
    confirmation: string;
    versions: Record<string, Record<string, number | null>>;
  }) {
    const target = project;
    if (pendingDeletes.current.has(target)) return;
    pendingDeletes.current.add(target);
    setDeletions((previous) => ({
      ...previous,
      [target]: new Set(payload.names),
    }));
    setModal(undefined);
    setNotice("");
    setError("");
    try {
      await request(`/api/delete-many?project=${encodeURIComponent(target)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bev-Mutation": token.current,
        },
        body: JSON.stringify(payload),
      });
      if (projectRef.current === target) {
        setSelectedRows(new Set());
        await refresh(false, true);
        if (projectRef.current === target)
          setNotice(
            `Deleted ${payload.names.length} variable${payload.names.length === 1 ? "" : "s"} ${vaultMode ? "from this vault" : "from the schema and configured vaults"}.`,
          );
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "session") disconnect();
      else if (projectRef.current === target)
        setError((error as Error).message);
    } finally {
      pendingDeletes.current.delete(target);
      setDeletions((previous) => {
        const next = { ...previous };
        delete next[target];
        return next;
      });
    }
  }
  async function reveal(environment: string, name: string) {
    try {
      return await request<{
        value?: string;
        explicitValue?: string;
        editableValue?: string;
        notes: string;
      }>(`/api/reveal?project=${encodeURIComponent(project)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bev-Mutation": token.current,
        },
        body: JSON.stringify({
          environment,
          name,
          fingerprint: matrix?.fingerprint,
        }),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "session") disconnect();
      throw error;
    }
  }
  async function toggleAll() {
    if (visibleIntent.current) {
      visibleIntent.current = false;
      ++visibilityGeneration.current;
      setRevealedMatrix(undefined);
      setAllVisible(false);
      setRevealingAll(false);
      setHideEpoch((epoch) => epoch + 1);
      return;
    }
    if (!matrix) return;
    visibleIntent.current = true;
    const generation = ++visibilityGeneration.current;
    const id = ++loadId.current;
    setRevealingAll(true);
    setError("");
    try {
      const response = await request<Matrix>(
        `/api/reveal-all?project=${encodeURIComponent(project)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Bev-Mutation": token.current,
          },
          body: JSON.stringify({ fingerprint: matrix.fingerprint }),
        },
      );
      if (generation !== visibilityGeneration.current || id !== loadId.current)
        return;
      const masked = maskedMatrix(response);
      matrixRef.current = masked;
      setMatrix(masked);
      setRevealedMatrix(response);
      setAllVisible(true);
    } catch (error) {
      if (generation !== visibilityGeneration.current) return;
      visibleIntent.current = false;
      setRevealedMatrix(undefined);
      setAllVisible(false);
      if (error instanceof ApiError && error.code === "session") disconnect();
      else setError((error as Error).message);
    } finally {
      if (generation === visibilityGeneration.current) setRevealingAll(false);
    }
  }
  const displayMatrix = allVisible && revealedMatrix ? revealedMatrix : matrix;

  const rows = displayMatrix?.resolutions[0]?.variables ?? [];
  const visible = useMemo(() => {
    const lookups =
      filter === "all"
        ? []
        : (matrix?.resolutions.map(
            (resolution) =>
              new Map(
                resolution.variables.map((variable) => [
                  variable.name,
                  variable,
                ]),
              ),
          ) ?? []);
    return rows.filter((row) => {
      if (
        !`${row.name} ${row.description}`
          .toLowerCase()
          .includes(search.toLowerCase())
      )
        return false;
      if (filter === "all") return true;
      const cells = lookups.map((lookup) => lookup.get(row.name)!);
      return (
        (filter === "missing" &&
          cells.some((variable) => variable.state === "missing")) ||
        (filter === "invalid" && cells.some((variable) => !variable.valid)) ||
        (filter === "overrides" &&
          cells.some((variable) => variable.state === "explicit"))
      );
    });
  }, [rows, matrix, search, filter]);
  const unmanaged = matrix
    ? [
        ...new Map(
          matrix.resolutions
            .flatMap((r) => r.unmanaged)
            .map((i) => [`${i.environment}:${i.id}`, i]),
        ).values(),
      ]
    : [];
  const close = () => {
    setCell(undefined);
    setModal(undefined);
  };
  if (needsConnection)
    return (
      <div className="app">
        <header>
          <a className="brand" href="/">
            <span className="mark">E</span>Better Env Vault
          </a>
        </header>
        <main>
          <section className="connection-panel">
            <p className="eyebrow">BROWSER CONNECTION</p>
            <h1>Connect this browser</h1>
            <p>
              This browser needs its own one-time launch link before it can
              access your environments.
            </p>
            <p>
              In the terminal running the app, type <code>link</code> and open
              the fresh link in this browser. You can also type{" "}
              <code>open</code> to open your default browser.
            </p>
            <p>Opening the plain address does not connect a new browser.</p>
            <Button variant="outline" onClick={() => location.reload()}>
              Retry connection
            </Button>
          </section>
        </main>
      </div>
    );
  if (vaultMode)
    return (
      <VaultWorkspace mutationToken={token.current} onDisconnect={disconnect} />
    );
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
            <p className="eyebrow">
              {vaultMode ? "1PASSWORD VAULTS" : "ENVIRONMENT WORKSPACE"}
            </p>
            <h1>
              {vaultMode
                ? "Your vaults, clearly."
                : "Your configuration, clearly."}
            </h1>
            <p className="subheading">
              {vaultMode
                ? "Browse and edit secrets in each independent vault."
                : "See every override. Know where each value comes from."}
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setCell(undefined);
              setGridResetEpoch((epoch) => epoch + 1);
              if (!vaultMode && matrix) void refresh(true);
              else
                void (async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const response = await request<{
                      projects: Project[];
                      mutationToken: string;
                      mode?: string;
                    }>("/api/projects");
                    token.current = response.mutationToken;
                    setVaultMode(response.mode === "vault");
                    setProjects(response.projects);
                    if (response.projects.some((p) => p.id === project))
                      await refresh(true);
                    else setProject(response.projects[0]?.id ?? "");
                  } catch (error) {
                    if (error instanceof ApiError && error.code === "session")
                      disconnect();
                    else setError((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                })();
            }}
          >
            <RefreshCw aria-hidden="true" /> Refresh
          </Button>
        </div>
        {error ? (
          <div role="alert" className="alert error">
            {error}
          </div>
        ) : null}
        <section className="workspace-bar" aria-label="Project">
          <div className="schema-identity">
            {projects.length > 1 ? (
              <>
                <label htmlFor="project">
                  {vaultMode ? "Vault" : "Schema"}
                </label>
                <NativeSelect
                  id="project"
                  aria-label={vaultMode ? "Vault" : "Schema"}
                  disabled={busy}
                  value={project}
                  onChange={(event) => {
                    close();
                    setNotice("");
                    setProject(event.target.value);
                  }}
                >
                  {projects.map((schema) => (
                    <NativeSelectOption value={schema.id} key={schema.id}>
                      {schema.name}
                      {vaultMode && schema.account
                        ? ` (${schema.account})`
                        : ""}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </>
            ) : (
              <>
                <span>{vaultMode ? "Vault" : "Schema"}</span>
                <strong>
                  {matrix?.config.name ??
                    projects.find((schema) => schema.id === project)?.name ??
                    (vaultMode ? "No accessible vaults" : ".env.schema")}
                </strong>
              </>
            )}
          </div>
          <div className="schema-path">
            <span>{vaultMode ? "Vault ID" : "Schema file"}</span>
            <code>
              {vaultMode
                ? (projects.find((p) => p.id === project)?.vaultId ?? "—")
                : (matrix?.schemaPath ??
                  projects.find((p) => p.id === project)?.schemaPath ??
                  ".env.schema")}
            </code>
          </div>
          {!vaultMode ? (
            <Button
              variant="outline"
              disabled={!matrix || busy}
              onClick={() => setModal("settings")}
            >
              Schema settings
            </Button>
          ) : null}
        </section>
        {vaultMode && !projects.length && !error ? (
          <p role="status">
            No accessible vaults. Check your 1Password account or
            service-account permissions, then refresh.
          </p>
        ) : null}
        {vaultMode && matrix && rows.length === 0 ? (
          <p role="status">
            This vault has no API Credential variables yet. Add a variable to
            get started.
          </p>
        ) : null}
        <div className="toolbar">
          <div className="search">
            <label className="sr-only" htmlFor="search">
              Search variables
            </label>
            <Input
              id="search"
              placeholder={
                vaultMode
                  ? "Search variables…"
                  : "Search variables or descriptions…"
              }
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setGridResetEpoch((epoch) => epoch + 1);
              }}
            />
          </div>
          {!vaultMode ? (
            <label className="filter">
              Show{" "}
              <NativeSelect
                aria-label="Filter variables"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setGridResetEpoch((epoch) => epoch + 1);
                }}
              >
                <NativeSelectOption value="all">
                  All variables
                </NativeSelectOption>
                <NativeSelectOption value="missing">
                  Missing values
                </NativeSelectOption>
                <NativeSelectOption value="invalid">
                  Invalid values
                </NativeSelectOption>
                <NativeSelectOption value="overrides">
                  Overrides
                </NativeSelectOption>
              </NativeSelect>
            </label>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="visibility-toggle"
                aria-label={
                  allVisible || revealingAll
                    ? "Hide all values"
                    : "Reveal all values"
                }
                title={
                  allVisible || revealingAll
                    ? "Hide all values"
                    : "Reveal all values"
                }
                aria-pressed={allVisible || revealingAll}
                aria-busy={revealingAll}
                disabled={busy || !matrix}
                onClick={() => void toggleAll()}
              >
                <EyeIcon hidden={allVisible || revealingAll} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {allVisible || revealingAll
                ? "Hide all values"
                : "Reveal all values"}
            </TooltipContent>
          </Tooltip>
          <Button
            disabled={busy || !matrix}
            onClick={() => {
              setAddName("");
              setModal("add");
            }}
          >
            <Plus aria-hidden="true" /> Add variable
          </Button>
        </div>
        {Object.values(operations)
          .filter(
            (operation) =>
              operation.project === project &&
              ["add", "definition"].includes(operation.environment),
          )
          .map((operation) => (
            <div
              key={fieldKey(project, operation.name, operation.environment)}
              className="operation-notice"
              role={operation.status === "error" ? "alert" : "status"}
            >
              {operation.status === "saving" ? (
                <>
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />{" "}
                  Saving {operation.name}…
                </>
              ) : (
                <>
                  <span>{operation.error}</span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void mutate(operation.payload)}
                  >
                    Retry save
                  </Button>
                </>
              )}
            </div>
          ))}
        {busy ? (
          <p role="status" className="loading">
            Connecting to 1Password…
          </p>
        ) : null}
        {matrix ? (
          <section className="matrix-panel" aria-label="Environment matrix">
            <MatrixGrid
              key={project}
              project={project}
              matrix={matrix}
              displayMatrix={displayMatrix!}
              variables={visible}
              allVisible={allVisible}
              busy={busy}
              hideEpoch={hideEpoch}
              resetEpoch={gridResetEpoch}
              operations={operations}
              selectedRows={selectedRows}
              onSelectedRowsChange={setSelectedRows}
              deleting={deletions[project] ?? new Set<string>()}
              onSave={mutate}
              onReveal={reveal}
              onDetails={setCell}
            />
            <footer className="matrix-footer">
              {selectedRows.size ? (
                <div
                  className="selection-action-bar"
                  role="toolbar"
                  aria-label="Selected variables actions"
                >
                  <strong>{selectedRows.size} selected</strong>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedRows(new Set())}
                  >
                    Clear selection
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={
                      busy ||
                      !!deletions[project] ||
                      selectedRows.size > 200 ||
                      Object.values(operations).some(
                        (operation) =>
                          operation.project === project &&
                          operation.status === "saving",
                      )
                    }
                    title={
                      selectedRows.size > 200
                        ? "Select up to 200 variables per batch"
                        : vaultMode
                          ? "Delete selected secrets from this vault"
                          : "Delete selected definitions and their items from every configured vault"
                    }
                    onClick={() => setModal("delete")}
                  >
                    <Trash2 aria-hidden="true" />
                    Delete selected
                  </Button>
                </div>
              ) : (
                <>
                  <span>
                    <i className="legend-dot" />
                    {vaultMode ? "Stored in vault" : "Explicit override"}
                  </span>
                  {!vaultMode ? (
                    <span>
                      <i className="legend-dot inherited" />
                      Inherited value
                    </span>
                  ) : null}
                  <span>
                    {allVisible
                      ? "All matrix values are visible."
                      : revealingAll
                        ? "Revealing all values…"
                        : "Sensitive values stay masked until revealed."}
                  </span>
                </>
              )}
            </footer>
          </section>
        ) : null}
        {unmanaged.length ? (
          <section className="unmanaged">
            <h2>
              Unmanaged vault items <span>{unmanaged.length}</span>
            </h2>
            <p>
              These variables exist in 1Password but are not declared in this
              schema.
            </p>
            {unmanaged.map((item) => (
              <div key={`${item.environment}:${item.id}`}>
                <code>{item.name}</code>
                <span>{item.environment}</span>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setAddName(item.name);
                    setModal("add");
                  }}
                >
                  Adopt into schema
                </Button>
              </div>
            ))}
          </section>
        ) : null}
        <div className="save-status" role="status" aria-live="polite">
          {notice}
        </div>
        <p className="footnote">
          Enter saves down · Tab saves across · Escape cancels · Alt+Enter adds
          a newline.
          <br />
          {vaultMode
            ? "Saves update only the selected 1Password vault."
            : "Saves update the matrix automatically. Reload direnv or restart your application to use new values."}
        </p>
      </main>
      {cell && matrix ? (
        <Editor
          key={`${project}:${cell.environment}:${cell.variable.name}`}
          cell={cell}
          matrix={matrix}
          busy={busy}
          saveError={error}
          onClose={close}
          onSave={mutate}
          onReveal={reveal}
          onSource={(env) => {
            const variable = matrix.resolutions
              .find((r) => r.environment === env)
              ?.variables.find((v) => v.name === cell.variable.name);
            if (variable) setCell({ environment: env, variable });
          }}
        />
      ) : null}
      {modal && modal !== "delete" && matrix ? (
        <ProjectDialog
          key={`${modal}:${addName}`}
          mode={modal}
          matrix={matrix}
          initialName={addName}
          busy={busy}
          saveError={error}
          onClose={close}
          onSave={mutate}
        />
      ) : null}
      {modal === "delete" && matrix ? (
        <DeleteVariablesDialog
          key={project}
          names={[...selectedRows].sort()}
          matrix={matrix}
          onClose={close}
          onDelete={deleteVariables}
        />
      ) : null}
    </div>
  );
}

function DeleteVariablesDialog({
  names,
  matrix,
  onClose,
  onDelete,
}: {
  names: string[];
  matrix: Matrix;
  onClose: () => void;
  onDelete: (payload: {
    names: string[];
    fingerprint: string;
    confirmation: string;
    versions: Record<string, Record<string, number | null>>;
  }) => Promise<void>;
}) {
  const batch = useRef({
    names,
    fingerprint: matrix.fingerprint,
    versions: Object.fromEntries(
      names.map((name) => [name, matrix.versions[name]]),
    ),
  }).current;
  const [confirmation, setConfirmation] = useState("");
  return (
    <Dialog
      title={`Delete ${batch.names.length} variable${batch.names.length === 1 ? "" : "s"}`}
      onClose={onClose}
    >
      <p className="dialog-intro">
        {matrix.mode === "vault"
          ? `This removes the selected secrets from ${matrix.config.name}. Other vaults are unaffected.`
          : "This removes the selected definitions from .env.schema and their items from every configured 1Password vault, including overrides."}
      </p>
      <ul className="delete-variable-list">
        {batch.names.map((name) => (
          <li key={name}>
            <code>{name}</code>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmation === "DELETE")
            void onDelete({ ...batch, confirmation });
        }}
      >
        <label>
          Type DELETE to confirm
          <Input
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={confirmation !== "DELETE"}
          >
            Delete variables
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const styleNonce = document.querySelector<HTMLMetaElement>(
  'meta[name="bev-style-nonce"]',
)?.content;
if (styleNonce) setNonce(styleNonce);

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <App />
  </TooltipProvider>,
);
