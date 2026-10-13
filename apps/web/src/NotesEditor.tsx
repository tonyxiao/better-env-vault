import { useRef } from "react";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "./components/ui/sheet.js";

export function NotesEditor({
  label,
  value,
  selection,
  canSave,
  onChange,
  onSave,
  onCancel,
}: {
  label: string;
  value: string;
  selection?: { start: number; end: number };
  canSave: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <SheetContent
        className="notes-drawer w-full sm:max-w-[720px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
          input.current?.setSelectionRange(
            selection?.start ?? value.length,
            selection?.end ?? value.length,
          );
        }}
      >
        <SheetTitle>{label}</SheetTitle>
        <SheetDescription>
          Line breaks and spacing are preserved.
        </SheetDescription>
        <Textarea
          ref={input}
          className="notes-editor-input"
          aria-label={label}
          value={value}
          rows={16}
          wrap="soft"
          autoComplete="off"
          placeholder="Add notes…"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              event.stopPropagation();
              if (canSave) onSave();
            }
          }}
        />
        <p className="text-muted-foreground text-sm">
          Enter or Shift+Enter adds a line · Ctrl/Cmd+Enter saves · Esc cancels
        </p>
        <div className="notes-actions">
          <Button disabled={!canSave} onClick={onSave}>
            Save notes
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
