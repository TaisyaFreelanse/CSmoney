/**
 * POST /api/profile/trade-url — save or update the user's trade URL.
 * GET  /api/profile/trade-url — get the current trade URL (masked).
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseTradeUrl } from "@/lib/steam-inventory";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { tradeUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { tradeUrl } = body;
  if (!tradeUrl || typeof tradeUrl !== "string") {
    return NextResponse.json({ error: "trade_url_required" }, { status: 400 });
  }

  const parsed = parseTradeUrl(tradeUrl.trim());
  if (!parsed) {
    return NextResponse.json(
      {
        error: "invalid_trade_url",
        message:
          "Формат: https://steamcommunity.com/tradeoffer/new/?partner=…&token=…",
      },
      { status: 400 },
    );
  }

  await prisma.user.update({
    where: { steamId: user.steamId },
    data: { tradeUrl: tradeUrl.trim() },
  });

  return NextResponse.json({ ok: true, partner: parsed.partner });
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    tradeUrl: user.tradeUrl ?? null,
    hasTradeUrl: !!user.tradeUrl,
  });
}
