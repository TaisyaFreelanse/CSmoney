/**
 * Simple in-memory inventory cache with configurable TTL
 * and per-user refresh rate limiting.
 */

import type { NormalizedItem } from "./steam-inventory";

interface CacheEntry {
  items: NormalizedItem[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const lastRefresh = new Map<string, number>();

const DEFAULT_TTL_MS = 3 * 60 * 1000; // 3 minutes
const REFRESH_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between manual refreshes

export function getCached(steamId: string): NormalizedItem[] | null {
  const entry = cache.get(steamId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > DEFAULT_TTL_MS) {
    cache.delete(steamId);
    return null;
  }
  return entry.items;
}

export function setCache(steamId: string, items: NormalizedItem[]) {
  cache.set(steamId, { items, fetchedAt: Date.now() });
}

export function invalidateCache(steamId: string) {
  cache.delete(steamId);
}

/** Returns remaining cooldown in ms, or 0 if refresh is allowed. */
export function refreshCooldownRemaining(steamId: string): number {
  const last = lastRefresh.get(steamId);
  if (!last) return 0;
  const elapsed = Date.now() - last;
  return Math.max(0, REFRESH_COOLDOWN_MS - elapsed);
}

export function markRefreshed(steamId: string) {
  lastRefresh.set(steamId, Date.now());
}
