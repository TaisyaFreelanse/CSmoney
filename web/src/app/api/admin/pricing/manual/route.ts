/**
 * POST   /api/admin/pricing/manual — set manual price (fixed USD) or extra markup % for an owner item.
 * DELETE /api/admin/pricing/manual — remove override (reset to auto).
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { buildOwnerPublicInventoryItems } from "@/lib/build-owner-public-inventory";
import { prisma } from "@/lib/prisma";
import { pricingCatalogMatchKey } from "@/lib/pricempire";

export const dynamic = "force-dynamic";

async function assertAdmin() {
  const user = await getSessionUser();
  if (!user?.isAdmin) return null;
  return user;
}

type ManualMode = "fixed" | "markup_percent";

export async function POST(request: NextRequest) {
  if (!(await assertAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    assetId?: string;
    mode?: ManualMode;
    priceUsd?: number;
    markupPercent?: number;
    note?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.assetId || typeof body.assetId !== "string" || !body.assetId.trim()) {
    return NextResponse.json({ error: "assetId required" }, { status: 400 });
  }

  const mode: ManualMode = body.mode === "markup_percent" ? "markup_percent" : "fixed";

  if (mode === "fixed") {
    if (typeof body.priceUsd !== "number" || !Number.isFinite(body.priceUsd) || body.priceUsd <= 0) {
      return NextResponse.json(
        { error: "priceUsd (positive USD number) required for fixed mode" },
        { status: 400 },
      );
    }
  } else {
    if (typeof body.markupPercent !== "number" || !Number.isFinite(body.markupPercent)) {
      return NextResponse.json(
        { error: "markupPercent (number) required for markup_percent mode" },
        { status: 400 },
      );
    }
    if (body.markupPercent < -90 || body.markupPercent > 500) {
      return NextResponse.json(
        { error: "markupPercent must be between -90 and 500" },
        { status: 400 },
      );
    }
  }

  const assetId = body.assetId.trim();
  const note = body.note != null && String(body.note).trim() ? String(body.note).trim() : null;

  let catalogMatchKey: string | null = null;
  const built = await buildOwnerPublicInventoryItems();
  if (built.ok) {
    const row = built.items.find((i) => String(i.assetId) === assetId);
    if (row) {
      catalogMatchKey = pricingCatalogMatchKey(row.marketHashName, row.phaseLabel);
    }
  }

  const manual = await prisma.ownerManualPrice.upsert({
    where: { assetId },
    create: {
      assetId,
      mode,
      priceUsd: mode === "fixed" ? body.priceUsd! : null,
      markupPercent: mode === "markup_percent" ? body.markupPercent! : null,
      catalogMatchKey,
      note,
    },
    update: {
      mode,
      priceUsd: mode === "fixed" ? body.priceUsd! : null,
      markupPercent: mode === "markup_percent" ? body.markupPercent! : null,
      catalogMatchKey,
      note,
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
