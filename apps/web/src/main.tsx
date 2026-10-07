import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import type { ProjectConfig } from "../../../packages/core/src/schema.js";
import type {
  Resolution,
  ResolvedVariable,
} from "../../../packages/core/src/resolver.js";
import "./style.css";
import { EyeIcon, InlineEditor, originLabel } from "./MatrixCell.js";

interface Project {
  id: string;
  name: string;
  schemaPath: string;
}
interface Matrix {
  fingerprint: string;
  config: ProjectConfig;
  schemaPath: string;
  environments: string[];
  resolutions: Resolution[];
  versions: Record<string, Record<string, number | null>>;
  editableValues?: Record<string, Record<string, string | undefined>>;
}
interface Cell {
  environment: string;
  variable: ResolvedVariable;
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
  const [project, setProject] = useState("");
  const [matrix, setMatrix] = useState<Matrix>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsConnection, setNeedsConnection] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [cell, setCell] = useState<Cell>();
  const [modal, setModal] = useState<"add" | "settings">();
  const [addName, setAddName] = useState("");
  const [inline, setInline] = useState<Cell>();
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
    setInline(undefined);
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
        }>("/api/projects");
        if (cancelled) return;
        token.current = response.mutationToken;
        setProjects(response.projects);
        setProject(response.projects[0]?.id ?? "");
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

  const refresh = useCallback(async () => {
    if (!project) return;
    const id = ++loadId.current;
    setBusy(true);
    setError("");
    const generation = visibilityGeneration.current;
    try {
      let response: Matrix;
      if (visibleIntent.current && matrixRef.current) {
        try {
          response = await request<Matrix>(
            `/api/reveal-all?project=${encodeURIComponent(project)}`,
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
            `/api/matrix?project=${encodeURIComponent(project)}`,
          );
        }
      } else
        response = await request<Matrix>(
          `/api/matrix?project=${encodeURIComponent(project)}`,
        );
      if (
        loadId.current === id &&
        visibilityGeneration.current === generation
      ) {
        const masked = maskedMatrix(response);
        matrixRef.current = masked;
        setMatrix(masked);
        if (visibleIntent.current) {
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
        if (error instanceof ApiError && error.code === "session") disconnect();
        else setError((error as Error).message);
      }
    } finally {
      if (loadId.current === id) setBusy(false);
    }
  }, [project, disconnect]);
  useEffect(() => {
    setMatrix(undefined);
    setCell(undefined);
    setModal(undefined);
    setInline(undefined);
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
    if (!matrix) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`/api/edit?project=${encodeURIComponent(project)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bev-Mutation": token.current,
        },
        body: JSON.stringify({ fingerprint: matrix.fingerprint, ...payload }),
      });
      setCell(undefined);
      setModal(undefined);
      setInline(undefined);
      setNotice("Saved. Values are available on the next environment load.");
      await refresh();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "session") disconnect();
      else setError((error as Error).message);
      return false;
    } finally {
      setBusy(false);
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
  const visible = rows.filter((row) => {
    if (
      !`${row.name} ${row.description}`
        .toLowerCase()
        .includes(search.toLowerCase())
    )
      return false;
    const cells = matrix!.resolutions.map(
      (r) => r.variables.find((v) => v.name === row.name)!,
    );
    return (
      filter === "all" ||
      (filter === "missing" && cells.some((v) => v.state === "missing")) ||
      (filter === "invalid" && cells.some((v) => !v.valid)) ||
      (filter === "overrides" && cells.some((v) => v.state === "explicit"))
    );
  });
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
            <button className="secondary" onClick={() => location.reload()}>
              Retry connection
            </button>
          </section>
        </main>
      </div>
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
            <p className="eyebrow">ENVIRONMENT WORKSPACE</p>
            <h1>Your configuration, clearly.</h1>
            <p className="subheading">
              See every override. Know where each value comes from.
            </p>
          </div>
          <button
            className="secondary"
            disabled={busy || !matrix}
            onClick={() => {
              setCell(undefined);
              setInline(undefined);
              void refresh();
            }}
          >
            ↻ Refresh
          </button>
        </div>
        {error ? (
          <div role="alert" className="alert error">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div role="status" className="alert success">
            {notice}
          </div>
        ) : null}
        <section className="workspace-bar" aria-label="Project">
          <div>
            <label htmlFor="project">Project</label>
            <select
              id="project"
              disabled={busy}
              value={project}
              onChange={(e) => {
                close();
                setNotice("");
                setProject(e.target.value);
              }}
            >
              {projects.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="schema-path">
            <span>Source of truth</span>
            <code>
              {matrix?.schemaPath ??
                projects.find((p) => p.id === project)?.schemaPath ??
                ".env.schema"}
            </code>
          </div>
          <button
            className="secondary"
            disabled={!matrix || busy}
            onClick={() => setModal("settings")}
          >
            Project settings
          </button>
        </section>
        <div className="toolbar">
          <div className="search">
            <label className="sr-only" htmlFor="search">
              Search variables
            </label>
            <input
              id="search"
              placeholder="Search variables or descriptions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label className="filter">
            Show{" "}
            <select
              aria-label="Filter variables"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All variables</option>
              <option value="missing">Missing values</option>
              <option value="invalid">Invalid values</option>
              <option value="overrides">Overrides</option>
            </select>
          </label>
          <button
            type="button"
            className="secondary visibility-toggle"
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
          </button>
          <button
            disabled={busy || !matrix}
            onClick={() => {
              setAddName("");
              setModal("add");
            }}
          >
            + Add variable
          </button>
        </div>
        {busy ? (
          <p role="status" className="loading">
            Connecting to 1Password…
          </p>
        ) : null}
        {matrix ? (
          <section className="matrix-panel" aria-label="Environment matrix">
            <div className="matrix-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="variable-heading">
                      Variable <span>{rows.length}</span>
                    </th>
                    <th>
                      <span className="column-label">Base layer</span>Schema
                      default
                    </th>
                    {matrix.environments.map((env) => (
                      <th key={env}>
                        <span className="column-label">
                          {matrix.config.environments[env].extends
                            ? `Inherits ${matrix.config.environments[env].extends}`
                            : "Inherits schema default"}
                        </span>
                        {env}
                        <span className="env-dot" />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.name}>
                      <th scope="row">
                        <code>{row.name}</code>
                        <p>{row.description || "No description"}</p>
                        <div className="badges">
                          <span>{row.type}</span>
                          {row.required ? <span>required</span> : null}
                          <span>{row.sensitive ? "sensitive" : "public"}</span>
                        </div>
                      </th>
                      <td className="default-cell">
                        {inline?.environment === "schema" &&
                        inline.variable.name === row.name ? (
                          <InlineEditor
                            variable={inline.variable}
                            environment="schema"
                            busy={busy}
                            hideEpoch={hideEpoch}
                            initialValue={{ value: row.defaultValue }}
                            onLoad={() =>
                              Promise.resolve({
                                editableValue: row.defaultValue,
                              })
                            }
                            onSave={(value) =>
                              mutate({
                                action: "default",
                                name: row.name,
                                value,
                                versions: matrix.versions[row.name],
                              })
                            }
                            onCancel={() => setInline(undefined)}
                          />
                        ) : (
                          <>
                            <span>
                              {row.sensitive && !allVisible
                                ? row.hasDefault
                                  ? "••••••••"
                                  : "No default"
                                : row.defaultValue === undefined
                                  ? "No default"
                                  : row.defaultValue === ""
                                    ? "(empty)"
                                    : row.defaultValue}
                            </span>
                            {!row.sensitive ? (
                              <button
                                className="text-button"
                                aria-label={`Edit default for ${row.name}`}
                                disabled={busy || !row.editable}
                                title={
                                  !row.editable
                                    ? "Expression defaults are read-only"
                                    : undefined
                                }
                                onClick={() =>
                                  setInline({
                                    environment: "schema",
                                    variable: row,
                                  })
                                }
                              >
                                Edit default
                              </button>
                            ) : null}
                          </>
                        )}
                      </td>
                      {displayMatrix!.resolutions.map((resolution) => {
                        const v = resolution.variables.find(
                          (v) => v.name === row.name,
                        )!;
                        return (
                          <td key={resolution.environment}>
                            {inline?.environment === resolution.environment &&
                            inline.variable.name === v.name ? (
                              <InlineEditor
                                variable={inline.variable}
                                environment={inline.environment}
                                busy={busy}
                                hideEpoch={hideEpoch}
                                initialValue={
                                  allVisible && revealedMatrix
                                    ? {
                                        value:
                                          revealedMatrix.editableValues?.[
                                            resolution.environment
                                          ]?.[v.name] ?? v.value,
                                      }
                                    : v.state === "missing" ||
                                        (v.state === "default" && !v.sensitive)
                                      ? { value: v.value }
                                      : undefined
                                }
                                onLoad={() =>
                                  reveal(resolution.environment, v.name)
                                }
                                onSave={(value) =>
                                  mutate({
                                    action: "set",
                                    name: v.name,
                                    environment: resolution.environment,
                                    value,
                                    versions: matrix.versions[v.name],
                                  })
                                }
                                onCancel={() => setInline(undefined)}
                                onRemove={() =>
                                  mutate({
                                    action: "remove",
                                    name: v.name,
                                    environment: resolution.environment,
                                    versions: matrix.versions[v.name],
                                  })
                                }
                              />
                            ) : (
                              <div className="matrix-cell">
                                <button
                                  className={`value-cell ${v.state} ${!v.valid ? "invalid" : ""}`}
                                  disabled={busy}
                                  aria-label={`Edit ${v.name} in ${resolution.environment}`}
                                  onClick={() =>
                                    setInline({
                                      environment: resolution.environment,
                                      variable: v,
                                    })
                                  }
                                >
                                  <span className="value">
                                    {v.state === "missing"
                                      ? "Not set"
                                      : v.sensitive && !allVisible
                                        ? "••••••••"
                                        : v.value === ""
                                          ? "(empty)"
                                          : v.value}
                                  </span>
                                  <span className="origin">
                                    {!v.valid ? "⚠ Invalid · " : ""}
                                    {originLabel(v)}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className="cell-details"
                                  disabled={busy}
                                  aria-label={`Details for ${v.name} in ${resolution.environment}`}
                                  title="Value details and advanced editing"
                                  onClick={() => {
                                    setInline(undefined);
                                    setCell({
                                      environment: resolution.environment,
                                      variable: v,
                                    });
                                  }}
                                >
                                  <svg
                                    aria-hidden="true"
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.7"
                                  >
                                    <circle cx="12" cy="12" r="9" />
                                    <path d="M12 11v6M12 7v2" />
                                  </svg>
                                </button>
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!visible.length ? (
                <div className="empty">
                  <h2>
                    {rows.length
                      ? "No matching variables"
                      : "Start with a variable"}
                  </h2>
                  <p>
                    {rows.length
                      ? "Try another search or filter."
                      : "Add a definition or adopt an existing vault item below."}
                  </p>
                </div>
              ) : null}
            </div>
            <footer className="matrix-footer">
              <span>
                <i className="legend-dot" />
                Explicit override
              </span>
              <span>
                <i className="legend-dot inherited" />
                Inherited value
              </span>
              <span>
                {allVisible
                  ? "All matrix values are visible."
                  : revealingAll
                    ? "Revealing all values…"
                    : "Sensitive values stay masked until revealed."}
              </span>
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
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setAddName(item.name);
                    setModal("add");
                  }}
                >
                  Adopt into schema
                </button>
              </div>
            ))}
          </section>
        ) : null}
        <p className="footnote">
          Values refresh on demand. Reload direnv or restart your application
          after making changes.
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
      {modal && matrix ? (
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
    </div>
  );
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current
      ?.querySelector<HTMLElement>("button, input, textarea, select")
      ?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        const elements = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <div className="drawer-header">
          <h2 id="dialog-title">{title}</h2>
          <button
            className="icon-button"
            aria-label="Close editor"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Editor({
  cell,
  matrix,
  busy,
  saveError,
  onClose,
  onSave,
  onReveal,
  onSource,
}: {
  cell: Cell;
  matrix: Matrix;
  busy: boolean;
  saveError: string;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<unknown>;
  onReveal: (
    environment: string,
    name: string,
  ) => Promise<{ value?: string; explicitValue?: string; notes: string }>;
  onSource: (env: string) => void;
}) {
  const v = cell.variable;
  const [action, setAction] = useState(
    cell.environment === "schema" ? "default" : "set",
  );
  const [value, setValue] = useState(
    cell.environment === "schema"
      ? (v.defaultValue ?? "")
      : !v.sensitive && v.state === "explicit"
        ? (v.value ?? "")
        : "",
  );
  const [notes, setNotes] = useState<string>();
  const [valueTouched, setValueTouched] = useState(false);
  const [notesTouched, setNotesTouched] = useState(false);
  const [explicitEmpty, setExplicitEmpty] = useState(false);
  const [revealed, setRevealed] = useState<string>();
  const [revealing, setRevealing] = useState(false);
  const [localError, setLocalError] = useState("");
  const [description, setDescription] = useState(v.description);
  const [type, setType] = useState(v.type);
  const [required, setRequired] = useState(v.required);
  const [sensitive, setSensitive] = useState(v.sensitive);
  const [newName, setNewName] = useState(v.name);
  const [confirmation, setConfirmation] = useState("");
  const common = { name: v.name, versions: matrix.versions[v.name] };
  async function reveal() {
    setRevealing(true);
    setLocalError("");
    try {
      const result = await onReveal(cell.environment, v.name);
      setRevealed(result.value ?? "");
      if (result.explicitValue !== undefined && !valueTouched)
        setValue(result.explicitValue);
      if (!notesTouched) setNotes(result.notes);
    } catch (error) {
      setLocalError((error as Error).message);
    } finally {
      setRevealing(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const payload =
      action === "set"
        ? {
            action,
            ...common,
            environment: cell.environment,
            ...(valueTouched ? { value } : {}),
            ...(notesTouched ? { notes: notes ?? "" } : {}),
          }
        : action === "default"
          ? { action, ...common, value }
          : action === "definition"
            ? {
                action,
                ...common,
                ...(description !== v.description ? { description } : {}),
                ...(type !== v.type ? { type } : {}),
                ...(required !== v.required ? { required } : {}),
                ...(sensitive !== v.sensitive ? { sensitive } : {}),
              }
            : action === "rename"
              ? { action, ...common, newName }
              : { action, ...common, confirmation };
    void onSave(payload);
  }
  return (
    <Dialog title={v.name} onClose={onClose}>
      {saveError ? (
        <div role="alert" className="alert error">
          {saveError}
        </div>
      ) : null}
      <div className="provenance">
        <span className="eyebrow">
          {cell.environment === "schema"
            ? "BASE DEFAULT"
            : cell.environment.toUpperCase()}
        </span>
        <h3>
          {cell.environment === "schema" ? "Schema default" : originLabel(v)}
        </h3>
        <p>{v.description || "No description yet."}</p>
        <p className="chain">
          {[
            "schema",
            ...(matrix.resolutions.find(
              (r) => r.environment === cell.environment,
            )?.chain ?? []),
          ].join(" → ")}
        </p>
        {v.state === "inherited" && v.source ? (
          <button className="text-button" onClick={() => onSource(v.source!)}>
            Edit source environment: {v.source}
          </button>
        ) : null}
      </div>
      {v.errors.length ? (
        <div className="alert error">{v.errors.join(" ")}</div>
      ) : null}
      {localError ? (
        <div role="alert" className="alert error">
          {localError}
        </div>
      ) : null}
      {cell.environment !== "schema" ? (
        <div className="reveal">
          <span>Effective value</span>
          {revealed !== undefined ? (
            <>
              <pre>{revealed || "(empty)"}</pre>
              <button
                className="text-button"
                onClick={() => {
                  setRevealed(undefined);
                  if (v.sensitive && !valueTouched) setValue("");
                  if (!notesTouched) setNotes(undefined);
                }}
              >
                Hide value
              </button>
            </>
          ) : (
            <button
              className="secondary"
              disabled={revealing || busy}
              onClick={() => void reveal()}
            >
              {revealing ? "Revealing…" : "Reveal current value"}
            </button>
          )}
        </div>
      ) : null}
      <form onSubmit={submit}>
        <label>
          Change
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {cell.environment !== "schema" ? (
              <option value="set">
                {v.state === "explicit"
                  ? "Replace override"
                  : "Create override here"}
              </option>
            ) : null}
            {!v.sensitive ? (
              <option value="default">Edit schema default</option>
            ) : null}
            <option value="definition">Edit definition</option>
            <option value="rename">Rename everywhere</option>
            <option value="delete">Delete everywhere</option>
          </select>
        </label>
        {action === "set" || action === "default" ? (
          <>
            <label>
              {action === "set"
                ? `New value in ${cell.environment}`
                : "Default shared by every environment"}
              <textarea
                aria-label="New value"
                rows={5}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  action === "set" && v.state === "explicit" && v.sensitive
                    ? "Enter a replacement, or leave the current value unchanged."
                    : undefined
                }
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setValueTouched(true);
                  setExplicitEmpty(false);
                }}
                readOnly={action === "default" && !v.editable}
              />
            </label>
            {action === "set" ? (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={explicitEmpty}
                  onChange={(e) => {
                    setExplicitEmpty(e.target.checked);
                    if (e.target.checked) {
                      setValue("");
                      setValueTouched(true);
                    } else if (value === "") setValueTouched(false);
                  }}
                />
                Set an explicit empty value
              </label>
            ) : null}
            {action === "default" && !v.editable ? (
              <p>
                Expression defaults are read-only. Edit them in your schema.
              </p>
            ) : null}
            {action === "set" ? (
              <label>
                Notes for this override
                <textarea
                  rows={3}
                  placeholder={
                    notes === undefined
                      ? "Existing notes will be preserved. Reveal to edit them."
                      : ""
                  }
                  value={notes ?? ""}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    setNotesTouched(true);
                  }}
                />
              </label>
            ) : null}
          </>
        ) : action === "definition" ? (
          <>
            <label>
              Description
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              Type
              <input value={type} onChange={(e) => setType(e.target.value)} />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              Required
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={sensitive}
                onChange={(e) => setSensitive(e.target.checked)}
              />
              Sensitive
            </label>
          </>
        ) : action === "rename" ? (
          <label>
            New variable name
            <input
              required
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
        ) : (
          <>
            <p className="danger-note">
              This deletes the definition and its items from every configured
              environment.
            </p>
            <label>
              Type {v.name} to confirm
              <input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </label>
          </>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            disabled={
              busy ||
              (action === "set" &&
                ((!valueTouched && !notesTouched) ||
                  (valueTouched && value === "" && !explicitEmpty))) ||
              (action === "set" && v.state !== "explicit" && !valueTouched) ||
              (action === "delete" && confirmation !== v.name) ||
              (action === "default" && !v.editable)
            }
            className={action === "delete" ? "danger" : ""}
          >
            {busy
              ? "Saving…"
              : action === "delete"
                ? "Delete everywhere"
                : "Save change"}
          </button>
        </div>
      </form>
      {v.state === "explicit" && cell.environment !== "schema" ? (
        <div className="remove-override">
          <h3>Restore inheritance</h3>
          <p>
            Remove this override to use the parent environment or schema
            default.
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void onSave({
                ...common,
                action: "remove",
                environment: cell.environment,
              })
            }
          >
            Remove override
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}

function ProjectDialog({
  mode,
  matrix,
  initialName,
  busy,
  saveError,
  onClose,
  onSave,
}: {
  mode: "add" | "settings";
  matrix: Matrix;
  initialName: string;
  busy: boolean;
  saveError: string;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [type, setType] = useState("string");
  const [required, setRequired] = useState(false);
  const [sensitive, setSensitive] = useState(true);
  const [createWithValue, setCreateWithValue] = useState(!initialName);
  const [environment, setEnvironment] = useState(
    matrix.config.defaultEnvironment ?? matrix.environments[0],
  );
  const [initialValue, setInitialValue] = useState("");
  const [initialNotes, setInitialNotes] = useState("");
  const [explicitEmpty, setExplicitEmpty] = useState(false);
  const [config, setConfig] = useState(JSON.stringify(matrix.config, null, 2));
  const [error, setError] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (mode === "settings") {
      try {
        void onSave({ action: "config", config: JSON.parse(config) });
      } catch {
        setError("Enter valid JSON for the project settings.");
      }
    } else
      void onSave({
        action: "add",
        name,
        description,
        type,
        required,
        sensitive,
        ...(createWithValue
          ? {
              initialValues: {
                [environment]: { value: initialValue, notes: initialNotes },
              },
            }
          : {}),
        versions:
          matrix.versions[name] ??
          Object.fromEntries(matrix.environments.map((env) => [env, null])),
      });
  }
  return (
    <Dialog
      title={
        mode === "add"
          ? initialName
            ? "Adopt variable"
            : "Add variable"
          : "Project settings"
      }
      onClose={onClose}
    >
      {saveError ? (
        <div role="alert" className="alert error">
          {saveError}
        </div>
      ) : null}
      <p className="dialog-intro">
        {mode === "settings"
          ? "These settings live in the header of your .env.schema. Vaults are identified by their IDs."
          : initialName
            ? "Adopt the existing vault item without copying its value into the schema."
            : "Create a secret in an environment. Child environments inherit its value until you add an override."}
      </p>
      {error ? (
        <div role="alert" className="alert error">
          {error}
        </div>
      ) : null}
      <form onSubmit={submit}>
        {mode === "settings" ? (
          <label>
            Schema project settings
            <textarea
              className="config-editor"
              rows={18}
              value={config}
              onChange={(e) => setConfig(e.target.value)}
              spellCheck={false}
            />
          </label>
        ) : (
          <>
            <label>
              Variable name
              <input
                required
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Description
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              Type
              <input value={type} onChange={(e) => setType(e.target.value)} />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              Required
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={sensitive}
                onChange={(e) => setSensitive(e.target.checked)}
              />
              Sensitive
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={createWithValue}
                onChange={(e) => setCreateWithValue(e.target.checked)}
              />
              Set an initial environment value
            </label>
            {createWithValue ? (
              <fieldset className="initial-value">
                <legend>Initial value</legend>
                <label>
                  Environment
                  <select
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value)}
                  >
                    {matrix.environments.map((env) => (
                      <option key={env} value={env}>
                        {env}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Secret value
                  <textarea
                    aria-label="Secret value"
                    rows={5}
                    autoComplete="off"
                    spellCheck={false}
                    value={initialValue}
                    onChange={(e) => {
                      setInitialValue(e.target.value);
                      setExplicitEmpty(false);
                    }}
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={explicitEmpty}
                    onChange={(e) => {
                      setExplicitEmpty(e.target.checked);
                      if (e.target.checked) setInitialValue("");
                    }}
                  />
                  Use an explicit empty value
                </label>
                <label>
                  Notes
                  <textarea
                    aria-label="Initial value notes"
                    value={initialNotes}
                    onChange={(e) => setInitialNotes(e.target.value)}
                  />
                </label>
              </fieldset>
            ) : null}
          </>
        )}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={
              busy ||
              (mode === "add" &&
                createWithValue &&
                initialValue === "" &&
                !explicitEmpty)
            }
          >
            {busy
              ? "Saving…"
              : mode === "add" && !initialName
                ? "Create secret"
                : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
