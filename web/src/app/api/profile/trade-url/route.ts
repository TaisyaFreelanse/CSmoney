/**
 * POST /api/profile/trade-url — save or update the user's trade URL.
 * GET  /api/profile/trade-url — get the current trade URL (masked).
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { resolveGuestInventoryTargetSteamId, TRADE_URL_SHOP_OWNER_MESSAGE } from "@/lib/guest-inventory-target";
import { invalidateCache } from "@/lib/inventory-cache";
import { prisma } from "@/lib/prisma";
import {
  normalizeSteamId64ForCache,
  parseTradeUrl,
  tradeOfferUrlsEquivalent,
  trySteamId64FromPartner,
} from "@/lib/steam-inventory";

export const dynamic = "force-dynamic";

/** Bump when changing admin / validation behavior (verify all instances return it in JSON). */
const TRADE_URL_API_VERSION = "v3_reject_shop_owner_trade_url" as const;

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized", version: TRADE_URL_API_VERSION }, { status: 401 });
  }

  const row = await prisma.user.findUnique({
    where: { steamId: user.steamId },
    select: { steamId: true, isAdmin: true },
  });
  if (!row) {
    return NextResponse.json({ error: "unauthorized", version: TRADE_URL_API_VERSION }, { status: 401 });
  }

  let body: { tradeUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json", version: TRADE_URL_API_VERSION }, { status: 400 });
  }

  const { tradeUrl } = body;
  if (!tradeUrl || typeof tradeUrl !== "string") {
    return NextResponse.json({ error: "trade_url_required", version: TRADE_URL_API_VERSION }, { status: 400 });
  }

  const parsed = parseTradeUrl(tradeUrl.trim());
  if (!parsed) {
    return NextResponse.json(
      {
        error: "invalid_trade_url",
        version: TRADE_URL_API_VERSION,
        message:
          "Формат: https://steamcommunity.com/tradeoffer/new/?partner=…&token=…",
      },
      { status: 400 },
    );
  }

  const derivedSteamId = trySteamId64FromPartner(parsed.partner);
  if (!derivedSteamId) {
    console.warn("[trade-url POST] trySteamId64FromPartner failed", {
      version: TRADE_URL_API_VERSION,
      parsedPartner: parsed.partner,
      sessionSteamId: row.steamId,
    });
    return NextResponse.json(
      {
        error: "invalid_trade_url",
        version: TRADE_URL_API_VERSION,
        message: "Некорректный параметр partner в ссылке.",
      },
      { status: 400 },
    );
  }

  const derivedNorm = normalizeSteamId64ForCache(derivedSteamId);
  const sessionNorm = normalizeSteamId64ForCache(row.steamId);

  const ownerSteamId = process.env.OWNER_STEAM_ID?.trim();
  if (ownerSteamId && derivedNorm === normalizeSteamId64ForCache(ownerSteamId)) {
    return NextResponse.json(
      {
        error: "trade_url_shop_owner",
        version: TRADE_URL_API_VERSION,
        message: TRADE_URL_SHOP_OWNER_MESSAGE,
      },
      { status: 400 },
    );
  }

  const isAdmin = row.isAdmin === true;
  const ownershipMismatch = derivedNorm !== sessionNorm;

  console.warn(
    "[trade-url POST]",
    JSON.stringify({
      version: TRADE_URL_API_VERSION,
      sessionSteamId: user.steamId,
      dbSteamId: row.steamId,
      sessionNorm,
      derivedSteamId,
      derivedNorm,
      isAdmin: row.isAdmin,
      parsedPartner: parsed.partner,
      ownershipMismatch,
    }),
  );

  if (!isAdmin && ownershipMismatch) {
    return NextResponse.json(
      {
        error: "not_your_trade_url",
        version: TRADE_URL_API_VERSION,
        message: "Эта trade-ссылка не принадлежит вашему аккаунту Steam. Вставьте свою ссылку.",
      },
      { status: 400 },
    );
  }

  if (tradeOfferUrlsEquivalent(user.tradeUrl, tradeUrl.trim())) {
    return NextResponse.json({
      ok: true,
      unchanged: true,
      partner: parsed.partner,
      version: TRADE_URL_API_VERSION,
    });
  }

  const beforeActor = {
    steamId: user.steamId,
    tradeUrl: user.tradeUrl,
  };
  const afterActor = {
    steamId: user.steamId,
    tradeUrl: tradeUrl.trim(),
  };

  await prisma.user.update({
    where: { steamId: row.steamId },
    data: { tradeUrl: tradeUrl.trim() },
  });

  // Админ с чужой ссылкой: не сбрасываем снимки по session/старому derived — грузим строго по URL (snapshotSteamId).
  if (!(isAdmin && ownershipMismatch)) {
    const cacheKeys = new Set<string>();
    const addInvalidateKey = (sid: string | null | undefined) => {
      if (!sid?.trim()) return;
      cacheKeys.add(normalizeSteamId64ForCache(sid));
    };
    addInvalidateKey(user.steamId);
    addInvalidateKey(derivedSteamId);
    const oldT = resolveGuestInventoryTargetSteamId(beforeActor);
    const newT = resolveGuestInventoryTargetSteamId(afterActor);
    addInvalidateKey(oldT);
    addInvalidateKey(newT);
    for (const sid of cacheKeys) {
      await invalidateCache(sid);
    }
  }

  return NextResponse.json({
    ok: true,
    partner: parsed.partner,
    version: TRADE_URL_API_VERSION,
  });
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized", version: TRADE_URL_API_VERSION }, { status: 401 });
  }

  return NextResponse.json({
    tradeUrl: user.tradeUrl ?? null,
    hasTradeUrl: !!user.tradeUrl,
    version: TRADE_URL_API_VERSION,
  });
}
