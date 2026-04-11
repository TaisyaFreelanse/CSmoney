/**
 * Pure Steam Community URL / SteamID helpers — safe for Client Components.
 * (Keep Node-only inventory fetch in steam-inventory.ts.)
 */

const TRADE_URL_RE =
  /steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)&token=([A-Za-z0-9_-]+)/;

const TRADE_TOKEN_PARAM_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Parse Steam trade-offer URL. Accepts canonical `?partner=&token=` order from the regex,
 * or any query order via URL (e.g. `?token=…&partner=…`).
 */
export function parseTradeUrl(url: string): { partner: string; token: string } | null {
  const trimmed = url.trim();
  const m = TRADE_URL_RE.exec(trimmed);
  if (m) return { partner: m[1], token: m[2] };
  try {
    const href = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const u = new URL(href);
    if (!u.hostname.toLowerCase().endsWith("steamcommunity.com")) return null;
    if (!u.pathname.replace(/\/$/, "").endsWith("/tradeoffer/new")) return null;
    const partner = u.searchParams.get("partner");
    const token = u.searchParams.get("token");
    if (!partner || !/^\d+$/.test(partner) || !token || !TRADE_TOKEN_PARAM_RE.test(token)) return null;
    return { partner, token };
  } catch {
    return null;
  }
}

/** Та же trade-ссылка (partner + token), даже если строка отличается (пробелы, порядок query). */
export function tradeOfferUrlsEquivalent(stored: string | null | undefined, incoming: string): boolean {
  const a = (stored ?? "").trim();
  const b = incoming.trim();
  if (a === b) return true;
  const pa = a.length > 0 ? parseTradeUrl(a) : null;
  const pb = parseTradeUrl(b);
  return !!(pa && pb && pa.partner === pb.partner && pa.token === pb.token);
}

const STEAM64_OFFSET = BigInt("76561197960265728");

/**
 * Единый SteamID64 для кэша и сравнений: если в БД/сессии лежит account id (меньше оффсета), конвертируем.
 * Trade URL `partner` → steam64 через trySteamId64FromPartner уже даёт 64-bit строку.
 */
export function normalizeSteamId64ForCache(raw: string): string {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return t;
  try {
    const n = BigInt(t);
    if (n < STEAM64_OFFSET) {
      return (n + STEAM64_OFFSET).toString();
    }
    return t;
  } catch {
    return t;
  }
}

export function steamId64FromPartner(partner: string): string {
  return (BigInt(partner) + STEAM64_OFFSET).toString();
}

/** Safe variant for request handlers; returns null if `partner` is not a valid account id. */
export function trySteamId64FromPartner(partner: string): string | null {
  const p = partner.trim();
  if (!/^\d+$/.test(p)) return null;
  try {
    return (BigInt(p) + STEAM64_OFFSET).toString();
  } catch {
    return null;
  }
}
