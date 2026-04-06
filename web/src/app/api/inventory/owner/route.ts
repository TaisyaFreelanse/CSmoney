/**
 * GET /api/inventory/owner — public endpoint for owner's CS2 inventory.
 * Cached server-side; fetches via Steam Web API Key (sees trade-locked items).
 */
import { NextResponse } from "next/server";

import { buildOwnerPublicInventoryItems } from "@/lib/build-owner-public-inventory";
import { refreshCooldownRemainingOwner } from "@/lib/inventory-cache";
import type { OwnerPublicInventoryRow } from "@/lib/owner-manual-trade-lock";
import { resolvePrice } from "@/lib/pricempire";

export const dynamic = "force-dynamic";

export async function GET() {
  const ownerSteamId = process.env.OWNER_STEAM_ID;
  if (!ownerSteamId) {
    return NextResponse.json({ error: "owner_not_configured" }, { status: 500 });
  }

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

  const merged = built.items;
  console.log(
    `[/api/inventory/owner] merged ${merged.length} rows (manualLockCount=${built.manualLockCount})`,
  );

  try {
    const enriched = await enrichWithPrices(merged, "owner");
    return NextResponse.json({
      items: enriched,
      count: enriched.length,
      manualLockCount: built.manualLockCount,
      refreshCooldownRemainingMs: refreshCooldownRemainingOwner(ownerSteamId),
    });
  } catch (e) {
    console.error("[/api/inventory/owner] enrichWithPrices error:", e);
    return NextResponse.json({
      items: merged.map((i) => ({ ...i, priceUsd: 0, priceSource: "unavailable" as const, belowThreshold: true })),
      count: merged.length,
      manualLockCount: built.manualLockCount,
      refreshCooldownRemainingMs: refreshCooldownRemainingOwner(ownerSteamId),
    });
  }
}

async function enrichWithPrices(
  items: OwnerPublicInventoryRow[],
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
