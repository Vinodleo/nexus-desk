import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import express from "express";
import { afterAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// Every pop-up in Telegram too: the owner's bot (TELEGRAM_BOT_TOKEN), their
// chat linked from Settings with a one-time code, each pop-up sent there as
// well as to the phone.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-telegram-"));
vi.stubEnv("NEXUS_DATA_DIR", dataDir);
// The routes' own requests go out through the real fetch; Telegram's to the stub.
const realFetch = globalThis.fetch;

const telegram = await import("../../server/telegram");
const push = await import("../../server/push");

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const TOKEN = "123456:SECRET-token";
let calls: { method: string; params: any }[];
let replies: Record<string, (params: any) => any>;
let waits: number[];
let warn: MockInstance;
const ok = (result: unknown) => ({ ok: true, result });
const sends = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.params);
const codeOf = (url: string) => new URL(url).searchParams.get("start")!;
const start = (code: string, chat: { id: number; type: string } = { id: 4242, type: "private" }) => ({ update_id: 7, message: { text: `/start ${code}`, chat } });

beforeEach(() => {
  calls = [];
  waits = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
  telegram._resetTelegram({ wait: async (ms) => void waits.push(ms) });
  push._resetPush();
  fs.rmSync(path.join(dataDir, "telegram.json"), { force: true });
  fs.rmSync(path.join(dataDir, "push_subscriptions.json"), { force: true });
  replies = {
    getMe: () => ok({ username: "nexus_desk_bot" }),
    sendMessage: () => ok({}),
    // A long poll with nothing new.
    getUpdates: () => new Promise((resolve) => setTimeout(() => resolve(ok([])), 5)),
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).startsWith("http://127.0.0.1")) return realFetch(url, init);
    const m = String(url).match(/^https:\/\/api\.telegram\.org\/bot(.+)\/(\w+)$/);
    if (!m || m[1] !== TOKEN) throw new Error(`unexpected ${url}`);
    const params = JSON.parse(String(init.body));
    calls.push({ method: m[2], params });
    const body = await replies[m[2]](params);
    return new Response(JSON.stringify(body), { status: body.ok ? 200 : body.error_code });
  });
});

describe("linking Telegram", () => {
  it("links the chat that taps Start with the one-time code, and every pop-up goes there too", async () => {
    let code = "";
    replies.getUpdates = () => new Promise((resolve) => setTimeout(() => resolve(ok(code ? [start(code)] : [])), 5));
    const got = await telegram.startTelegramLink("u1");
    if (!("url" in got)) throw new Error(got.error);
    expect(got.url).toMatch(/^https:\/\/t\.me\/nexus_desk_bot\?start=[0-9a-f]{24}$/);
    code = codeOf(got.url);
    expect(telegram.telegramStatus("u1")).toEqual({ configured: true, linked: false, linking: true });

    await vi.waitFor(() => expect(telegram.telegramStatus("u1").linked).toBe(true));
    expect(telegram.telegramStatus("u1").linking).toBe(false);
    expect(telegram._linkCodes()).toEqual([]);
    // It said so in the chat, and reads no more of the bot's messages.
    await vi.waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0]).toMatchObject({ chat_id: 4242, text: expect.stringContaining("Nexus Desk is linked") });
    const reads = calls.filter((c) => c.method === "getUpdates").length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.filter((c) => c.method === "getUpdates").length).toBe(reads);

    // A pop-up reaches it with no phone subscribed, its text kept as written.
    expect(await push.notifyUser("u1", { title: "Bought SOL <breakout>", body: "Stop ₹180 & no target" })).toBe(1);
    expect(sends()[1]).toEqual({ chat_id: 4242, text: "<b>Bought SOL &lt;breakout&gt;</b>\nStop ₹180 &amp; no target", parse_mode: "HTML", disable_web_page_preview: true });
    // Server-wide news (a failed backup) too.
    expect(await push.notifyEveryone({ title: "Backup failed", body: "The daily backup didn't upload." })).toBe(1);
    expect(sends()[2].text).toContain("Backup failed");
    // Kept on the volume: a restart still knows the chat.
    telegram._resetTelegram();
    expect(telegram.telegramStatus("u1").linked).toBe(true);
    // Unlinked from Settings: nothing more goes there.
    telegram.unlinkTelegram("u1");
    expect(await push.notifyUser("u1", { title: "Sold", body: "" })).toBe(0);
    expect(sends()).toHaveLength(3);
  });

  it("links only its own code, from a private chat, before it expires", async () => {
    const old = await telegram.startTelegramLink("u1", 1000);
    if (!("url" in old)) throw new Error(old.error);
    const late = 1000 + telegram.LINK_TTL_MS + 1;
    telegram.handleTelegramUpdate(start(codeOf(old.url)), late);
    expect(telegram.telegramStatus("u1").linked).toBe(false);

    const got = await telegram.startTelegramLink("u1");
    if (!("url" in got)) throw new Error(got.error);
    // A new link replaces the old code.
    expect(telegram._linkCodes()).toEqual([codeOf(got.url)]);
    telegram.handleTelegramUpdate(start("someone-elses-code"));
    telegram.handleTelegramUpdate(start(codeOf(got.url), { id: -100, type: "group" }));
    expect(telegram.telegramStatus("u1").linked).toBe(false);
    telegram.handleTelegramUpdate(start(codeOf(got.url)));
    expect(telegram.telegramStatus("u1").linked).toBe(true);
    // Used once.
    expect(telegram._linkCodes()).toEqual([]);
  });

  it("waits when Telegram says too many at once, and forgets a chat that blocked the bot", async () => {
    const got = await telegram.startTelegramLink("u1");
    if (!("url" in got)) throw new Error(got.error);
    telegram.handleTelegramUpdate(start(codeOf(got.url)));
    await vi.waitFor(() => expect(sends()).toHaveLength(1));

    let busy = true;
    replies.sendMessage = () => (busy ? ((busy = false), { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }) : ok({}));
    expect(await telegram.sendTelegram("u1", { title: "Bought ETH", body: "" })).toBe(true);
    expect(waits).toEqual([3000]);

    // Telegram down: not sent, said in the log without the bot's token.
    replies.sendMessage = () => ({ ok: false, error_code: 502, description: "Bad Gateway" });
    expect(await telegram.sendTelegram("u1", { title: "Sold ETH", body: "" })).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    expect(telegram.telegramStatus("u1").linked).toBe(true);

    replies.sendMessage = () => ({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
    expect(await telegram.sendTelegram("u1", { title: "Sold BTC", body: "" })).toBe(false);
    expect(telegram.telegramStatus("u1").linked).toBe(false);
  });

  it("sends nothing without a bot on the server", async () => {
    fs.writeFileSync(path.join(dataDir, "telegram.json"), JSON.stringify({ u1: { chatId: 4242, linkedAt: 0 } }));
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    telegram._resetTelegram();
    expect(telegram.telegramStatus("u1")).toEqual({ configured: false, linked: false, linking: false });
    expect(await telegram.startTelegramLink("u1")).toEqual({ error: expect.stringContaining("TELEGRAM_BOT_TOKEN") });
    expect(await push.notifyUser("u1", { title: "Bought SOL", body: "" })).toBe(0);
    expect(await push.notifyEveryone({ title: "Backup failed", body: "" })).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("Telegram's routes", () => {
  it("say its state, give a link, send a test and unlink, for the signed-in user", async () => {
    const { router } = await import("../../server/routes/telegram");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { uid: "u1" };
      next();
    });
    app.use(router);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (p: string, method = "GET") => (await fetch(`${base}${p}`, { method })).json();
    try {
      expect(await get("/api/telegram")).toEqual({ success: true, configured: true, linked: false, linking: false });
      expect(await get("/api/telegram/test", "POST")).toMatchObject({ success: false, error: expect.stringContaining("Link it") });
      const link = await get("/api/telegram/link", "POST");
      expect(link).toMatchObject({ success: true, url: expect.stringContaining("t.me/nexus_desk_bot?start=") });
      expect(await get("/api/telegram")).toMatchObject({ linking: true });
      telegram.handleTelegramUpdate(start(codeOf(link.url)));
      expect(await get("/api/telegram")).toMatchObject({ linked: true, linking: false });
      expect(await get("/api/telegram/test", "POST")).toEqual({ success: true });
      expect(sends().at(-1)!.text).toContain("Test from Nexus Desk");
      expect(await get("/api/telegram/unlink", "POST")).toEqual({ success: true });
      expect(await get("/api/telegram")).toMatchObject({ linked: false });
    } finally {
      server.close();
    }
  });
});
