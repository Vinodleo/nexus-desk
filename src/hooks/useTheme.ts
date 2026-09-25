import { useCallback, useState } from "react";
import { loadTheme, setTheme, type ThemeId } from "../services/theme";

/** The theme this device uses, and a setter that shows and saves it. */
export function useTheme() {
  const [theme, setState] = useState<ThemeId>(loadTheme);
  const choose = useCallback((id: ThemeId) => {
    setTheme(id);
    setState(id);
  }, []);
  return { theme, setTheme: choose };
}
