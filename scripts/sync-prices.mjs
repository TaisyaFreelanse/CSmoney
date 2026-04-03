/**
 * Cron script: calls /api/prices/sync on the deployed app.
 * Requires APP_URL and CRON_SECRET env vars.
 */

const APP_URL = process.env.APP_URL;
const CRON_SECRET = process.env.CRON_SECRET;

if (!APP_URL || !CRON_SECRET) {
  console.error("Missing APP_URL or CRON_SECRET env vars");
  process.exit(1);
}

const url = `${APP_URL}/api/prices/sync?token=${CRON_SECRET}`;
console.log(`[sync-prices] Calling ${APP_URL}/api/prices/sync ...`);

try {
  const res = await fetch(url);
  const data = await res.text();
  console.log(`[sync-prices] Status: ${res.status}`);
  console.log(`[sync-prices] Response: ${data}`);
  if (!res.ok) process.exit(1);
} catch (err) {
  console.error("[sync-prices] Error:", err);
  process.exit(1);
}
