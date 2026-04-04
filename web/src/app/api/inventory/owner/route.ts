/**
 * GET /api/inventory/owner — public endpoint for owner's CS2 inventory.
 * Cached server-side; fetches via Steam Web API Key (sees trade-locked items).
 */
import { NextResponse } from "next/server";

import { getCached, setCache } from "@/lib/inventory-cache";
import { fetchOwnerInventory } from "@/lib/steam-inventory";
import type { NormalizedItem } from "@/lib/steam-inventory";
import { resolvePrice } from "@/lib/pricempire";
import { enrichFromInspectLinks } from "@/lib/csfloat";

export const dynamic = "force-dynamic";

export async function GET() {
  const ownerSteamId = process.env.OWNER_STEAM_ID;
  if (!ownerSteamId) {
    return NextResponse.json({ error: "owner_not_configured" }, { status: 500 });
  }

  let items: NormalizedItem[] | null = getCached(ownerSteamId);

  if (!items) {
    const result = await fetchOwnerInventory();
    if (!result.ok) {
      console.error("[/api/inventory/owner] fetch failed:", result.error);
      const messages: Record<string, string> = {
        empty_or_private_inventory:
          "Инвентарь пуст или приватный. Откройте Steam → Профиль → Настройки приватности → Инвентарь: Открытый.",
        private_inventory: "Инвентарь приватный. Измените настройки приватности в Steam.",
        steam_rate_limit: "Steam ограничил запросы. Подождите минуту.",
        missing_steam_api_key: "Не задан STEAM_WEB_API_KEY на сервере.",
        missing_owner_steam_id: "Не задан OWNER_STEAM_ID на сервере.",
      };
      return NextResponse.json(
        { error: result.error, message: messages[result.error] ?? result.error },
        { status: 502 },
      );
    }
    const raw = result.items;
    const JUNK_TYPES = ["Loyalty Badge", "Collectible Coin", "Service Medal", "Season Coin"];
    items = raw.filter((i) => {
      if (!i.type) return true;
      return !JUNK_TYPES.some((j) => i.type!.includes(j));
    });
    const locked = items.filter((i) => !i.tradable).length;
    console.log(`[/api/inventory/owner] loaded ${raw.length} items → shown ${items.length} (hidden_junk=${raw.length - items.length}, tradable=false: ${locked})`);

    enrichFromInspectLinks(items);
    setCache(ownerSteamId, items);
  }

  try {
    const enriched = await enrichWithPrices(items, "owner");
    return NextResponse.json({ items: enriched, count: enriched.length });
  } catch (e) {
    console.error("[/api/inventory/owner] enrichWithPrices error:", e);
    return NextResponse.json(
      { items: items.map((i) => ({ ...i, priceUsd: 0, priceSource: "unavailable", belowThreshold: true })), count: items.length },
    );
  }
}

async function enrichWithPrices(
  items: NormalizedItem[],
  side: "owner" | "guest",
) {
  return Promise.all(
    items.map(async (item) => {
      const resolved = await resolvePrice(
        item.marketHashName,
        item.phaseLabel,
        item.assetId,
        side,
      );
      return {
        ...item,
        priceUsd: resolved.priceUsd,
        priceSource: resolved.source,
        belowThreshold: resolved.belowThreshold,
      };
    }),
  );
}
