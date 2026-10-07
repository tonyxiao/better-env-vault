import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ResolvedVariable } from "../../../packages/core/src/resolver.js";

export function originLabel(variable: ResolvedVariable) {
  if (variable.state === "default") return "Inherits schema default";
  if (variable.state === "inherited") return `Inherits ${variable.source}`;
  if (variable.state === "explicit") return "Explicit override";
  return "Missing value";
}

export function EyeIcon({ hidden = false }: { hidden?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {hidden ? <path d="m3 3 18 18" /> : null}
    </svg>
  );
}

export function InlineEditor({
  variable,
  environment,
  busy,
  hideEpoch,
  initialValue,
  onLoad,
  onSave,
  onCancel,
  onRemove,
}: {
  variable: ResolvedVariable;
  environment: string;
  busy: boolean;
  hideEpoch: number;
  initialValue?: { value?: string };
  onLoad: () => Promise<{ editableValue?: string; value?: string }>;
  onSave: (value: string) => Promise<boolean>;
  onCancel: () => void;
  onRemove?: () => Promise<boolean>;
}) {
  const [value, setValue] = useState(initialValue?.value ?? "");
  const [baseline, setBaseline] = useState(initialValue?.value ?? "");
  const [loading, setLoading] = useState(initialValue === undefined);
  const [error, setError] = useState("");
  const [failedLoad, setFailedLoad] = useState(false);
  const ownEmpty = variable.state === "explicit" || environment === "schema";
  const [empty, setEmpty] = useState(ownEmpty && initialValue?.value === "");
  const [baselineEmpty, setBaselineEmpty] = useState(
    ownEmpty && initialValue?.value === "",
  );
  const [shown, setShown] = useState(true);
  const initialHideEpoch = useRef(hideEpoch);
  const field = useRef<HTMLTextAreaElement>(null);
  // Capture the explicit edit request once. Parent refreshes must not replace a draft.
  const load = useRef(onLoad);
  const initial = useRef(initialValue);
  useEffect(() => {
    if (initial.current !== undefined) return;
    let cancelled = false;
    void load
      .current()
      .then((result) => {
        if (cancelled) return;
        const current = result.editableValue ?? result.value ?? "";
        setValue(current);
        setBaseline(current);
        const isEmpty =
          ownEmpty &&
          current === "" &&
          (result.editableValue !== undefined || result.value !== undefined);
        setEmpty(isEmpty);
        setBaselineEmpty(isEmpty);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not load this value. Refresh and try again.");
          setFailedLoad(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const dirty = value !== baseline || empty !== baselineEmpty;
  useEffect(() => {
    if (!loading && shown) field.current?.focus();
  }, [loading, shown]);
  useEffect(() => {
    if (hideEpoch !== initialHideEpoch.current) {
      initialHideEpoch.current = hideEpoch;
      if (variable.sensitive) setShown(false);
    }
  }, [hideEpoch, variable.sensitive]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    const saved = await onSave(value);
    if (!saved)
      setError(
        "The value was not saved. Check the message above, then retry or cancel.",
      );
  }
  return (
    <form
      className="inline-editor"
      aria-label={`Edit ${variable.name} in ${environment}`}
      onSubmit={(event) => void save(event)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        }
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !loading &&
          !busy &&
          !failedLoad &&
          dirty &&
          (value !== "" || empty)
        ) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
      <span className="origin">
        {environment === "schema" ? "Schema default" : originLabel(variable)}
      </span>
      {loading ? (
        <span role="status">Loading value…</span>
      ) : shown ? (
        <textarea
          ref={field}
          aria-label={`${variable.name} value in ${environment}`}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setEmpty(false);
            setError("");
          }}
          rows={3}
          autoComplete="off"
          spellCheck={false}
          disabled={busy || failedLoad}
        />
      ) : (
        <button
          type="button"
          className="secondary"
          onClick={() => setShown(true)}
        >
          Reveal inline value
        </button>
      )}
      {shown && !loading && value === "" ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={empty}
            onChange={(event) => {
              setEmpty(event.target.checked);
              if (event.target.checked) setValue("");
            }}
            disabled={busy}
          />
          Set an explicit empty value
        </label>
      ) : null}
      {environment !== "schema" &&
      (variable.state === "inherited" || variable.state === "default") ? (
        <span className="inline-hint">
          Saving creates an override in {environment}.
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="inline-error">
          {error}
        </span>
      ) : null}
      <div className="inline-actions">
        <button
          type="submit"
          disabled={
            busy || loading || failedLoad || !dirty || (value === "" && !empty)
          }
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        {onRemove && variable.state === "explicit" ? (
          <button
            type="button"
            className="text-button"
            disabled={busy || loading}
            onClick={() => void onRemove()}
          >
            Remove override
          </button>
        ) : null}
      </div>
    </form>
  );
}
