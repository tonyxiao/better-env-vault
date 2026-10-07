import { Eye, EyeOff } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { Checkbox } from "./components/ui/checkbox.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ResolvedVariable } from "../../../packages/core/src/resolver.js";

export function originLabel(variable: ResolvedVariable) {
  if (variable.state === "default") return "Inherits schema default";
  if (variable.state === "inherited") return `Inherits ${variable.source}`;
  if (variable.state === "explicit") return "Explicit override";
  return "Missing value";
}

export function EyeIcon({ hidden = false }: { hidden?: boolean }) {
  const Icon = hidden ? EyeOff : Eye;
  return <Icon aria-hidden="true" />;
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
  onNavigate,
  draftValue,
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
  onNavigate?: (backward: boolean) => void;
  draftValue?: string;
}) {
  const [value, setValue] = useState(draftValue ?? initialValue?.value ?? "");
  const [baseline, setBaseline] = useState(initialValue?.value ?? "");
  const [loading, setLoading] = useState(initialValue === undefined);
  const [error, setError] = useState("");
  const [failedLoad, setFailedLoad] = useState(false);
  const ownEmpty = variable.state === "explicit" || environment === "schema";
  const [empty, setEmpty] = useState(
    draftValue === "" || (ownEmpty && initialValue?.value === ""),
  );
  const [baselineEmpty, setBaselineEmpty] = useState(
    ownEmpty && initialValue?.value === "",
  );
  const [shown, setShown] = useState(true);
  const initialHideEpoch = useRef(hideEpoch);
  const field = useRef<HTMLTextAreaElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const revealButton = useRef<HTMLButtonElement>(null);
  // Capture the explicit edit request once. Parent refreshes must not replace a draft.
  const load = useRef(onLoad);
  const initial = useRef(initialValue);
  const draft = useRef(draftValue);
  useEffect(() => {
    if (initial.current !== undefined) return;
    let cancelled = false;
    void load
      .current()
      .then((result) => {
        if (cancelled) return;
        const current = result.editableValue ?? result.value ?? "";
        setValue(draft.current ?? current);
        setBaseline(current);
        const isEmpty =
          ownEmpty &&
          current === "" &&
          (result.editableValue !== undefined || result.value !== undefined);
        setEmpty(draft.current === "" || isEmpty);
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
    if (!loading) {
      if (!shown) {
        if (document.activeElement === document.body)
          revealButton.current?.focus();
      } else if (failedLoad) cancelButton.current?.focus();
      else field.current?.focus();
    }
  }, [loading, shown, failedLoad]);
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
          event.stopPropagation();
          onCancel();
        }
        if (
          event.key === "Tab" &&
          event.target === field.current &&
          !loading &&
          !busy &&
          !failedLoad &&
          onNavigate
        ) {
          if (dirty && value === "" && !empty) return;
          event.preventDefault();
          event.stopPropagation();
          if (dirty) void onSave(value);
          onNavigate(event.shiftKey);
          return;
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
        <Textarea
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
        <Button
          ref={revealButton}
          type="button"
          variant="outline"
          onClick={() => setShown(true)}
        >
          Reveal inline value
        </Button>
      )}
      {shown && !loading && value === "" ? (
        <label className="checkbox">
          <Checkbox
            checked={empty}
            onCheckedChange={(checked) => {
              setEmpty(checked === true);
              if (checked === true) setValue("");
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
        <Button
          type="submit"
          disabled={
            busy || loading || failedLoad || !dirty || (value === "" && !empty)
          }
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          ref={cancelButton}
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {onRemove && variable.state === "explicit" ? (
          <Button
            type="button"
            variant="link"
            className="text-button"
            disabled={busy || loading}
            onClick={() => void onRemove()}
          >
            Remove override
          </Button>
        ) : null}
      </div>
    </form>
  );
}
