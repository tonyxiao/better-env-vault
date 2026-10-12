import { Check, Eye, EyeOff, LoaderCircle, X } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { Checkbox } from "./components/ui/checkbox.js";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
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
export type EditDirection = "next" | "previous" | "down" | "up";

export function SpreadsheetEditor({
  variable,
  environment,
  origin,
  compact = false,
  inputLabel,
  shiftEnterNewline = false,
  hideEpoch,
  initialValue,
  draftValue,
  onLoad,
  onSave,
  onLeave,
  onCancel,
  onNavigate,
  onCommitReady,
}: {
  variable: ResolvedVariable;
  environment: string;
  origin?: string;
  compact?: boolean;
  inputLabel?: string;
  shiftEnterNewline?: boolean;
  hideEpoch: number;
  initialValue?: { value?: string };
  draftValue?: string;
  onLoad: () => Promise<{ editableValue?: string; value?: string }>;
  onSave: (value: string) => Promise<boolean>;
  onLeave: (value: string) => Promise<boolean>;
  onCancel: () => void;
  onNavigate: (direction: EditDirection) => void;
  onCommitReady: (commit: (() => void) | undefined) => void;
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
  const load = useRef(onLoad),
    initial = useRef(initialValue),
    draft = useRef(draftValue);
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
  // Clearing a previously populated cell is deliberate. Opening an already
  // empty/missing cell still requires explicit intent before creating an item.
  const canSave =
    !loading &&
    !failedLoad &&
    dirty &&
    (value !== "" || empty || baseline !== "");
  useEffect(() => {
    if (loading) return;
    if (!shown) {
      if (document.activeElement === document.body)
        revealButton.current?.focus();
    } else if (failedLoad) cancelButton.current?.focus();
    else {
      field.current?.focus();
      field.current?.select();
    }
  }, [loading, shown, failedLoad]);
  useEffect(() => {
    if (hideEpoch !== initialHideEpoch.current) {
      initialHideEpoch.current = hideEpoch;
      if (variable.sensitive) setShown(false);
    }
  }, [hideEpoch, variable.sensitive]);
  useLayoutEffect(() => {
    onCommitReady(() => {
      if (canSave) void onLeave(value);
    });
    return () => onCommitReady(undefined);
  }, [canSave, value, onLeave, onCommitReady]);
  function save(event: FormEvent) {
    event.preventDefault();
    if (canSave) void onSave(value);
  }
  return (
    <form
      className="spreadsheet-editor"
      aria-label={`Edit ${variable.name} in ${environment}`}
      onSubmit={save}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
          return;
        }
        if (
          event.target !== field.current ||
          (event.key !== "Enter" && event.key !== "Tab")
        )
          return;
        if (
          event.key === "Enter" &&
          (event.altKey || (event.shiftKey && shiftEnterNewline))
        ) {
          event.preventDefault();
          event.stopPropagation();
          const input = field.current!;
          input.setRangeText(
            "\n",
            input.selectionStart,
            input.selectionEnd,
            "end",
          );
          setValue(input.value);
          setEmpty(false);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (loading || failedLoad || (dirty && !canSave)) return;
        if (canSave) void onSave(value);
        else onCancel();
        if (event.key === "Tab")
          onNavigate(event.shiftKey ? "previous" : "next");
        else if (!event.ctrlKey && !event.metaKey)
          onNavigate(event.shiftKey ? "up" : "down");
      }}
    >
      <div className="spreadsheet-control">
        {loading ? (
          <span className="spreadsheet-loading" role="status">
            <LoaderCircle
              className="size-3.5 animate-spin"
              aria-hidden="true"
            />
            Loading value…
          </span>
        ) : shown ? (
          <Textarea
            ref={field}
            className="spreadsheet-input"
            aria-label={
              inputLabel ?? `${variable.name} value in ${environment}`
            }
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setEmpty(false);
            }}
            rows={1}
            wrap="off"
            autoComplete="off"
            spellCheck={false}
            disabled={failedLoad}
            title={`Enter saves and moves down; Tab saves and moves across; ${shiftEnterNewline ? "Shift+Enter or " : ""}Alt+Enter inserts a newline`}
          />
        ) : (
          <Button
            ref={revealButton}
            className="spreadsheet-reveal"
            size="xs"
            variant="ghost"
            type="button"
            onClick={() => setShown(true)}
          >
            <EyeIcon />
            Reveal inline value
          </Button>
        )}
        {shown && !loading && value === "" && baseline === "" ? (
          <label
            className="spreadsheet-empty"
            title="Set an explicit empty value"
          >
            <Checkbox
              checked={empty}
              onCheckedChange={(checked) => setEmpty(checked === true)}
              disabled={failedLoad}
            />
            <span className="sr-only">Set an explicit empty value</span>
          </label>
        ) : null}
        <Button
          type="submit"
          variant="ghost"
          size="icon-xs"
          aria-label="Save"
          title="Save (Ctrl/Cmd+Enter)"
          disabled={!canSave}
        >
          <Check aria-hidden="true" />
        </Button>
        <Button
          ref={cancelButton}
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Cancel"
          title="Cancel (Escape)"
          onClick={onCancel}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      {error ? (
        <span
          className="spreadsheet-caption inline-error"
          role="alert"
          title={error}
        >
          {error}
        </span>
      ) : !compact ? (
        <span className="spreadsheet-caption origin">
          {origin ??
            (environment === "schema"
              ? "Schema default"
              : originLabel(variable))}
        </span>
      ) : null}
    </form>
  );
}
