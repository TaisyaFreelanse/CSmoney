import "server-only";

/** Rolling window for puppeteer_success_rate (1h). */
const WINDOW_MS = 60 * 60 * 1000;

type Row = { t: number; ok: boolean };
const ownerRows: Row[] = [];
const guestRows: Row[] = [];

/**
 * Call once per завершённый `fetchGuestInventoryViaTradeOfferPuppeteer` / owner wrapper.
 * Пишет JSON-метрику `puppeteer_success_rate` для дашбордов / логов.
 */
export function recordTradeOfferPuppeteerOutcome(profile: "owner" | "guest", ok: boolean): void {
  const now = Date.now();
  const arr = profile === "owner" ? ownerRows : guestRows;
  arr.push({ t: now, ok });
  while (arr.length > 0 && arr[0]!.t < now - WINDOW_MS) {
    arr.shift();
  }
  const attempts = arr.length;
  const successes = arr.filter((r) => r.ok).length;
  const puppeteer_success_rate = attempts === 0 ? 1 : Math.round((successes / attempts) * 1000) / 1000;
  console.log(
    JSON.stringify({
      type: "puppeteer_metrics",
      profile,
      puppeteer_success_rate,
      attempts_window_1h: attempts,
      successes_window_1h: successes,
      window_ms: WINDOW_MS,
      last_ok: ok,
      ts: now,
    }),
  );
}
