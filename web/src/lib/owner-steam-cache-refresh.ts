import { invCacheLog, setCache } from "@/lib/inventory-cache";
import { filterJunkFromOwnerSteamItems } from "@/lib/owner-inventory-filters";
import { fetchOwnerInventory } from "@/lib/steam-inventory";

/** Fetches owner inventory from Steam and replaces the in-memory cache entry. */
export async function refreshOwnerSteamItemsInCache(ownerSteamId: string): Promise<boolean> {
  invCacheLog(`STEAM_FETCH start ownerSteamId=${ownerSteamId} key=csmoney:inv:snapshot:${ownerSteamId}`);
  const result = await fetchOwnerInventory({ forceRefresh: true });
  if (!result.ok) {
    invCacheLog(`STEAM_FETCH fail ownerSteamId=${ownerSteamId} error=${result.error}`);
    return false;
  }
  const items = filterJunkFromOwnerSteamItems(result.items);
  await setCache(ownerSteamId, items);
  invCacheLog(`STEAM_FETCH ok ownerSteamId=${ownerSteamId} items=${items.length} → SET snapshot`);
  const locked = items.filter((i) => !i.tradable).length;
  console.log(
    `[owner-steam-cache-refresh] refreshed ${result.items.length} → ${items.length} (tradable=false: ${locked})`,
  );
  return true;
}
