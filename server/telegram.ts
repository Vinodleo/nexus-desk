import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fetchWithTimeout } from "./http";

// Every pop-up in Telegram too (owner's ask), so one missed on the phone
// still arrives: push.ts sends each one here as well, to the chat the user
// linked. The bot is the owner's own, made with Telegram's @BotFather; its
// token is a Fly secret (TELEGRAM_BOT_TOKEN, docs/hosting.md).
//
// Linking (Settings → Connections → Telegram): the app opens the bot with a
// one-time code (t.me/<bot>?start=<code>, good for 10 minutes); the server
// reads the bot's messages (getUpdates) only while a code waits, and keeps
// the private chat that sent it for that user (telegram.json). A chat that
// blocks the bot is forgotten; linking again brings it back.

const API = "https://api.telegram.org";
const DATA_DIR = () => process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const FILE = () => path.join(DATA_DIR(), "telegram.json");
/** How long a link code waits for its /start. */
export const LINK_TTL_MS = 10 * 60 * 1000;
/** Each read of the bot's messages waits this long for one (Telegram's long polling). */
const POLL_SECONDS = 25;
/** A send Telegram asks to wait for (too many at once) is tried once more after at most this. */
const MAX_RETRY_WAIT_MS = 30_000;

interface Linked {
  chatId: number;
  linkedAt: number;
}

export interface TelegramMessage {
  title: string;
  body: string;
}

class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterS?: number
  ) {
    super(message);
  }
}

let chats: Record<string, Linked> | null = null;
const codes = new Map<string, { uid: string; expires: number }>();
let polling = false;
let offset = 0;
let botName: string | null = null;
/** Sends go one at a time, so a burst (several trades closing in one check) doesn't trip Telegram's limits. */
let queue: Promise<unknown> = Promise.resolve();
let wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const token = () => process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
/** Whether the server has a bot to send with. */
export const telegramConfigured = () => token() !== "";

function linkedChats(): Record<string, Linked> {
  if (chats) return chats;
  try {
    chats = fs.existsSync(FILE()) ? JSON.parse(fs.readFileSync(FILE(), "utf8")) : {};
  } catch {
    chats = {};
  }
  return chats!;
}

function save(): void {
  try {
    fs.mkdirSync(DATA_DIR(), { recursive: true });
    fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(linkedChats()), "utf8");
    fs.renameSync(`${FILE()}.tmp`, FILE());
  } catch (err) {
    console.warn("[Telegram] Couldn't save the linked chats:", err);
  }
}

/** One Bot API call (the token stays out of every message). */
async function call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${API}/bot${token()}/${method}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) },
      timeoutMs
    );
  } catch (err: any) {
    throw new TelegramError(err?.name === "TimeoutError" ? "no reply" : "couldn't reach Telegram", 0);
  }
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new TelegramError(String(data?.description ?? `HTTP ${res.status}`), res.status, data?.parameters?.retry_after);
  return data.result;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A pop-up as a Telegram message: its title in bold, its lines, and a link to
 * the desk when the server knows its address (APP_URL).
 */
export function telegramText(message: TelegramMessage, appUrl = process.env.APP_URL ?? ""): string {
  const link = /^https:\/\/[^\s"<>]+$/.test(appUrl) ? `\n<a href="${escapeHtml(appUrl)}">Open Nexus Desk ›</a>` : "";
  return `<b>${escapeHtml(message.title)}</b>\n${escapeHtml(message.body)}${link}`;
}

/** Users with a linked chat (server-wide news goes to them too). */
export function telegramUsers(): string[] {
  return telegramConfigured() ? Object.keys(linkedChats()) : [];
}

/** Sends a pop-up's title and text to the user's linked chat. True when Telegram took it. */
export function sendTelegram(uid: string | undefined, message: TelegramMessage): Promise<boolean> {
  const chat = uid && telegramConfigured() ? linkedChats()[uid] : undefined;
  if (!uid || !chat) return Promise.resolve(false);
  const params = { chat_id: chat.chatId, text: telegramText(message), parse_mode: "HTML", disable_web_page_preview: true };
  const send = async (): Promise<boolean> => {
    try {
      try {
        await call("sendMessage", params);
      } catch (err) {
        // Too many at once: Telegram says how long to wait; one more try after it.
        if (!(err instanceof TelegramError) || err.status !== 429) throw err;
        await wait(Math.min(MAX_RETRY_WAIT_MS, (err.retryAfterS ?? 1) * 1000));
        await call("sendMessage", params);
      }
      return true;
    } catch (err: any) {
      // The bot was blocked or the chat deleted: forgotten until linked again.
      if (err instanceof TelegramError && err.status === 403) unlinkTelegram(uid);
      else console.warn(`[Telegram] Couldn't send to ${uid}: ${err?.message ?? err}`);
      return false;
    }
  };
  const sent = queue.then(send, send);
  queue = sent;
  return sent;
}

/** Whether a link code is still waiting for its /start. */
const waiting = (now: number) => [...codes.values()].some((c) => c.expires > now);

/** A message to the bot: "/start <code>" from a private chat links that chat to the code's user. */
export function handleTelegramUpdate(update: any, now = Date.now()): void {
  const message = update?.message;
  const match = typeof message?.text === "string" ? message.text.match(/^\/start\s+([A-Za-z0-9_-]+)\s*$/) : null;
  if (!match || message?.chat?.type !== "private" || typeof message.chat.id !== "number") return;
  const wanted = codes.get(match[1]);
  if (!wanted || wanted.expires <= now) return;
  codes.delete(match[1]);
  linkedChats()[wanted.uid] = { chatId: message.chat.id, linkedAt: now };
  save();
  void sendTelegram(wanted.uid, { title: "Nexus Desk is linked", body: "Every pop-up the desk sends will come here too: trades opened and closed, and its warnings." });
}

/** Reads the bot's messages while a link code waits (a long poll each time), then stops. */
async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    while (telegramConfigured() && waiting(Date.now())) {
      let updates: any[];
      try {
        updates = await call("getUpdates", { offset, timeout: POLL_SECONDS, allowed_updates: ["message"] }, (POLL_SECONDS + 10) * 1000);
      } catch (err: any) {
        console.warn(`[Telegram] Couldn't read the bot's messages: ${err?.message ?? err}`);
        await wait(5000);
        continue;
      }
      for (const update of Array.isArray(updates) ? updates : []) {
        if (typeof update?.update_id === "number") offset = Math.max(offset, update.update_id + 1);
        handleTelegramUpdate(update);
      }
    }
  } finally {
    polling = false;
  }
}

/** A link for the user to open in Telegram: the bot, with a one-time code that links their chat when they tap Start. */
export async function startTelegramLink(uid: string, now = Date.now()): Promise<{ url: string } | { error: string }> {
  if (!telegramConfigured()) return { error: "No bot yet: set TELEGRAM_BOT_TOKEN on the server (docs/hosting.md)." };
  try {
    botName ??= String((await call("getMe", {})).username);
  } catch (err: any) {
    return { error: `Telegram didn't answer: ${err?.message ?? err}` };
  }
  for (const [code, c] of codes) if (c.uid === uid || c.expires <= now) codes.delete(code);
  const code = crypto.randomBytes(12).toString("hex");
  codes.set(code, { uid, expires: now + LINK_TTL_MS });
  void poll();
  return { url: `https://t.me/${botName}?start=${code}` };
}

export function unlinkTelegram(uid: string): void {
  if (!linkedChats()[uid]) return;
  delete linkedChats()[uid];
  save();
}

/** What Settings shows: a bot set up, this user's chat linked, a link waiting for its Start. */
export function telegramStatus(uid: string, now = Date.now()): { configured: boolean; linked: boolean; linking: boolean } {
  const configured = telegramConfigured();
  return {
    configured,
    linked: configured && !!linkedChats()[uid],
    linking: configured && [...codes.values()].some((c) => c.uid === uid && c.expires > now),
  };
}

/** Test hooks. */
export function _resetTelegram(opts: { wait?: (ms: number) => Promise<void> } = {}): void {
  chats = null;
  codes.clear();
  polling = false;
  offset = 0;
  botName = null;
  queue = Promise.resolve();
  wait = opts.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}
export const _linkCodes = () => [...codes.keys()];
