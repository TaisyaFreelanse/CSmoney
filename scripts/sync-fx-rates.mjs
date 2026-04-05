/**
 * Cron: calls /api/fx-rates/sync on the deployed app (one ExchangeRate-API request if due).
 * Env: APP_URL, CRON_SECRET (same as price sync).
 */

const APP_URL = process.env.APP_URL;
const CRON_SECRET = process.env.CRON_SECRET;

if (!APP_URL || !CRON_SECRET) {
  console.error("[sync-fx-rates] Missing APP_URL or CRON_SECRET");
  process.exit(1);
}

const url = `${APP_URL.replace(/\/$/, "")}/api/fx-rates/sync?token=${encodeURIComponent(CRON_SECRET)}`;
console.log("[sync-fx-rates] Calling fx-rates/sync ...");

try {
  const res = await fetch(url);
  const text = await res.text();
  console.log(`[sync-fx-rates] Status: ${res.status}`);
  console.log(`[sync-fx-rates] Response: ${text}`);
  if (!res.ok) process.exit(1);
} catch (err) {
  console.error("[sync-fx-rates] Error:", err);
  process.exit(1);
}
