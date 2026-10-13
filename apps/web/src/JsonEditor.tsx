import { useMemo, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "./components/ui/sheet.js";
import { formatJson, jsonTokens } from "./json-value.js";

export function JsonEditor({
  initialValue,
  label,
  onChange,
  onSave,
  onCancel,
  onPlainText,
}: {
  initialValue: string;
  label: string;
  onChange: (value: string) => void;
  onSave: (compact: string) => void;
  onCancel: () => void;
  onPlainText: () => void;
}) {
  const [source, setSource] = useState(() => {
    try {
      return formatJson(initialValue).pretty;
    } catch {
      return initialValue;
    }
  });
  const highlighted = useRef<HTMLPreElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const tokens = useMemo(() => jsonTokens(source), [source]);
  const result = useMemo(() => {
    try {
      return { ...formatJson(source), error: "" };
    } catch (error) {
      return {
        compact: undefined,
        pretty: undefined,
        error: (error as Error).message,
      };
    }
  }, [source]);
  function change(next: string) {
    setSource(next);
    onChange(next);
  }
  function save() {
    if (result.compact !== undefined) onSave(result.compact);
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <SheetContent
        className="json-drawer w-full sm:max-w-[720px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
      >
        <SheetTitle>{label}</SheetTitle>
        <SheetDescription>
          Formatted JSON. Saved as a compact JSON string.
        </SheetDescription>
        <div className="json-code-editor">
          <pre ref={highlighted} className="json-highlight" aria-hidden="true">
            <code>
              {tokens.map((token, index) => (
                <span key={index} className={`json-${token.kind}`}>
                  {token.text}
                </span>
              ))}
              {"\n"}
            </code>
          </pre>
          <textarea
            ref={input}
            className="json-input"
            aria-label={label}
            value={source}
            spellCheck={false}
            autoComplete="off"
            wrap="off"
            onChange={(event) => change(event.target.value)}
            onScroll={(event) => {
              if (highlighted.current) {
                highlighted.current.scrollTop = event.currentTarget.scrollTop;
                highlighted.current.scrollLeft = event.currentTarget.scrollLeft;
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                event.stopPropagation();
                save();
              } else if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setRangeText(
                  "  ",
                  event.currentTarget.selectionStart,
                  event.currentTarget.selectionEnd,
                  "end",
                );
                change(event.currentTarget.value);
              }
            }}
          />
        </div>
        {result.error ? (
          <p className="json-error" role="alert">
            Invalid JSON: {result.error}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            Enter adds a line · Tab indents · Shift+Tab moves focus ·
            Ctrl/Cmd+Enter saves
          </p>
        )}
        <div className="json-actions">
          <Button disabled={result.compact === undefined} onClick={save}>
            Save JSON
          </Button>
          <Button
            variant="outline"
            disabled={!!result.error}
            onClick={() => change(result.pretty!)}
          >
            Format
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="ghost" onClick={onPlainText}>
            Use plain text
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
