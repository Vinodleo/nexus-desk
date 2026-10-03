import { useEffect, useState } from "react";
import { apiFetch } from "../../services/apiClient";

// The Lab's feeds from the server. Its tabs stay mounted, and several cards
// read the same route (the summary, the records and the tests all read the
// replays): one request each serves them all.

const inFlight = new Map<string, Promise<any>>();

/** GET `path` as JSON (null when it fails or isn't there), sharing a request already on its way. */
export function labGet(path: string): Promise<any> {
  let p = inFlight.get(path);
  if (!p) {
    p = apiFetch(path)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .finally(() => inFlight.delete(path));
    inFlight.set(path, p);
  }
  return p;
}

/**
 * A route's reply, once it's one `isView` accepts (null until then, and for
 * an older server without the route). Looks again every `refreshMs` while
 * `again` says so (a replay still running).
 */
export function useLabFeed<T>(path: string, isView: (body: any) => body is T, again?: (view: T) => boolean, refreshMs = 60_000): T | null {
  const [view, setView] = useState<T | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      labGet(path).then((body) => {
        if (cancelled || !isView(body)) return;
        setView(body);
        if (again?.(body)) timer = setTimeout(load, refreshMs);
      });
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // The route and its checks are fixed for a card.
  }, [path]);
  return view;
}
