import { useRef, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import {
  NativeSelect,
  NativeSelectOption,
} from "./components/ui/native-select.js";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "./components/ui/sheet.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Textarea } from "./components/ui/textarea.js";
import { Checkbox } from "./components/ui/checkbox.js";
import { originLabel } from "./MatrixCell.js";
import type { Cell, Matrix } from "./matrix-model.js";
export function Dialog({
  title,
  onClose,
  children,
  trigger,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  trigger?: HTMLElement;
}) {
  const previous = useRef(
    trigger ?? (document.activeElement as HTMLElement | null),
  );
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="drawer w-full sm:max-w-[520px]"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const label = previous.current?.getAttribute("aria-label");
          const target = previous.current?.isConnected
            ? previous.current
            : label
              ? [
                  ...document.querySelectorAll<HTMLElement>(
                    "button[aria-label]",
                  ),
                ].find((button) => button.getAttribute("aria-label") === label)
              : undefined;
          target?.focus();
        }}
      >
        <div className="drawer-header">
          <SheetTitle>{title}</SheetTitle>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close editor"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <SheetDescription className="sr-only">
          Edit values and variable definitions.
        </SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}

export function Editor({
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
  const vaultMode = matrix.mode === "vault";
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
  const [notes, setNotes] = useState<string | undefined>(() =>
    vaultMode
      ? matrix.notes?.[v.name]
      : matrix.environmentNotes?.[cell.environment] !== undefined
        ? (matrix.environmentNotes[cell.environment][v.name] ?? "")
        : undefined,
  );
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
  const common = useRef({
    name: v.name,
    versions: matrix.versions[v.name],
    fingerprint: matrix.fingerprint,
  }).current;
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
    <Dialog title={v.name} onClose={onClose} trigger={cell.trigger}>
      {saveError ? (
        <div role="alert" className="alert error">
          {saveError}
        </div>
      ) : null}
      <div className="provenance">
        <span className="eyebrow">
          {cell.environment === "schema"
            ? "BASE DEFAULT"
            : vaultMode
              ? matrix.config.name
              : cell.environment.toUpperCase()}
        </span>
        <h3>
          {vaultMode
            ? "Stored in vault"
            : cell.environment === "schema"
              ? "Schema default"
              : originLabel(v)}
        </h3>
        {!vaultMode ? <p>{v.description || "No description yet."}</p> : null}
        <p className="chain">
          {[
            ...(vaultMode ? [] : ["schema"]),
            ...(matrix.resolutions.find(
              (r) => r.environment === cell.environment,
            )?.chain ?? []),
          ].join(" → ")}
        </p>
        {v.state === "inherited" && v.source ? (
          <Button
            variant="link"
            className="text-button"
            onClick={() => onSource(v.source!)}
          >
            Edit source environment: {v.source}
          </Button>
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
              <Button
                variant="link"
                className="text-button"
                onClick={() => {
                  setRevealed(undefined);
                  if (v.sensitive && !valueTouched) setValue("");
                  if (!notesTouched) setNotes(undefined);
                }}
              >
                Hide value
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              disabled={revealing || busy}
              onClick={() => void reveal()}
            >
              {revealing ? "Revealing…" : "Reveal current value"}
            </Button>
          )}
        </div>
      ) : null}
      <form onSubmit={submit}>
        <label>
          Change
          <NativeSelect
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            {cell.environment !== "schema" ? (
              <NativeSelectOption value="set">
                {vaultMode
                  ? "Edit value and notes"
                  : v.state === "explicit"
                    ? "Replace override"
                    : "Create override here"}
              </NativeSelectOption>
            ) : null}
            {!vaultMode && !v.sensitive ? (
              <NativeSelectOption value="default">
                Edit schema default
              </NativeSelectOption>
            ) : null}
            {!vaultMode ? (
              <NativeSelectOption value="definition">
                Edit definition
              </NativeSelectOption>
            ) : null}
            <NativeSelectOption value="rename">
              {vaultMode ? "Rename in this vault" : "Rename everywhere"}
            </NativeSelectOption>
            <NativeSelectOption value="delete">
              {vaultMode ? "Delete from this vault" : "Delete everywhere"}
            </NativeSelectOption>
          </NativeSelect>
        </label>
        {action === "set" || action === "default" ? (
          <>
            <label>
              {action === "set"
                ? `New value in ${vaultMode ? matrix.config.name : cell.environment}`
                : "Default shared by every environment"}
              <Textarea
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
                <Checkbox
                  checked={explicitEmpty}
                  onCheckedChange={(checked) => {
                    setExplicitEmpty(checked === true);
                    if (checked === true) {
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
                {vaultMode ? "Notes" : "Notes for this override"}
                <Textarea
                  className="notes-field-input"
                  rows={8}
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
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              Type
              <Input value={type} onChange={(e) => setType(e.target.value)} />
            </label>
            <label className="checkbox">
              <Checkbox
                checked={required}
                onCheckedChange={(checked) => setRequired(checked === true)}
              />
              Required
            </label>
            <label className="checkbox">
              <Checkbox
                checked={sensitive}
                onCheckedChange={(checked) => setSensitive(checked === true)}
              />
              Sensitive
            </label>
          </>
        ) : action === "rename" ? (
          <label>
            New variable name
            <Input
              required
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
        ) : (
          <>
            <p className="danger-note">
              {vaultMode
                ? "This deletes this secret from the selected vault."
                : "This deletes the definition and its items from every configured environment."}
            </p>
            <label>
              Type {v.name} to confirm
              <Input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </label>
          </>
        )}
        <div className="form-actions">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              (action === "set" &&
                ((!valueTouched && !notesTouched) ||
                  (valueTouched && value === "" && !explicitEmpty))) ||
              (action === "set" && v.state !== "explicit" && !valueTouched) ||
              (action === "delete" && confirmation !== v.name) ||
              (action === "default" && !v.editable)
            }
            variant={action === "delete" ? "destructive" : "default"}
          >
            {busy
              ? "Saving…"
              : action === "delete"
                ? vaultMode
                  ? "Delete from this vault"
                  : "Delete everywhere"
                : "Save change"}
          </Button>
        </div>
      </form>
      {!vaultMode && v.state === "explicit" && cell.environment !== "schema" ? (
        <div className="remove-override">
          <h3>Restore inheritance</h3>
          <p>
            Remove this override to use the parent environment or schema
            default.
          </p>
          <Button
            variant="outline"
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
          </Button>
        </div>
      ) : null}
    </Dialog>
  );
}

export function ProjectDialog({
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
  const vaultMode = matrix.mode === "vault";
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
        ...(!vaultMode ? { description, type, required, sensitive } : {}),
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
          : "Schema settings"
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
            : vaultMode
              ? "Create a secret in the selected 1Password vault."
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
            <Textarea
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
              <Input
                required
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {!vaultMode ? (
              <>
                <label>
                  Description
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <label>
                  Type
                  <Input
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                  />
                </label>
                <label className="checkbox">
                  <Checkbox
                    checked={required}
                    onCheckedChange={(checked) => setRequired(checked === true)}
                  />
                  Required
                </label>
                <label className="checkbox">
                  <Checkbox
                    checked={sensitive}
                    onCheckedChange={(checked) =>
                      setSensitive(checked === true)
                    }
                  />
                  Sensitive
                </label>
                <label className="checkbox">
                  <Checkbox
                    checked={createWithValue}
                    onCheckedChange={(checked) =>
                      setCreateWithValue(checked === true)
                    }
                  />
                  Set an initial environment value
                </label>
              </>
            ) : null}
            {createWithValue ? (
              <fieldset className="initial-value">
                <legend>Initial value</legend>
                <label>
                  {vaultMode ? "Vault" : "Environment"}
                  <NativeSelect
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value)}
                  >
                    {matrix.environments.map((env) => (
                      <NativeSelectOption key={env} value={env}>
                        {vaultMode ? matrix.config.name : env}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                <label>
                  Secret value
                  <Textarea
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
                  <Checkbox
                    checked={explicitEmpty}
                    onCheckedChange={(checked) => {
                      setExplicitEmpty(checked === true);
                      if (checked === true) setInitialValue("");
                    }}
                  />
                  Use an explicit empty value
                </label>
                <label>
                  Notes
                  <Textarea
                    aria-label="Initial value notes"
                    className="notes-field-input"
                    rows={8}
                    value={initialNotes}
                    onChange={(e) => setInitialNotes(e.target.value)}
                  />
                </label>
              </fieldset>
            ) : null}
          </>
        )}
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
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
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
