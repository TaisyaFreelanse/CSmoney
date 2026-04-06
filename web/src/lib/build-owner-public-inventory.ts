/**
 * Builds the same owner inventory list as GET /api/inventory/owner (before price enrichment).
 * Used for trade validation so server checks against merged Steam + manual-lock rows.
 */

import { getCached, setCache } from "@/lib/inventory-cache";
import {
  filterSteamItemsTradableForTradeTab,
  getOwnerManualLockDisplayItems,
  mergeOwnerSteamAndManualLockJson,
  type OwnerPublicInventoryRow,
} from "@/lib/owner-manual-trade-lock";
import { fetchOwnerInventory } from "@/lib/steam-inventory";

const JUNK_TYPES = ["Loyalty Badge", "Collectible Coin", "Service Medal", "Season Coin"];

export async function buildOwnerPublicInventoryItems(): Promise<
  | { ok: true; items: OwnerPublicInventoryRow[]; manualLockCount: number }
  | { ok: false; error: string }
> {
  const ownerSteamId = process.env.OWNER_STEAM_ID;
  if (!ownerSteamId) return { ok: false, error: "missing_owner_steam_id" };

  let items = getCached(ownerSteamId);

  if (!items) {
    const result = await fetchOwnerInventory();
    if (!result.ok) return { ok: false, error: result.error };
    items = result.items.filter((i) => {
      if (!i.type) return true;
      return !JUNK_TYPES.some((j) => i.type!.includes(j));
    });
    setCache(ownerSteamId, items);
    const locked = items.filter((i) => !i.tradable).length;
    console.log(
      `[build-owner-public-inventory] loaded ${result.items.length} → ${items.length} (junk filtered; tradable=false: ${locked})`,
    );
  }

  const steamTradable = filterSteamItemsTradableForTradeTab(items);
  const manualLock = await getOwnerManualLockDisplayItems();
  const merged = mergeOwnerSteamAndManualLockJson(steamTradable, manualLock);
  return { ok: true, items: merged, manualLockCount: manualLock.length };
}
