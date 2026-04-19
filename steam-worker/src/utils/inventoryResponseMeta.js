/**
 * Stable `meta` object for GET /inventory JSON (Render / Hetzner integration).
 * Always attach to HTTP body so upstream proxies can rely on the shape.
 *
 * @param {{ cacheHit?: boolean; apiMeta?: object | null; tradeOutcome?: object | null }} p
 */
export function buildInventoryMetaV1(p = {}) {
  const { cacheHit = false, apiMeta = null, tradeOutcome = null } = p;
  const trade = tradeOutcome
    ? {
        ok: Boolean(tradeOutcome.ok),
        error: tradeOutcome.error ?? null,
        detail: tradeOutcome.detail ?? null,
        timedOut: Boolean(tradeOutcome.timedOut),
        sessionInvalid: Boolean(tradeOutcome.sessionInvalid),
        stats: tradeOutcome.tradeStats ?? null,
      }
    : null;

  return {
    schemaVersion: 1,
    cacheHit: Boolean(cacheHit),
    api: apiMeta && typeof apiMeta === "object" ? apiMeta : { attempted: false },
    trade,
  };
}
