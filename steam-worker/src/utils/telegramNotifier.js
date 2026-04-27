/**
 * Опциональные уведомления в Telegram (fetch). Не бросает в основной поток при ошибках API.
 * TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID — иначе no-op.
 */
import { logJson } from "./logger.js";

const COOLDOWN_MS = Math.min(
  1_800_000,
  Math.max(60_000, Number(process.env.TELEGRAM_NOTIFY_COOLDOWN_MS) || 480_000),
);
const PROXY_STREAK = Math.min(20, Math.max(1, Number(process.env.TELEGRAM_PROXY_ERROR_STREAK) || 3));
const PUPPETEER_STREAK = Math.min(30, Math.max(1, Number(process.env.TELEGRAM_PUPPETEER_ERROR_STREAK) || 4));

/** @type {Map<string, number>} */
const lastNotifyAt = new Map();
/** @type {Map<string, number>} */
const proxyStreak = new Map();
/** @type {Map<string, number>} */
const puppeteerStreak = new Map();

function formatUtc(ts = Date.now()) {
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function canSend(accountId) {
  const prev = lastNotifyAt.get(accountId) ?? 0;
  return Date.now() - prev >= COOLDOWN_MS;
}

function markSent(accountId) {
  lastNotifyAt.set(accountId, Date.now());
}

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const ac = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15_000) : undefined;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      ...(ac ? { signal: ac } : {}),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      logJson("steam_worker_telegram_send_failed", {
        httpStatus: res.status,
        bodyPreview: body.slice(0, 400),
      });
      return false;
    }
    return true;
  } catch (e) {
    logJson("steam_worker_telegram_send_error", {
      message: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * @param {{ accountId: string; error: string; detail?: string | null }} p
 * @returns {Promise<boolean>} true если сообщение ушло в Telegram
 */
export async function notifySteamAccountIssue(p) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return false;

  const accountId = String(p.accountId ?? "").trim() || "unknown";
  if (!canSend(accountId)) return false;

  const detail = p.detail ? String(p.detail).trim().slice(0, 500) : "";
  const text = [
    "🚨 Steam account issue",
    "",
    `Account: ${accountId}`,
    `Error: ${p.error}`,
    detail ? `Detail: ${detail}` : null,
    `Time: ${formatUtc()}`,
  ]
    .filter(Boolean)
    .join("\n");
  const ok = await sendTelegram(text);
  if (ok) markSent(accountId);
  return ok;
}

/**
 * Сброс streak при успешном fetch; при proxy/puppeteer — счётчик и алерт после N подряд.
 * @param {string} accountId
 * @param {{
 *   ok: boolean;
 *   error?: string | null;
 *   sessionInvalid?: boolean;
 *   detail?: string | null;
 *   apiPrefetchError?: string | null;
 * }} outcome
 */
export function recordTradeFetchOutcome(accountId, outcome) {
  const id = String(accountId ?? "").trim();
  if (!id) return;

  if (outcome.ok) {
    proxyStreak.delete(id);
    puppeteerStreak.delete(id);
    return;
  }

  if (outcome.sessionInvalid) {
    proxyStreak.delete(id);
    puppeteerStreak.delete(id);
    return;
  }

  const err = outcome.error ?? null;
  if (err === "proxy_error") {
    puppeteerStreak.delete(id);
    const n = (proxyStreak.get(id) ?? 0) + 1;
    proxyStreak.set(id, n);
    if (n >= PROXY_STREAK) {
      const hasTg = !!(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim());
      if (!hasTg) {
        proxyStreak.set(id, 0);
        return;
      }
      const extra = [outcome.detail && `last: ${outcome.detail}`, outcome.apiPrefetchError && `api: ${outcome.apiPrefetchError}`]
        .filter(Boolean)
        .join(" | ");
      void notifySteamAccountIssue({
        accountId: id,
        error: "proxy_error",
        detail: [`streak ${n}/${PROXY_STREAK}`, extra || null].filter(Boolean).join("\n"),
      }).then((sent) => {
        if (sent) proxyStreak.set(id, 0);
        else proxyStreak.set(id, Math.max(1, PROXY_STREAK - 1));
      });
    }
    return;
  }

  if (err === "puppeteer_error") {
    proxyStreak.delete(id);
    const n = (puppeteerStreak.get(id) ?? 0) + 1;
    puppeteerStreak.set(id, n);
    if (n >= PUPPETEER_STREAK) {
      const hasTg = !!(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim());
      if (!hasTg) {
        puppeteerStreak.set(id, 0);
        return;
      }
      const lines = [`streak ${n}/${PUPPETEER_STREAK} (often Steam/proxy/tunnel, not a broken profile)`];
      if (outcome.detail) lines.push(`chromium: ${outcome.detail}`);
      if (outcome.apiPrefetchError) lines.push(`inventory_api: ${outcome.apiPrefetchError}`);
      void notifySteamAccountIssue({
        accountId: id,
        error: "puppeteer_error",
        detail: lines.join("\n"),
      }).then((sent) => {
        if (sent) puppeteerStreak.set(id, 0);
        else puppeteerStreak.set(id, Math.max(1, PUPPETEER_STREAK - 1));
      });
    }
    return;
  }

  proxyStreak.delete(id);
  puppeteerStreak.delete(id);
}
