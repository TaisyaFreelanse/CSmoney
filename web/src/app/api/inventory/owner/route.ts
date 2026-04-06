/**
 * GET /api/inventory/owner — public owner's CS2 inventory (paged).
 * Stale-while-revalidate on Steam snapshot: stale cache is served immediately;
 * background refresh runs via `after()` when the snapshot was stale.
 *
 * Query: limit (default 30, max see OWNER_INVENTORY_PAGE_MAX), offset (default 0).
 */
import { after, NextRequest, NextResponse } from "next/server";

import { buildOwnerPublicInventoryItems } from "@/lib/build-owner-public-inventory";
import { invCacheLog, refreshCooldownRemainingOwner } from "@/lib/inventory-cache";
import {
  OWNER_INVENTORY_PAGE_DEFAULT,
  OWNER_INVENTORY_PAGE_MAX,
} from "@/lib/owner-inventory-api-constants";
import type { OwnerPublicInventoryRow } from "@/lib/owner-manual-trade-lock";
import { refreshOwnerSteamItemsInCache } from "@/lib/owner-steam-cache-refresh";
import { resolvePricesBatch } from "@/lib/pricempire";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ownerSteamId = process.env.OWNER_STEAM_ID;
  if (!ownerSteamId) {
    return NextResponse.json({ error: "owner_not_configured" }, { status: 500 });
  }

  const url = new URL(request.url);
  const limit = Math.min(
    OWNER_INVENTORY_PAGE_MAX,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? String(OWNER_INVENTORY_PAGE_DEFAULT), 10) || OWNER_INVENTORY_PAGE_DEFAULT),
  );
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  const built = await buildOwnerPublicInventoryItems();
  if (!built.ok) {
    console.error("[/api/inventory/owner] build failed:", built.error);
    const messages: Record<string, string> = {
      empty_or_private_inventory:
        "Инвентарь пуст или приватный. Откройте Steam → Профиль → Настройки приватности → Инвентарь: Открытый.",
      private_inventory: "Инвентарь приватный. Измените настройки приватности в Steam.",
      steam_rate_limit: "Steam ограничил запросы. Подождите минуту.",
      missing_owner_steam_id: "Не задан OWNER_STEAM_ID на сервере.",
    };
    return NextResponse.json(
      { error: built.error, message: messages[built.error] ?? built.error },
      { status: 502 },
    );
  }

  // Pagination issues many parallel GETs; only the first page should trigger one background Steam refresh.
  if (built.steamCacheWasStale && offset === 0) {
    invCacheLog(
      `SWR_SCHEDULE_BG_REFRESH ownerSteamId=${ownerSteamId} offset=${offset} limit=${limit}`,
    );
    after(() =>
      refreshOwnerSteamItemsInCache(ownerSteamId).catch((e) =>
        console.warn("[/api/inventory/owner] background refresh failed:", e),
      ),
    );
  } else if (built.steamCacheWasStale && offset !== 0) {
    invCacheLog(
      `SWR_SKIP_BG_REFRESH ownerSteamId=${ownerSteamId} offset=${offset} (only offset=0 schedules Steam)`,
    );
  }

  const merged = built.items;
  const total = merged.length;
  const pageRows = merged.slice(offset, offset + limit);

  try {
    const enriched = await enrichWithPrices(pageRows, "owner");
    const hasMore = offset + enriched.length < total;
    return NextResponse.json({
      items: enriched,
      total,
      offset,
      limit,
      hasMore,
      manualLockCount: built.manualLockCount,
      refreshCooldownRemainingMs: await refreshCooldownRemainingOwner(ownerSteamId),
    });
  } catch (e) {
    console.error("[/api/inventory/owner] enrichWithPrices error:", e);
    const fallback = pageRows.map((i) => ({
      ...i,
      priceUsd: 0,
      priceSource: "unavailable" as const,
      belowThreshold: true,
    }));
    return NextResponse.json({
      items: fallback,
      total,
      offset,
      limit,
      hasMore: offset + fallback.length < total,
      manualLockCount: built.manualLockCount,
      refreshCooldownRemainingMs: await refreshCooldownRemainingOwner(ownerSteamId),
    });
  }
}

async function enrichWithPrices(items: OwnerPublicInventoryRow[], side: "owner" | "guest") {
  const keys = items.map((item) => ({
    marketHashName: item.marketHashName,
    phaseLabel: item.phaseLabel,
    assetId: item.assetId,
  }));
  const resolved = await resolvePricesBatch(keys, side);
  return items.map((item, i) => {
    const r = resolved[i]!;
    return {
      ...item,
      priceUsd: r.priceUsd,
      priceSource: r.source,
      belowThreshold: r.belowThreshold,
    };
  });
}
