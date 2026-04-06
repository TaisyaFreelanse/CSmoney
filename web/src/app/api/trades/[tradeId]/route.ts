import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { serializeTradeFull } from "@/lib/trade-api-serialize";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ tradeId: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.isBanned) {
    return NextResponse.json({ error: "banned" }, { status: 403 });
  }

  const { tradeId } = await context.params;
  if (!tradeId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const trade = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: { items: true },
  });

  if (!trade) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (trade.creatorSteamId !== user.steamId && !user.isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({ trade: serializeTradeFull(trade) });
}
