/**
 * POST   /api/admin/pricing/manual — set a manual price for an owner item.
 * DELETE /api/admin/pricing/manual — remove a manual price (reset to auto).
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function assertAdmin() {
  const user = await getSessionUser();
  if (!user?.isAdmin) return null;
  return user;
}

export async function POST(request: NextRequest) {
  if (!(await assertAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { assetId?: string; priceUsd?: number; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.assetId || typeof body.priceUsd !== "number" || body.priceUsd <= 0) {
    return NextResponse.json(
      { error: "assetId (string) and priceUsd (positive number in USD) required" },
      { status: 400 },
    );
  }

  const manual = await prisma.ownerManualPrice.upsert({
    where: { assetId: body.assetId },
    create: {
      assetId: body.assetId,
      priceUsd: body.priceUsd,
      note: body.note ?? null,
    },
    update: {
      priceUsd: body.priceUsd,
      note: body.note ?? null,
      setAt: new Date(),
    },
  });

  return NextResponse.json({ manual });
}

export async function DELETE(request: NextRequest) {
  if (!(await assertAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { assetId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.assetId) {
    return NextResponse.json({ error: "assetId required" }, { status: 400 });
  }

  try {
    await prisma.ownerManualPrice.delete({
      where: { assetId: body.assetId },
    });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
