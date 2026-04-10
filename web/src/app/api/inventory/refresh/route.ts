/**
 * POST /api/inventory/refresh — force-refresh inventory.
 * Owner/store: admins only; on success replaces cache (on failure old cache kept). Cooldown 2 min.
 * User "my" inventory: 1 refresh per 2 hours per Steam account.
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import {
  guestTradeUrlHttpRejection,
  resolveGuestInventoryTargetSteamId,
  warnIfGuestSteamIdEqualsOwner,
} from "@/lib/guest-inventory-target";
import { loadGuestInventoryForUser } from "@/lib/guest-inventory-load-service";
import {
  invalidateCache,
  markOwnerRefreshed,
  markUserRefreshed,
  refreshCooldownRemainingOwner,
  refreshCooldownRemainingUser,
  setCache,
} from "@/lib/inventory-cache";
import { markInventoryRefreshPost, refreshPostMinRemainingMs } from "@/lib/inventory-refresh-endpoint-min";
import { formatRefreshCooldownRu, OWNER_REFRESH_COOLDOWN_MS, USER_REFRESH_COOLDOWN_MS } from "@/lib/inventory-refresh-limits";
import { filterJunkFromOwnerSteamItems } from "@/lib/owner-inventory-filters";
import { fetchOwnerInventory, normalizeSteamId64ForCache } from "@/lib/steam-inventory";

export const dynamic = "force-dynamic";

function rateLimitBody(cooldownMs: number) {
  const sec = Math.ceil(cooldownMs / 1000);
  return {
    error: "rate_limited" as const,
    retryAfterMs: cooldownMs,
    message: `Следующее обновление через ${formatRefreshCooldownRu(sec)}`,
  };
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();

  let body: { side?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const side = body.side ?? "owner";

  if (side === "owner") {
    if (!user?.isAdmin) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const ownerSteamId = process.env.OWNER_STEAM_ID;
    if (!ownerSteamId) {
      return NextResponse.json({ error: "owner_not_configured" }, { status: 500 });
    }

    const cooldown = await refreshCooldownRemainingOwner(ownerSteamId);
    if (cooldown > 0) {
      return NextResponse.json(rateLimitBody(cooldown), { status: 429 });
    }

    const result = await fetchOwnerInventory();
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    await setCache(ownerSteamId, filterJunkFromOwnerSteamItems(result.items));
    await markOwnerRefreshed(ownerSteamId);
    return NextResponse.json({
      ok: true,
      count: result.items.length,
      refreshCooldownRemainingMs: await refreshCooldownRemainingOwner(ownerSteamId),
      refreshCooldownTotalMs: OWNER_REFRESH_COOLDOWN_MS,
    });
  }

  // side === "my"
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const minPostMs = refreshPostMinRemainingMs(user.steamId);
  const cooldownUser = await refreshCooldownRemainingUser(user.steamId);
  const blockMs = Math.max(minPostMs, cooldownUser);
  if (blockMs > 0) {
    return NextResponse.json(
      {
        ...rateLimitBody(blockMs),
        cooldownActive: true,
        nextRefreshAt: new Date(Date.now() + blockMs).toISOString(),
      },
      { status: 429 },
    );
  }
  markInventoryRefreshPost(user.steamId);

  const guestTargetSteamId = resolveGuestInventoryTargetSteamId(user);
  const ownerSteamId = process.env.OWNER_STEAM_ID ?? "";
  const ownerNorm = ownerSteamId.trim() ? normalizeSteamId64ForCache(ownerSteamId) : "";
  const isPlatformOwner =
    ownerNorm !== "" && normalizeSteamId64ForCache(user.steamId) === ownerNorm;

  if (guestTargetSteamId) {
    warnIfGuestSteamIdEqualsOwner("inventory/refresh", guestTargetSteamId);
    await invalidateCache(guestTargetSteamId);
    await invalidateCache(user.steamId);
    await markUserRefreshed(user.steamId);

    const loaded = await loadGuestInventoryForUser({
      userSteamId: user.steamId,
      tradeUrl: user.tradeUrl!,
      guestTargetSteamId,
      mode: "force_refresh",
    });
    if (!loaded.ok) {
      return NextResponse.json({ error: loaded.error, ...loaded.flags }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      count: loaded.items.length,
      refreshCooldownRemainingMs: await refreshCooldownRemainingUser(user.steamId),
      refreshCooldownTotalMs: USER_REFRESH_COOLDOWN_MS,
      steamUnstable: loaded.flags.steamUnstable ?? false,
      isPrivate: loaded.flags.isPrivate ?? false,
      needsRefreshWarning: loaded.flags.needsRefreshWarning ?? false,
    });
  }

  if (isPlatformOwner) {
    await invalidateCache(user.steamId);
    await markUserRefreshed(user.steamId);

    const result = await fetchOwnerInventory();
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    await setCache(user.steamId, filterJunkFromOwnerSteamItems(result.items));
    return NextResponse.json({
      ok: true,
      count: result.items.length,
      refreshCooldownRemainingMs: await refreshCooldownRemainingUser(user.steamId),
      refreshCooldownTotalMs: USER_REFRESH_COOLDOWN_MS,
    });
  }

  if (user.tradeUrl?.trim()) {
    const rej = guestTradeUrlHttpRejection(user);
    return NextResponse.json(
      rej ?? { error: "invalid_trade_url", message: "Сохранённая trade-ссылка некорректна." },
      { status: 400 },
    );
  }

  return NextResponse.json({ error: "trade_url_required" }, { status: 400 });
}
