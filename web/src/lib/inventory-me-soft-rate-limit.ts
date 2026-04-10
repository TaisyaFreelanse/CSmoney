import "server-only";

/** Min interval between GET /api/inventory/me guest hits that may trigger Steam (soft cap; cache served when faster). */
export const INVENTORY_ME_SOFT_INTERVAL_MS = 4000;

const g = globalThis as unknown as { __invMeGuestLastGet?: Map<string, number> };

function map(): Map<string, number> {
  if (!g.__invMeGuestLastGet) g.__invMeGuestLastGet = new Map();
  return g.__invMeGuestLastGet;
}

/** Milliseconds until another “fast” guest /me is allowed without forcing cache-only. */
export function inventoryMeGuestSoftRemainingMs(steamId: string): number {
  const last = map().get(steamId) ?? 0;
  return Math.max(0, INVENTORY_ME_SOFT_INTERVAL_MS - (Date.now() - last));
}

export function markInventoryMeGuestGet(steamId: string): void {
  map().set(steamId, Date.now());
}
