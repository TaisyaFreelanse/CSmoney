/**
 * Cron script: calls /api/prices/sync on the deployed app.
 * Requires APP_URL and CRON_SECRET env vars.
 *
 * Price sync can run several minutes; the API streams JSON so headers return quickly.
 * Long timeout covers slow body / cold starts (Node 18+ AbortSignal.timeout).
 */

const APP_URL = process.env.APP_URL;
const CRON_SECRET = process.env.CRON_SECRET;

if (!APP_URL || !CRON_SECRET) {
  console.error("Missing APP_URL or CRON_SECRET env vars");
  process.exit(1);
}

const base = APP_URL.replace(/\/$/, "");

/** @param {string} url */
async function fetchWithLongDeadline(url) {
  const ac = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(600_000) : undefined;
  return fetch(url, ac ? { signal: ac } : {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry Cloudflare / origin 502–504 (cold start, deploy, overload). */
async function fetchOkWithRetries(label, url, { acceptStatuses = [] } = {}) {
  const maxAttempts = Math.min(8, Math.max(1, parseInt(process.env.SYNC_PRICES_MAX_ATTEMPTS ?? "5", 10) || 5));
  /** @type {Response | null} */
  let lastRes = null;
  let lastBody = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetchWithLongDeadline(url);
    lastRes = res;
    lastBody = await res.text();
    if (res.ok) return { res, data: lastBody };
    if (acceptStatuses.includes(res.status)) return { res, data: lastBody };
    const retryable = res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429;
    if (retryable && attempt < maxAttempts) {
      const wait = Math.min(120_000, 5000 * 2 ** (attempt - 1));
      console.warn(`[${label}] HTTP ${res.status}, retry ${attempt}/${maxAttempts} in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    return { res, data: lastBody };
  }
  return { res: lastRes ?? new Response("", { status: 599 }), data: lastBody };
}

try {
  const url = `${base}/api/prices/sync?token=${encodeURIComponent(CRON_SECRET)}`;
  console.log(`[sync-prices] Calling ${base}/api/prices/sync ...`);
  const { res, data } = await fetchOkWithRetries("sync-prices", url);
  console.log(`[sync-prices] Status: ${res.status}`);
  console.log(`[sync-prices] Response: ${data.slice(0, 500)}${data.length > 500 ? "…" : ""}`);
  if (!res.ok) process.exit(1);

  // FX: same cron; server skips ExchangeRate-API if data is fresh (FX_RATES_MIN_SYNC_INTERVAL_HOURS, default 20h).
  const fxUrl = `${base}/api/fx-rates/sync?token=${encodeURIComponent(CRON_SECRET)}`;
  console.log(`[sync-fx-rates] Calling ${base}/api/fx-rates/sync ...`);
  const { res: fxRes, data: fxBody } = await fetchOkWithRetries("sync-fx-rates", fxUrl, { acceptStatuses: [503] });
  console.log(`[sync-fx-rates] Status: ${fxRes.status}`);
  console.log(`[sync-fx-rates] Response: ${fxBody.slice(0, 500)}${fxBody.length > 500 ? "…" : ""}`);
  // 503 = EXCHANGE_RATE_API_KEY not set yet — do not fail price sync
  if (!fxRes.ok && fxRes.status !== 503) process.exit(1);
} catch (err) {
  console.error("[sync-prices] Error:", err);
  process.exit(1);
}
