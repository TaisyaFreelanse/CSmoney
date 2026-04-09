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

try {
  const url = `${base}/api/prices/sync?token=${encodeURIComponent(CRON_SECRET)}`;
  console.log(`[sync-prices] Calling ${base}/api/prices/sync ...`);
  const res = await fetchWithLongDeadline(url);
  const data = await res.text();
  console.log(`[sync-prices] Status: ${res.status}`);
  console.log(`[sync-prices] Response: ${data}`);
  if (!res.ok) process.exit(1);

  // FX: same cron; server skips ExchangeRate-API if data is fresh (FX_RATES_MIN_SYNC_INTERVAL_HOURS, default 20h).
  const fxUrl = `${base}/api/fx-rates/sync?token=${encodeURIComponent(CRON_SECRET)}`;
  console.log(`[sync-fx-rates] Calling ${base}/api/fx-rates/sync ...`);
  const fxRes = await fetchWithLongDeadline(fxUrl);
  const fxBody = await fxRes.text();
  console.log(`[sync-fx-rates] Status: ${fxRes.status}`);
  console.log(`[sync-fx-rates] Response: ${fxBody}`);
  // 503 = EXCHANGE_RATE_API_KEY not set yet — do not fail price sync
  if (!fxRes.ok && fxRes.status !== 503) process.exit(1);
} catch (err) {
  console.error("[sync-prices] Error:", err);
  process.exit(1);
}
