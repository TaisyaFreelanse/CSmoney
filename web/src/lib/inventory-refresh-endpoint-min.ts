import "server-only";

/** Minimum wall time between POST /api/inventory/refresh (side "my") for the same user — in-memory only. */
export const INVENTORY_REFRESH_POST_MIN_MS = 15 * 60 * 1000;

const g = globalThis as unknown as { __invRefreshPostAt?: Map<string, number> };

function lastPostMap(): Map<string, number> {
  if (!g.__invRefreshPostAt) g.__invRefreshPostAt = new Map();
  return g.__invRefreshPostAt;
}

export function refreshPostMinRemainingMs(steamId: string): number {
  const last = lastPostMap().get(steamId) ?? 0;
  return Math.max(0, INVENTORY_REFRESH_POST_MIN_MS - (Date.now() - last));
}

export function markInventoryRefreshPost(steamId: string): void {
  lastPostMap().set(steamId, Date.now());
}
