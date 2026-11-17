import { useEffect } from "react";
import "./use-native-navigation";

export function useNativeRefresh(
  refresh: (fresh: boolean, quiet: boolean) => Promise<void>,
) {
  useEffect(() => {
    const handle = () => {
      if ((window.__bevNavigationState?.() ?? 0) === 0)
        void refresh(true, true);
    };
    window.addEventListener("bev-refresh", handle);
    return () => window.removeEventListener("bev-refresh", handle);
  }, [refresh]);
}
