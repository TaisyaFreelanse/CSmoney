import type { Trade, TradeItem, User } from "@prisma/client";

export function usdDecimalToCents(d: unknown): number {
  if (d == null) return 0;
  const raw =
    typeof d === "object" && d !== null && "toString" in d
      ? Number((d as { toString(): string }).toString())
      : Number(d);
  return Number.isFinite(raw) ? Math.round(raw * 100) : 0;
}

export function serializeTradeItem(row: TradeItem) {
  return {
    id: row.id,
    side: row.side,
    displayName: row.displayName,
    marketHashName: row.marketHashName,
    phaseLabel: row.phaseLabel,
    assetId: row.assetId,
    wear: row.wear,
    floatValue: row.floatValue,
    priceUsdCents: usdDecimalToCents(row.priceUsd),
  };
}

export function serializeTradeFull(
  trade: Trade & {
    items: TradeItem[];
    creator?: Pick<User, "steamId" | "displayName" | "tradeUrl">;
  },
) {
  const items = trade.items.map(serializeTradeItem);
  const guestTotalCents = items
    .filter((i) => i.side === "guest")
    .reduce((s, i) => s + i.priceUsdCents, 0);
  const ownerTotalCents = items
    .filter((i) => i.side === "owner")
    .reduce((s, i) => s + i.priceUsdCents, 0);
  const base = {
    id: trade.id,
    status: trade.status,
    createdAt: trade.createdAt.toISOString(),
    updatedAt: trade.updatedAt.toISOString(),
    notes: trade.notes,
    guestTotalCents,
    ownerTotalCents,
    items,
  };
  if (!trade.creator) {
    return base;
  }
  return {
    ...base,
    creator: {
      steamId: trade.creator.steamId,
      displayName: trade.creator.displayName,
      tradeUrl: trade.creator.tradeUrl ?? null,
    },
  };
}

export function serializeTradeSummary(trade: Trade & { items: TradeItem[] }) {
  const full = serializeTradeFull(trade);
  return {
    id: full.id,
    status: full.status,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
    guestTotalCents: full.guestTotalCents,
    ownerTotalCents: full.ownerTotalCents,
    itemCount: trade.items.length,
  };
}
