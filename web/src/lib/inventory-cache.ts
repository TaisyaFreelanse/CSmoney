/**
 * Inventory snapshot cache: Redis when REDIS_URL is set (shared across instances),
 * otherwise in-memory Map. Per-user refresh cooldowns use the same store.
 *
 * Logs: set INVENTORY_CACHE_LOG=1 (or true) on Render to trace GET/SET. In development,
 * logging is on unless INVENTORY_CACHE_LOG=0.
 */

import type { NormalizedItem } from "./steam-inventory";
import { normalizeSteamId64ForCache } from "./steam-inventory";
import { OWNER_REFRESH_COOLDOWN_MS, USER_REFRESH_COOLDOWN_MS } from "./inventory-refresh-limits";
import { getRedis } from "./redis-client";

interface CacheEntry {
  items: NormalizedItem[];
  fetchedAt: number;
}

const SNAPSHOT_PREFIX = "csmoney:inv:snapshot:";
const RL_OWNER_PREFIX = "csmoney:inv:rl:owner:";
const RL_USER_PREFIX = "csmoney:inv:rl:user:";
/** Extra cooldown after Steam “unstable” (browser double-fail); shorter than user refresh window. */
const RL_USER_SHORT_PREFIX = "csmoney:inv:rl:userShort:";

/** 7d TTL on snapshot keys (owner entries are refreshed by job; guests expire logically at 3m). */
const SNAPSHOT_MAX_TTL_SEC = 7 * 24 * 3600;

const memoryCache = new Map<string, CacheEntry>();
const lastOwnerRefresh = new Map<string, number>();
const lastUserRefresh = new Map<string, number>();
/** Memory fallback: epoch ms when short guest cooldown ends. */
const shortGuestCooldownUntil = new Map<string, number>();

/** Guest inventory snapshot kept for UI / trading until replaced (max age cap). */
export const GUEST_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const USER_SHORT_GUEST_COOLDOWN_MS = 15 * 60 * 1000;

/** Owner store: after this age, snapshot is "stale" (triggers background revalidation in API). */
export const OWNER_FRESH_TTL_MS = 3 * 60 * 1000;

function snapshotKey(steamId: string) {
  return `${SNAPSHOT_PREFIX}${steamId}`;
}

function inventoryCacheLogEnabled(): boolean {
  const e = process.env.INVENTORY_CACHE_LOG?.trim().toLowerCase();
  if (e === "1" || e === "true" || e === "on" || e === "yes") return true;
  if (e === "0" || e === "false" || e === "off" || e === "no") return false;
  return process.env.NODE_ENV === "development";
}

/** Structured cache trace (HIT/MISS/SET/DEL). Enable with INVENTORY_CACHE_LOG=1. */
export function invCacheLog(message: string): void {
  if (!inventoryCacheLogEnabled()) return;
  console.log(`[inv-cache] ${message}`);
}

/** Read snapshot at this exact key string (already canonical or legacy). */
async function readSnapshotAtKey(steamId: string, op: "guest-ttl" | "owner-swr"): Promise<CacheEntry | null> {
  const key = snapshotKey(steamId);
  const r = getRedis();
  if (r) {
    try {
      const raw = await r.get(key);
      if (raw == null || raw === "") {
        invCacheLog(`GET MISS op=${op} steamId=${steamId} key=${key} store=redis (nil)`);
        return null;
      }
      const parsed = JSON.parse(raw) as CacheEntry;
      if (!parsed || !Array.isArray(parsed.items) || typeof parsed.fetchedAt !== "number") {
        invCacheLog(
          `GET MISS op=${op} steamId=${steamId} key=${key} store=redis (invalid JSON shape)`,
        );
        return null;
      }
      const ageMs = Date.now() - parsed.fetchedAt;
      invCacheLog(
        `GET HIT op=${op} steamId=${steamId} key=${key} store=redis items=${parsed.items.length} ageMs=${ageMs}`,
      );
      return parsed;
    } catch (e) {
      console.warn("[inventory-cache] redis GET failed, trying memory", e);
      invCacheLog(
        `GET ERROR op=${op} steamId=${steamId} key=${key} store=redis err=${(e as Error).message} → try memory`,
      );
      const mem = memoryCache.get(steamId) ?? null;
      if (!mem) {
        invCacheLog(`GET MISS op=${op} steamId=${steamId} key=${key} store=memory (fallback empty)`);
      } else {
        const ageMs = Date.now() - mem.fetchedAt;
        invCacheLog(
          `GET HIT op=${op} steamId=${steamId} key=${key} store=memory items=${mem.items.length} ageMs=${ageMs}`,
        );
      }
      return mem;
    }
  }
  const mem = memoryCache.get(steamId) ?? null;
  if (!mem) {
    invCacheLog(`GET MISS op=${op} steamId=${steamId} key=${key} store=memory (nil)`);
  } else {
    const ageMs = Date.now() - mem.fetchedAt;
    invCacheLog(
      `GET HIT op=${op} steamId=${steamId} key=${key} store=memory items=${mem.items.length} ageMs=${ageMs}`,
    );
  }
  return mem;
}

async function readSnapshot(steamId: string, op: "guest-ttl" | "owner-swr"): Promise<CacheEntry | null> {
  const norm = normalizeSteamId64ForCache(steamId);
  const trimmed = steamId.trim();
  let entry = await readSnapshotAtKey(norm, op);
  if (!entry && norm !== trimmed) {
    entry = await readSnapshotAtKey(trimmed, op);
    if (entry) {
      invCacheLog(
        `GET MIGRATE op=${op} legacyKey=${trimmed} canonicalKey=${norm} items=${entry.items.length}`,
      );
      await writeSnapshotAtKey(norm, entry);
      await removeSnapshotAtKey(trimmed, "legacy-alias-after-migrate");
    }
  }
  return entry;
}

async function writeSnapshotAtKey(steamId: string, entry: CacheEntry): Promise<void> {
  const key = snapshotKey(steamId);
  const r = getRedis();
  if (r) {
    try {
      const payload = JSON.stringify(entry);
      await r.set(key, payload, "EX", SNAPSHOT_MAX_TTL_SEC);
      invCacheLog(
        `SET OK steamId=${steamId} key=${key} store=redis items=${entry.items.length} bytes=${payload.length}`,
      );
      return;
    } catch (e) {
      console.warn("[inventory-cache] redis SET failed, using memory only", e);
      invCacheLog(`SET FAIL steamId=${steamId} key=${key} store=redis err=${(e as Error).message}`);
    }
  }
  memoryCache.set(steamId, entry);
  invCacheLog(`SET OK steamId=${steamId} key=${key} store=memory items=${entry.items.length}`);
}

async function writeSnapshot(steamId: string, entry: CacheEntry): Promise<void> {
  const norm = normalizeSteamId64ForCache(steamId);
  await writeSnapshotAtKey(norm, entry);
}

async function removeSnapshotAtKey(steamId: string, reason: string): Promise<void> {
  const key = snapshotKey(steamId);
  const r = getRedis();
  if (r) {
    try {
      await r.del(key);
      invCacheLog(`DEL steamId=${steamId} key=${key} store=redis reason=${reason}`);
    } catch (e) {
      console.warn("[inventory-cache] redis DEL failed", e);
      invCacheLog(`DEL FAIL steamId=${steamId} key=${key} store=redis err=${(e as Error).message}`);
    }
  }
  memoryCache.delete(steamId);
  if (!r) invCacheLog(`DEL steamId=${steamId} key=${key} store=memory reason=${reason}`);
}

async function removeSnapshot(steamId: string, reason: string): Promise<void> {
  const norm = normalizeSteamId64ForCache(steamId);
  const trimmed = steamId.trim();
  await removeSnapshotAtKey(norm, reason);
  if (norm !== trimmed) {
    await removeSnapshotAtKey(trimmed, `${reason}-raw-trim`);
  }
}

export async function getCached(steamId: string): Promise<NormalizedItem[] | null> {
  const entry = await getGuestSnapshotEntry(steamId);
  return entry?.items ?? null;
}

/** Long-lived guest snapshot (same Redis key as before; no 3-minute eviction). */
export async function getGuestSnapshotEntry(steamId: string): Promise<CacheEntry | null> {
  const entry = await readSnapshot(steamId, "guest-ttl");
  if (!entry) return null;
  const ageMs = Date.now() - entry.fetchedAt;
  if (ageMs > GUEST_SNAPSHOT_MAX_AGE_MS) {
    invCacheLog(
      `guest-snapshot MAX_AGE steamId=${steamId} key=${snapshotKey(steamId)} ageMs=${ageMs} maxMs=${GUEST_SNAPSHOT_MAX_AGE_MS}`,
    );
    await removeSnapshot(steamId, "guest-snapshot-max-age");
    return null;
  }
  invCacheLog(`guest-snapshot SERVE steamId=${steamId} ageMs=${ageMs}`);
  return entry;
}

/**
 * Owner store inventory: serve until replaced by a successful Steam fetch.
 * Stale flag drives background revalidation only; we do not evict by age (SWR + hourly job).
 */
export async function getOwnerCachedStaleWhileRevalidate(steamId: string): Promise<{
  items: NormalizedItem[];
  isStale: boolean;
} | null> {
  const entry = await readSnapshot(steamId, "owner-swr");
  if (!entry) return null;
  const age = Date.now() - entry.fetchedAt;
  const isStale = age > OWNER_FRESH_TTL_MS;
  invCacheLog(
    `owner-swr USE steamId=${steamId} key=${snapshotKey(steamId)} stale=${isStale} ageMs=${age} freshTtlMs=${OWNER_FRESH_TTL_MS}`,
  );
  return {
    items: entry.items,
    isStale,
  };
}

export async function setCache(steamId: string, items: NormalizedItem[]) {
  await writeSnapshot(steamId, { items, fetchedAt: Date.now() });
}

export async function invalidateCache(steamId: string) {
  await removeSnapshot(steamId, "invalidate");
}

function remainingCooldown(
  map: Map<string, number>,
  steamId: string,
  windowMs: number,
): number {
  const last = map.get(steamId);
  if (!last) return 0;
  const elapsed = Date.now() - last;
  return Math.max(0, windowMs - elapsed);
}

/** Owner/store inventory refresh (key = owner Steam ID). */
export async function refreshCooldownRemainingOwner(steamId: string): Promise<number> {
  const id = normalizeSteamId64ForCache(steamId);
  const r = getRedis();
  if (r) {
    try {
      const pttl = await r.pttl(`${RL_OWNER_PREFIX}${id}`);
      if (pttl > 0) return pttl;
      return 0;
    } catch (e) {
      console.warn("[inventory-cache] redis PTTL owner failed", e);
    }
  }
  return remainingCooldown(lastOwnerRefresh, id, OWNER_REFRESH_COOLDOWN_MS);
}

/** Logged-in user's "my inventory" refresh (key = user's Steam ID). */
export async function refreshCooldownRemainingUser(steamId: string): Promise<number> {
  const id = normalizeSteamId64ForCache(steamId);
  const r = getRedis();
  if (r) {
    try {
      const pttl = await r.pttl(`${RL_USER_PREFIX}${id}`);
      if (pttl > 0) return pttl;
      return 0;
    } catch (e) {
      console.warn("[inventory-cache] redis PTTL user failed", e);
    }
  }
  return remainingCooldown(lastUserRefresh, id, USER_REFRESH_COOLDOWN_MS);
}

function remainingShortGuest(steamId: string): number {
  const id = normalizeSteamId64ForCache(steamId);
  const until = shortGuestCooldownUntil.get(id);
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

/** Max of normal user refresh cooldown (2h) and short “Steam unstable” window (15m). */
export async function guestSteamFetchCooldownRemainingMs(steamId: string): Promise<number> {
  const id = normalizeSteamId64ForCache(steamId);
  const base = await refreshCooldownRemainingUser(id);
  const r = getRedis();
  if (r) {
    try {
      const pttl = await r.pttl(`${RL_USER_SHORT_PREFIX}${id}`);
      if (pttl > 0) return Math.max(base, pttl);
      return base;
    } catch (e) {
      console.warn("[inventory-cache] redis PTTL userShort failed", e);
    }
  }
  return Math.max(base, remainingShortGuest(id));
}

export async function markUserShortGuestCooldown(steamId: string, ms: number = USER_SHORT_GUEST_COOLDOWN_MS) {
  const id = normalizeSteamId64ForCache(steamId);
  const r = getRedis();
  if (r) {
    try {
      await r.set(`${RL_USER_SHORT_PREFIX}${id}`, "1", "PX", ms);
    } catch (e) {
      console.warn("[inventory-cache] redis SET userShort rl failed", e);
    }
  }
  shortGuestCooldownUntil.set(id, Date.now() + ms);
}

export async function markOwnerRefreshed(steamId: string) {
  const id = normalizeSteamId64ForCache(steamId);
  const r = getRedis();
  if (r) {
    try {
      await r.set(`${RL_OWNER_PREFIX}${id}`, "1", "PX", OWNER_REFRESH_COOLDOWN_MS);
    } catch (e) {
      console.warn("[inventory-cache] redis SET owner rl failed", e);
    }
  }
  lastOwnerRefresh.set(id, Date.now());
}

export async function markUserRefreshed(steamId: string) {
  const id = normalizeSteamId64ForCache(steamId);
  const r = getRedis();
  if (r) {
    try {
      await r.set(`${RL_USER_PREFIX}${id}`, "1", "PX", USER_REFRESH_COOLDOWN_MS);
    } catch (e) {
      console.warn("[inventory-cache] redis SET user rl failed", e);
    }
  }
  lastUserRefresh.set(id, Date.now());
}
