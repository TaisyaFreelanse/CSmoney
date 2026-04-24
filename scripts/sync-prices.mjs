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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const startDelayMs = Math.max(0, parseInt(process.env.SYNC_PRICES_START_DELAY_MS ?? "0", 10) || 0);
if (startDelayMs > 0) {
  console.log(`[sync-prices] SYNC_PRICES_START_DELAY_MS=${startDelayMs} (wait before first request, e.g. after deploy)`);
  await sleep(startDelayMs);
}

/** @param {string} url */
async function fetchWithLongDeadline(url) {
  const ac = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(600_000) : undefined;
  return fetch(url, ac ? { signal: ac } : {});
}

/** Render/Cloudflare sometimes return 200 with an HTML error page body. */
function looksLikeHtmlGatewayError(text) {
  const t = String(text ?? "").trim();
  if (!t || t[0] !== "<") return false;
  const head = t.slice(0, 12_000).toLowerCase();
  return (
    head.includes("<title>502</title>") ||
    head.includes("<title>503</title>") ||
    head.includes("<title>504</title>") ||
    head.includes("bad gateway") ||
    head.includes("service unavailable") ||
    head.includes("error code 502") ||
    head.includes("error code 503") ||
    (head.includes("cloudflare") && head.includes("error"))
  );
}

/** Retry Cloudflare / origin 502–504 (cold start, deploy, overload), HTML soft-502, and network errors. */
async function fetchOkWithRetries(label, url, { acceptStatuses = [] } = {}) {
  const maxAttempts = Math.min(10, Math.max(1, parseInt(process.env.SYNC_PRICES_MAX_ATTEMPTS ?? "6", 10) || 6));
  /** @type {Response | null} */
  let lastRes = null;
  let lastBody = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    /** @type {Response} */
    let res;
    try {
      res = await fetchWithLongDeadline(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < maxAttempts) {
        const wait = Math.min(120_000, 5000 * 2 ** (attempt - 1));
        console.warn(`[${label}] fetch error (${msg}), retry ${attempt}/${maxAttempts} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
    lastRes = res;
    lastBody = await res.text();
    const softGateway = res.ok && looksLikeHtmlGatewayError(lastBody);
    if (res.ok && !softGateway) return { res, data: lastBody };
    if (!res.ok && acceptStatuses.includes(res.status)) return { res, data: lastBody };
    const retryable =
      softGateway ||
      res.status === 502 ||
      res.status === 503 ||
      res.status === 504 ||
      res.status === 429;
    if (retryable && attempt < maxAttempts) {
      const wait = Math.min(120_000, 5000 * 2 ** (attempt - 1));
      const why = softGateway ? "HTML gateway/body" : `HTTP ${res.status}`;
      console.warn(`[${label}] ${why}, retry ${attempt}/${maxAttempts} in ${wait}ms`);
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
