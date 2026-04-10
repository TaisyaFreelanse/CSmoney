import "server-only";

import { normalizeSteamId64ForCache } from "@/lib/steam-inventory";

/** Min interval between GET /api/inventory/me guest hits that may trigger Steam (soft cap; cache served when faster). */
export const INVENTORY_ME_SOFT_INTERVAL_MS = 4000;

const g = globalThis as unknown as { __invMeGuestLastGet?: Map<string, number> };

function map(): Map<string, number> {
  if (!g.__invMeGuestLastGet) g.__invMeGuestLastGet = new Map();
  return g.__invMeGuestLastGet;
}

/** Milliseconds until another “fast” guest /me is allowed without forcing cache-only. */
export function inventoryMeGuestSoftRemainingMs(steamId: string): number {
  const id = normalizeSteamId64ForCache(steamId);
  const last = map().get(id) ?? 0;
  return Math.max(0, INVENTORY_ME_SOFT_INTERVAL_MS - (Date.now() - last));
}

export function markInventoryMeGuestGet(steamId: string): void {
  map().set(normalizeSteamId64ForCache(steamId), Date.now());
}
