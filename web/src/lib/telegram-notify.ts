/**
 * Admin Telegram notifications via Bot API.
 * Configure TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_ID (chat id). Disabled if unset.
 */

import type { ChatMessage, Trade, TradeItem, User } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const LOG = "[telegram-notify]";

function getConfig(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_ADMIN_ID?.trim() ?? process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

function siteBaseUrl(): string | null {
  const u = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  return u && u.length > 0 ? u : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatUsdFromItem(priceUsd: unknown, quantity: number): string {
  const n = Number(priceUsd);
  if (!Number.isFinite(n)) return "?";
  const total = n * Math.max(1, quantity);
  return total.toFixed(2);
}

function linesForSide(items: TradeItem[], side: "guest" | "owner"): string {
  const rows = items.filter((i) => i.side === side);
  if (rows.length === 0) return "— <i>(none)</i>";
  return rows
    .map((it) => {
      const name = escapeHtml(it.displayName ?? it.marketHashName ?? "Item");
      const q = it.quantity > 1 ? ` ×${it.quantity}` : "";
      return `— ${name}${q} ($${formatUsdFromItem(it.priceUsd, it.quantity)})`;
    })
    .join("\n");
}

function guestOwnerTotalsCents(items: TradeItem[]): { guestCents: number; ownerCents: number } {
  let guestCents = 0;
  let ownerCents = 0;
  for (const it of items) {
    const dollars = Number(it.priceUsd);
    if (!Number.isFinite(dollars)) continue;
    const cents = Math.round(dollars * 100) * Math.max(1, it.quantity);
    if (it.side === "guest") guestCents += cents;
    else ownerCents += cents;
  }
  return { guestCents, ownerCents };
}

async function sendTelegramMessage(payload: {
  text: string;
  replyMarkup?: { inline_keyboard: { text: string; url: string }[][] };
}): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg) return false;

  const body: Record<string, unknown> = {
    chat_id: cfg.chatId,
    text: payload.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (payload.replyMarkup) {
    body.reply_markup = payload.replyMarkup;
  }

  try {
    const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!res.ok || !data?.ok) {
      console.error(LOG, "sendMessage failed", res.status, data?.description ?? data);
      return false;
    }
    console.log(LOG, "message delivered");
    return true;
  } catch (e) {
    console.error(LOG, "sendMessage error", e);
    return false;
  }
}

/**
 * Sends one notification per dedupeKey; skips if key already recorded or Telegram disabled.
 */
export async function tryNotifyTelegramDeduped(
  dedupeKey: string,
  build: () => { text: string; replyMarkup?: { inline_keyboard: { text: string; url: string }[][] } },
): Promise<void> {
  if (!getConfig()) return;

  try {
    const exists = await prisma.telegramNotifyDedupe.findUnique({ where: { dedupeKey } });
    if (exists) {
      console.log(LOG, "dedupe skip", dedupeKey);
      return;
    }

    const { text, replyMarkup } = build();
    const ok = await sendTelegramMessage({ text, replyMarkup });
    if (!ok) return;

    await prisma.telegramNotifyDedupe.create({ data: { dedupeKey } });
  } catch (e) {
    console.error(LOG, "tryNotifyTelegramDeduped", dedupeKey, e);
  }
}

/** Fire-and-forget: does not block the HTTP handler. */
export function queueTelegramNewTrade(trade: Trade & { items: TradeItem[] }, creator: Pick<User, "steamId" | "displayName">): void {
  void tryNotifyTelegramDeduped(`trade:${trade.id}`, () => {
    const who = escapeHtml(creator.displayName ?? creator.steamId);
    const steam = escapeHtml(creator.steamId);
    const { guestCents, ownerCents } = guestOwnerTotalsCents(trade.items);
    const give = linesForSide(trade.items, "guest");
    const recv = linesForSide(trade.items, "owner");
    const base = siteBaseUrl();
    const replyMarkup =
      base != null
        ? {
            inline_keyboard: [
              [{ text: "Open trade", url: `${base}/trades/${encodeURIComponent(trade.id)}` }],
            ],
          }
        : undefined;

    const text = [
      "<b>🆕 New Trade</b>",
      "",
      `<b>User:</b> ${who} <code>${steam}</code>`,
      "",
      "<b>Give:</b>",
      give,
      "",
      "<b>Receive:</b>",
      recv,
      "",
      `<b>Totals:</b> give $${(guestCents / 100).toFixed(2)} · receive $${(ownerCents / 100).toFixed(2)}`,
    ].join("\n");

    return { text, replyMarkup };
  });
}

export function queueTelegramNewUser(user: Pick<User, "steamId" | "displayName">): void {
  void tryNotifyTelegramDeduped(`user:new:${user.steamId}`, () => {
    const who = escapeHtml(user.displayName ?? user.steamId);
    const steam = escapeHtml(user.steamId);
    const text = ["<b>📥 New User</b>", "", `<b>User:</b> ${who} <code>${steam}</code>`].join("\n");
    return { text };
  });
}

export function queueTelegramSupportUserMessage(
  user: Pick<User, "steamId" | "displayName">,
  msg: Pick<ChatMessage, "id" | "text">,
): void {
  void tryNotifyTelegramDeduped(`chatmsg:${msg.id}`, () => {
    const who = escapeHtml(user.displayName ?? user.steamId);
    const steam = escapeHtml(user.steamId);
    const raw = msg.text.length > 3000 ? `${msg.text.slice(0, 2997)}…` : msg.text;
    const body = escapeHtml(raw);
    const text = [
      "<b>💬 New Support Message</b>",
      "",
      `<b>User:</b> ${who} <code>${steam}</code>`,
      "",
      `<b>Message:</b>`,
      body,
    ].join("\n");
    return { text };
  });
}
