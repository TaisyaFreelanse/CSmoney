import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import type { TradeStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const ALLOWED: TradeStatus[] = [
  "pending",
  "accepted_by_admin",
  "completed",
  "cancelled",
  "rejected",
];

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ tradeId: string }> },
) {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { tradeId } = await context.params;
  if (!tradeId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const exists = await prisma.trade.findUnique({ where: { id: tradeId }, select: { id: true } });
  if (!exists) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: { status?: string; notes?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const data: { status?: TradeStatus; notes?: string | null } = {};

  if (body.status !== undefined) {
    if (!ALLOWED.includes(body.status as TradeStatus)) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    data.status = body.status as TradeStatus;
  }

  if (body.notes !== undefined) {
    const n = body.notes === null ? null : String(body.notes).trim().slice(0, 8000);
    data.notes = n === "" ? null : n;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no_changes" }, { status: 400 });
  }

  const trade = await prisma.trade.update({
    where: { id: tradeId },
    data,
    include: { items: true, creator: true },
  });

  return NextResponse.json({ ok: true, tradeId: trade.id, status: trade.status, notes: trade.notes });
}
