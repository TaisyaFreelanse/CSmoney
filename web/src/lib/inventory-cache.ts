/**
 * Simple in-memory inventory cache with configurable TTL.
 * Key = steamId, value = { items, fetchedAt }.
 */

import type { NormalizedItem } from "./steam-inventory";

interface CacheEntry {
  items: NormalizedItem[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

const DEFAULT_TTL_MS = 3 * 60 * 1000; // 3 minutes

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
