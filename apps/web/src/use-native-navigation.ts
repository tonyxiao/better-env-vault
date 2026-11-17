import { useLayoutEffect, useRef } from "react";

const guards = new Map<symbol, number>();
declare global {
  interface Window {
    __bevNavigationState?: () => number;
  }
}
/** Only a fixed state crosses into the shell: 0 clean, 1 drafts, 2 saving. */
export function useNativeNavigation(state: 0 | 1 | 2) {
  const id = useRef(Symbol());
  useLayoutEffect(() => {
    const key = id.current;
    guards.set(key, state);
    window.__bevNavigationState = () => Math.max(0, ...guards.values());
    return () => {
      guards.delete(key);
      if (!guards.size) delete window.__bevNavigationState;
    };
  }, [state]);
}
