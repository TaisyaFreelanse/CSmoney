/**
 * Builds the same owner inventory list as GET /api/inventory/owner (before price enrichment).
 * Used for trade validation so server checks against merged Steam + manual-lock rows.
 */

import { getOwnerCachedStaleWhileRevalidate, invCacheLog, setCache } from "@/lib/inventory-cache";
import { filterJunkFromOwnerSteamItems } from "@/lib/owner-inventory-filters";
import {
  getOwnerManualLockDisplayItems,
  mergeOwnerSteamAndManualLockJson,
  splitOwnerSteamSelectableAndTradeLockedForStore,
  type OwnerPublicInventoryRow,
} from "@/lib/owner-manual-trade-lock";
import { filterOwnerStorePublicRows } from "@/lib/owner-store-visibility";
import { fetchOwnerInventory, type NormalizedItem } from "@/lib/steam-inventory";

export type BuildOwnerPublicInventoryResult =
  | { ok: true; items: OwnerPublicInventoryRow[]; manualLockCount: number; steamCacheWasStale: boolean }
  | { ok: false; error: string };

export async function buildOwnerPublicInventoryItems(): Promise<BuildOwnerPublicInventoryResult> {
  const ownerSteamId = process.env.OWNER_STEAM_ID;
  if (!ownerSteamId) return { ok: false, error: "missing_owner_steam_id" };

  const swr = await getOwnerCachedStaleWhileRevalidate(ownerSteamId);
  let steamCacheWasStale = false;
  let items: NormalizedItem[] | null = null;

  if (swr) {
    items = swr.items;
    steamCacheWasStale = swr.isStale;
  } else {
    invCacheLog(
      `STEAM_FOREGROUND ownerSteamId=${ownerSteamId} reason=snapshot_miss sameRedisKey=csmoney:inv:snapshot:${ownerSteamId}`,
    );
    const result = await fetchOwnerInventory();
    if (!result.ok) return { ok: false, error: result.error };
    items = filterJunkFromOwnerSteamItems(result.items);
    await setCache(ownerSteamId, items);
    const locked = items.filter((i) => !i.tradable).length;
    console.log(
      `[build-owner-public-inventory] loaded ${result.items.length} → ${items.length} (junk filtered; tradable=false: ${locked})`,
    );
  }

  const { selectable, steamTradeLocked } = splitOwnerSteamSelectableAndTradeLockedForStore(items);
  const manualLock = await getOwnerManualLockDisplayItems();
  const merged = mergeOwnerSteamAndManualLockJson(selectable, steamTradeLocked, manualLock);
  const mergedForStore = filterOwnerStorePublicRows(merged);
  invCacheLog(
    `owner-public-merge steamId=${ownerSteamId} selectable=${selectable.length} steamTradeLocked=${steamTradeLocked.length} manualLock=${manualLock.length} mergedTotal=${merged.length} storeAfterFilter=${mergedForStore.length}`,
  );
  const manualLockCount = mergedForStore.filter((i) => i.locked === true).length;
  return { ok: true, items: mergedForStore, manualLockCount, steamCacheWasStale };
}
