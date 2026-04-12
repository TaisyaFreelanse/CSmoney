/**
 * GET /api/inventory/me — CS2 инвентарь для левой колонки.
 * При сохранённой trade URL всегда грузим гостевой инвентарь по derivedSteamId из ссылки
 * (в т.ч. для аккаунта OWNER_STEAM_ID при подмене URL), иначе для владельца магазина — owner snapshot.
 */
import { after, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import {
  adminGuestOwnershipMismatch,
  guestTradeUrlHttpRejection,
  resolveGuestInventoryTargetSteamId,
  warnIfGuestSteamIdEqualsOwner,
} from "@/lib/guest-inventory-target";
import { loadGuestInventoryForUser } from "@/lib/guest-inventory-load-service";
import {
  getGuestSnapshotEntry,
  getOwnerCachedStaleWhileRevalidate,
  guestSteamFetchCooldownRemainingMs,
  invCacheLog,
  refreshCooldownRemainingUser,
  setCache,
} from "@/lib/inventory-cache";
import {
  inventoryMeGuestSoftRemainingMs,
  markInventoryMeGuestGet,
} from "@/lib/inventory-me-soft-rate-limit";
import { refreshOwnerSteamItemsInCache } from "@/lib/owner-steam-cache-refresh";
import { fetchOwnerInventory, normalizeSteamId64ForCache } from "@/lib/steam-inventory";
import type { NormalizedItem } from "@/lib/steam-inventory";
import { resolvePricesBatch } from "@/lib/pricempire";

export const dynamic = "force-dynamic";

const GUEST_STALE_WARNING_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ownerSteamId = process.env.OWNER_STEAM_ID ?? "";
  const ownerNorm = ownerSteamId.trim() ? normalizeSteamId64ForCache(ownerSteamId) : "";
  const isPlatformOwner =
    ownerNorm !== "" && normalizeSteamId64ForCache(user.steamId) === ownerNorm;
  const guestTargetSteamId = resolveGuestInventoryTargetSteamId(user);
  const adminGuestForeign = adminGuestOwnershipMismatch(user);

  if (guestTargetSteamId) {
    invCacheLog(
      `guest/me sessionSteamId=${user.steamId} sessionNorm=${normalizeSteamId64ForCache(user.steamId)} snapshotSteamId=${guestTargetSteamId} samePerson=${normalizeSteamId64ForCache(user.steamId) === guestTargetSteamId} adminGuestForeign=${adminGuestForeign}`,
    );
    warnIfGuestSteamIdEqualsOwner("inventory/me", guestTargetSteamId);

    const softRem = adminGuestForeign ? 0 : inventoryMeGuestSoftRemainingMs(user.steamId);
    if (softRem > 0) {
      const snapOnly = await getGuestSnapshotEntry(guestTargetSteamId);
      if (snapOnly) {
        markInventoryMeGuestGet(user.steamId);
        const age = Date.now() - snapOnly.fetchedAt;
        const enriched = await enrichWithPrices(snapOnly.items, "guest");
        return NextResponse.json({
          guestInventory: true,
          items: enriched,
          count: enriched.length,
          refreshCooldownRemainingMs: await guestSteamFetchCooldownRemainingMs(user.steamId),
          steamUnstable: false,
          steamBusy: false,
          isPrivate: false,
          cannotTrade: false,
          cooldownActive: false,
          skipSteamFetch: true,
          softRateLimited: true,
          retryAfterMs: softRem,
          nextRefreshAt: null,
          needsRefreshWarning: age > GUEST_STALE_WARNING_MS,
          shouldAutoRetry: false,
        });
      }
    }

    const loaded = await loadGuestInventoryForUser({
      userSteamId: user.steamId,
      tradeUrl: user.tradeUrl!,
      guestTargetSteamId,
      mode: "get",
      bypassGuestFetchCooldown: adminGuestForeign,
    });
    markInventoryMeGuestGet(user.steamId);

    if (!loaded.ok) {
      const status =
        loaded.error === "cooldown_active" ? 429 : loaded.error === "steam_busy" ? 503 : 502;
      return NextResponse.json(
        {
          guestInventory: true,
          error: loaded.error,
          ...loaded.flags,
        },
        { status },
      );
    }

    const enriched = await enrichWithPrices(loaded.items, "guest");
    const steamUnstable = loaded.flags.steamUnstable ?? false;
    return NextResponse.json({
      guestInventory: true,
      items: enriched,
      count: enriched.length,
      refreshCooldownRemainingMs: await guestSteamFetchCooldownRemainingMs(user.steamId),
      steamUnstable,
      steamBusy: loaded.flags.steamBusy ?? false,
      isPrivate: loaded.flags.isPrivate ?? false,
      cannotTrade: loaded.flags.cannotTrade ?? false,
      cooldownActive: loaded.flags.cooldownActive ?? false,
      skipSteamFetch: loaded.flags.skipSteamFetch ?? false,
      softRateLimited: false,
      retryAfterMs: loaded.flags.retryAfterMs ?? null,
      nextRefreshAt: loaded.flags.nextRefreshAt ?? null,
      needsRefreshWarning: loaded.flags.needsRefreshWarning ?? false,
      shouldAutoRetry: steamUnstable && enriched.length > 0,
      backgroundRevalidateScheduled: loaded.flags.backgroundRevalidateScheduled ?? false,
    });
  }

  if (isPlatformOwner) {
    const cacheKeySteamId = user.steamId;
    const ownerIdEnv = process.env.OWNER_STEAM_ID?.trim();
    let items: NormalizedItem[] | null = null;
    let ownerBackgroundRevalidateScheduled = false;

    if (ownerIdEnv) {
      const swr = await getOwnerCachedStaleWhileRevalidate(cacheKeySteamId);
      if (swr) {
        items = swr.items;
        if (swr.isStale) {
          ownerBackgroundRevalidateScheduled = true;
          after(() => {
            void refreshOwnerSteamItemsInCache(ownerIdEnv).catch((e) =>
              console.warn("[inventory/me] owner stale background refresh failed:", e),
            );
          });
        }
      }
    }

    if (!items) {
      const result = await fetchOwnerInventory();
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 502 });
      }
      items = result.items;
      await setCache(cacheKeySteamId, items);
    }
    const enriched = await enrichWithPrices(items, "owner");
    return NextResponse.json({
      items: enriched,
      count: enriched.length,
      refreshCooldownRemainingMs: await refreshCooldownRemainingUser(user.steamId),
      backgroundRevalidateScheduled: ownerBackgroundRevalidateScheduled,
    });
  }

  if (user.tradeUrl?.trim()) {
    const rej = guestTradeUrlHttpRejection(user);
    return NextResponse.json(
      rej ?? {
        error: "invalid_trade_url",
        message: "Сохранённая trade-ссылка некорректна. Укажите ссылку заново.",
      },
      { status: 400 },
    );
  }

  return NextResponse.json(
    { error: "trade_url_required", message: "Сначала сохраните вашу trade-ссылку" },
    { status: 400 },
  );
}

async function enrichWithPrices(items: NormalizedItem[], side: "owner" | "guest") {
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
