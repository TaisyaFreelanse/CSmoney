const TRADE_URL_RE =
  /steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)&token=([A-Za-z0-9_-]+)/;

const STEAM64_OFFSET = BigInt("76561197960265728");

export function parseTradeUrl(url) {
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
    if (!partner || !/^\d+$/.test(partner) || !token || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    return { partner, token };
  } catch {
    return null;
  }
}

export function normalizeSteamId64(raw) {
  const t = String(raw).trim();
  if (!/^\d+$/.test(t)) return t;
  try {
    const n = BigInt(t);
    if (n < STEAM64_OFFSET) return (n + STEAM64_OFFSET).toString();
    return t;
  } catch {
    return t;
  }
}

export function steamId64FromPartner(partner) {
  return (BigInt(partner) + STEAM64_OFFSET).toString();
}

export function tradeUrlFromParsed(parsed) {
  return `https://steamcommunity.com/tradeoffer/new/?partner=${encodeURIComponent(parsed.partner)}&token=${encodeURIComponent(parsed.token)}`;
}
