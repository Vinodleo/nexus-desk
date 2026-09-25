import { useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { loadTheme, setTheme, withThemeTransition, type ThemeId } from "../services/theme";

/** The theme this device uses, and a setter that shows and saves it (the new look grows from where it was picked). */
export function useTheme() {
  const [theme, setState] = useState<ThemeId>(loadTheme);
  const choose = useCallback((id: ThemeId, from?: { x: number; y: number }) => {
    // Everything that changes with the theme (the colours, the picker's ring)
    // must be on screen when the new snapshot is taken, so React renders now.
    withThemeTransition(() =>
      flushSync(() => {
        setTheme(id);
        setState(id);
      }),
      from
    );
  }, []);
  return { theme, setTheme: choose };
}
