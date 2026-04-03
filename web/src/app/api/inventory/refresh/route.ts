/**
 * POST /api/inventory/refresh — force-refresh inventory for the current user.
 * Rate-limited: 1 refresh per 2 minutes per user.
 * Body: { "side": "owner" | "my" }
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import {
  invalidateCache,
  markRefreshed,
  refreshCooldownRemaining,
  setCache,
} from "@/lib/inventory-cache";
import { fetchGuestInventory, fetchOwnerInventory } from "@/lib/steam-inventory";

export const dynamic = "force-dynamic";

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
    const ownerSteamId = process.env.OWNER_STEAM_ID;
    if (!ownerSteamId) {
      return NextResponse.json({ error: "owner_not_configured" }, { status: 500 });
    }

    const cooldown = refreshCooldownRemaining(ownerSteamId);
    if (cooldown > 0) {
      return NextResponse.json(
        {
          error: "rate_limited",
          retryAfterMs: cooldown,
          message: `Подождите ${Math.ceil(cooldown / 1000)} сек. перед обновлением`,
        },
        { status: 429 },
      );
    }

    invalidateCache(ownerSteamId);
    markRefreshed(ownerSteamId);

    const result = await fetchOwnerInventory();
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    setCache(ownerSteamId, result.items);
    return NextResponse.json({ ok: true, count: result.items.length });
  }

  // side === "my"
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const cooldown = refreshCooldownRemaining(user.steamId);
  if (cooldown > 0) {
    return NextResponse.json(
      {
        error: "rate_limited",
        retryAfterMs: cooldown,
        message: `Подождите ${Math.ceil(cooldown / 1000)} сек. перед обновлением`,
      },
      { status: 429 },
    );
  }

  invalidateCache(user.steamId);
  markRefreshed(user.steamId);

  const isOwner = user.steamId === process.env.OWNER_STEAM_ID;
  if (isOwner) {
    const result = await fetchOwnerInventory();
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    setCache(user.steamId, result.items);
    return NextResponse.json({ ok: true, count: result.items.length });
  }

  if (!user.tradeUrl) {
    return NextResponse.json({ error: "trade_url_required" }, { status: 400 });
  }

  const result = await fetchGuestInventory(user.tradeUrl);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  setCache(user.steamId, result.items);
  return NextResponse.json({ ok: true, count: result.items.length });
}
