import { useEffect, useEffectEvent } from "react";
import type { DataGridHandle } from "react-data-grid";

export function focusGridCell(
  grid: DataGridHandle | null,
  position: { rowIdx: number; idx: number },
) {
  grid?.setActivePosition(position, { shouldFocus: true });
  // The grid does not refocus when the requested cell is already selected.
  requestAnimationFrame(() => {
    grid?.element
      ?.querySelector<HTMLElement>(
        '[role="gridcell"][tabindex="0"], [role="columnheader"][tabindex="0"], [role="row"][tabindex="0"]',
      )
      ?.focus();
  });
}

/** Shared by the schema matrix and vault browser; modal editors own their keys. */
export function useSearchShortcuts(
  searchId: string,
  focusGrid: () => void,
  beforeSearch?: () => void,
  cancelSearch?: () => void | boolean,
) {
  const handleKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || document.querySelector('[role="dialog"]')) return;
    const search = document.getElementById(searchId) as HTMLInputElement | null;
    if (!search || search.disabled) return;
    const target = event.target as HTMLElement | null;
    const typing = target?.closest(
      'input, textarea, select, [contenteditable="true"]',
    );
    const command = event.ctrlKey || event.metaKey;
    if (
      (command &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k") ||
      (!command &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === "/" &&
        !typing)
    ) {
      event.preventDefault();
      event.stopPropagation();
      search.focus();
      search.select();
    } else if (
      target === search &&
      !command &&
      !event.altKey &&
      !event.shiftKey &&
      ["Enter", "ArrowDown", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && cancelSearch) {
        if (cancelSearch() === false) focusGrid();
      } else focusGrid();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKey(event);
    const focus = (event: FocusEvent) => {
      if ((event.target as HTMLElement | null)?.id === searchId) enterSearch();
    };
    window.addEventListener("keydown", listener, true);
    window.addEventListener("focusin", focus);
    return () => {
      window.removeEventListener("keydown", listener, true);
      window.removeEventListener("focusin", focus);
    };
  }, []);
  const enterSearch = useEffectEvent(() => beforeSearch?.());
}
