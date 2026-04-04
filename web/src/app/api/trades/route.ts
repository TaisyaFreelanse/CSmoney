/**
 * POST /api/trades — create a new trade request.
 * Body: { guestItems: string[], ownerItems: string[] } — arrays of assetIds.
 * Server re-fetches prices to prevent client manipulation.
 * Returns trade ID and owner trade URL for redirect.
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { getCached } from "@/lib/inventory-cache";
import { centsCountedInTradeTotal, resolvePrice } from "@/lib/pricempire";
import { fetchOwnerInventory, fetchGuestInventory } from "@/lib/steam-inventory";
import type { NormalizedItem } from "@/lib/steam-inventory";
import { prisma } from "@/lib/prisma";
import { checkTradeBalance, MAX_TRADE_ITEMS_PER_SIDE } from "@/lib/trade-balance";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (user.isBanned) {
    return NextResponse.json({ error: "banned" }, { status: 403 });
  }

  let body: { guestItems?: string[]; ownerItems?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const guestAssetIds = body.guestItems ?? [];
  const ownerAssetIds = body.ownerItems ?? [];

  if (guestAssetIds.length === 0 && ownerAssetIds.length === 0) {
    return NextResponse.json(
      { error: "empty_trade", message: "Выберите хотя бы один предмет" },
      { status: 400 },
    );
  }

  if (guestAssetIds.length === 0) {
    return NextResponse.json(
      { error: "no_guest_items", message: "Выберите предметы, которые вы отдаёте" },
      { status: 400 },
    );
  }

  if (ownerAssetIds.length === 0) {
    return NextResponse.json(
      { error: "no_owner_items", message: "Выберите предметы, которые вы хотите получить" },
      { status: 400 },
    );
  }

  if (
    guestAssetIds.length > MAX_TRADE_ITEMS_PER_SIDE ||
    ownerAssetIds.length > MAX_TRADE_ITEMS_PER_SIDE
  ) {
    return NextResponse.json(
      {
        error: "too_many_items",
        message: `Не более ${MAX_TRADE_ITEMS_PER_SIDE} предметов с каждой стороны за одну заявку`,
      },
      { status: 400 },
    );
  }

  const ownerSteamId = process.env.OWNER_STEAM_ID;
  if (!ownerSteamId) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  // Load inventories (from cache or fresh)
  let ownerInv: NormalizedItem[] | null = getCached(ownerSteamId);
  if (!ownerInv) {
    const res = await fetchOwnerInventory();
    if (!res.ok) {
      return NextResponse.json(
        { error: "owner_inventory_unavailable", message: "Инвентарь магазина недоступен" },
        { status: 502 },
      );
    }
    ownerInv = res.items;
  }

  let guestInv: NormalizedItem[] | null = getCached(user.steamId);
  if (!guestInv) {
    if (!user.tradeUrl) {
      return NextResponse.json(
        { error: "trade_url_required", message: "Сначала сохраните вашу trade-ссылку" },
        { status: 400 },
      );
    }
    const res = await fetchGuestInventory(user.tradeUrl);
    if (!res.ok) {
      return NextResponse.json(
        { error: "guest_inventory_unavailable", message: "Ваш инвентарь недоступен" },
        { status: 502 },
      );
    }
    guestInv = res.items;
  }

  // Validate selected items exist in inventories
  const ownerMap = new Map(ownerInv.map((i) => [i.assetId, i]));
  const guestMap = new Map(guestInv.map((i) => [i.assetId, i]));

  const missingOwner = ownerAssetIds.filter((id) => !ownerMap.has(id));
  if (missingOwner.length > 0) {
    return NextResponse.json(
      { error: "invalid_owner_items", message: "Некоторые предметы магазина не найдены в инвентаре" },
      { status: 400 },
    );
  }

  const missingGuest = guestAssetIds.filter((id) => !guestMap.has(id));
  if (missingGuest.length > 0) {
    return NextResponse.json(
      { error: "invalid_guest_items", message: "Некоторые ваши предметы не найдены в инвентаре" },
      { status: 400 },
    );
  }

  // Check trade locks and price thresholds
  for (const id of ownerAssetIds) {
    const item = ownerMap.get(id)!;
    if (item.tradeLockUntil && new Date(item.tradeLockUntil) > new Date()) {
      return NextResponse.json(
        { error: "trade_locked", message: `Предмет "${item.name}" в трейдлоке` },
        { status: 400 },
      );
    }
  }

  // Build trade items with server-side price recalculation
  type TradeItemInput = {
    side: "owner" | "guest";
    marketHashName: string | null;
    phaseLabel: string | null;
    assetId: string | null;
    classId: string | null;
    instanceId: string | null;
    wear: string | null;
    floatValue: number | null;
    priceUsd: number;
  };

  const tradeItems: TradeItemInput[] = [];
  let guestTotalCents = 0;
  let ownerTotalCents = 0;

  for (const id of guestAssetIds) {
    const item = guestMap.get(id)!;
    const price = await resolvePrice(item.marketHashName, item.phaseLabel, item.assetId, "guest");
    if (price.source === "unavailable") {
      return NextResponse.json(
        { error: "price_unavailable", message: `Нет цены для предмета: ${item.name}` },
        { status: 400 },
      );
    }
    guestTotalCents += centsCountedInTradeTotal(price);
    tradeItems.push({
      side: "guest",
      marketHashName: item.marketHashName,
      phaseLabel: item.phaseLabel,
      assetId: item.assetId,
      classId: item.classId,
      instanceId: item.instanceId,
      wear: item.wear,
      floatValue: item.floatValue,
      priceUsd: price.priceUsd,
    });
  }

  for (const id of ownerAssetIds) {
    const item = ownerMap.get(id)!;
    const price = await resolvePrice(item.marketHashName, item.phaseLabel, item.assetId, "owner");
    if (price.source === "unavailable") {
      return NextResponse.json(
        { error: "price_unavailable", message: `Нет цены для предмета: ${item.name}` },
        { status: 400 },
      );
    }
    ownerTotalCents += centsCountedInTradeTotal(price);
    tradeItems.push({
      side: "owner",
      marketHashName: item.marketHashName,
      phaseLabel: item.phaseLabel,
      assetId: item.assetId,
      classId: item.classId,
      instanceId: item.instanceId,
      wear: item.wear,
      floatValue: item.floatValue,
      priceUsd: price.priceUsd,
    });
  }
  const balance = checkTradeBalance(guestTotalCents, ownerTotalCents);
  if (!balance.ok) {
    const payload: Record<string, unknown> = { error: balance.reason, message: balance.message };
    if (balance.reason === "overpay_too_high") payload.excessCents = balance.excessCents;
    if (balance.reason === "overpay_too_low") payload.shortfallCents = balance.shortfallCents;
    return NextResponse.json(payload, { status: 400 });
  }

  // Create trade in DB
  const trade = await prisma.trade.create({
    data: {
      creatorSteamId: user.steamId,
      status: "pending",
      items: {
        create: tradeItems.map((ti) => ({
          side: ti.side,
          marketHashName: ti.marketHashName,
          phaseLabel: ti.phaseLabel,
          assetId: ti.assetId,
          classId: ti.classId,
          instanceId: ti.instanceId,
          wear: ti.wear,
          floatValue: ti.floatValue,
          priceUsd: ti.priceUsd / 100, // cents → dollars for Decimal field
        })),
      },
    },
    include: { items: true },
  });

  const ownerTradeUrl = process.env.OWNER_TRADE_URL ?? null;

  return NextResponse.json({
    ok: true,
    tradeId: trade.id,
    ownerTradeUrl,
    guestTotal: guestTotalCents,
    ownerTotal: ownerTotalCents,
  });
}
