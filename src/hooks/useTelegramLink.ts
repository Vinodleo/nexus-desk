import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../services/apiClient";

// Settings → Connections → Telegram (server/telegram.ts): whether the server
// has a bot and this user's chat is linked; linking opens the bot with a
// one-time code and looks again every 3 seconds until Telegram's Start
// links it; a test message; unlink.

export interface TelegramState {
  configured: boolean;
  linked: boolean;
}

/** How often it looks whether the link went through, while one waits. */
export const LINK_CHECK_MS = 3000;

/**
 * The server's link to the bot (https://t.me/<bot>?start=<code>) in its
 * parts, with the link that opens the Telegram app itself (tg://): opened
 * from the app, the t.me web page can sit blank instead of handing over to
 * Telegram (owner's screenshot, 23 Oct). Null for a link it can't read.
 */
export function telegramLinkParts(url: string): { bot: string; code: string; appUrl: string } | null {
  const m = url.match(/^https:\/\/t\.me\/([A-Za-z0-9_]{3,64})\?start=([A-Za-z0-9_-]{1,64})$/);
  return m ? { bot: m[1], code: m[2], appUrl: `tg://resolve?domain=${m[1]}&start=${m[2]}` } : null;
}

export function useTelegramLink(active: boolean) {
  /** undefined while loading; null when the server has no Telegram (an older one). */
  const [state, setState] = useState<TelegramState | null | undefined>(undefined);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/telegram");
      const data = res.ok ? await res.json() : null;
      setState(data?.success ? { configured: !!data.configured, linked: !!data.linked } : null);
    } catch {}
  }, []);

  useEffect(() => {
    if (active) void load();
    else {
      setUrl(null);
      setNote(null);
    }
  }, [active, load]);

  const linked = !!state?.linked;
  useEffect(() => {
    if (linked) setUrl(null);
  }, [linked]);
  useEffect(() => {
    if (!active || !url || linked) return;
    const t = setInterval(() => void load(), LINK_CHECK_MS);
    return () => clearInterval(t);
  }, [active, url, linked, load]);

  const post = async (path: string): Promise<any> => {
    setBusy(true);
    setNote(null);
    try {
      const res = await apiFetch(path, { method: "POST" });
      return await res.json();
    } catch {
      return { success: false, error: "Couldn't reach the server." };
    } finally {
      setBusy(false);
    }
  };

  const link = async () => {
    const data = await post("/api/telegram/link");
    if (data?.success && typeof data.url === "string") setUrl(data.url);
    else setNote(data?.error || "The server didn't take it.");
  };
  const test = async () => {
    const data = await post("/api/telegram/test");
    setNote(data?.success ? "Sent: look in Telegram." : data?.error || "Telegram didn't take it.");
    if (!data?.success) void load();
  };
  const unlink = async () => {
    await post("/api/telegram/unlink");
    await load();
  };

  return { state, url, busy, note, link, test, unlink };
}
