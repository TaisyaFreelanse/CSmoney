/**
 * GET  /api/admin/pricing — read pricing settings + manual prices.
 * PUT  /api/admin/pricing — update pricing settings.
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateSettingsCache } from "@/lib/pricempire";

export const dynamic = "force-dynamic";

async function assertAdmin() {
  const user = await getSessionUser();
  if (!user?.isAdmin) return null;
  return user;
}

export async function GET() {
  if (!(await assertAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let settings = await prisma.pricingSettings.findUnique({
    where: { id: "singleton" },
  });
  if (!settings) {
    settings = await prisma.pricingSettings.create({
      data: { id: "singleton" },
    });
  }

  const manualPrices = await prisma.ownerManualPrice.findMany({
    orderBy: { setAt: "desc" },
    take: 100,
  });

  return NextResponse.json({ settings, manualPrices });
}

export async function PUT(request: NextRequest) {
  if (!(await assertAdmin())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const updatable: Record<string, unknown> = {};

  if (typeof body.selectedPriceProvider === "string") {
    updatable.selectedPriceProvider = body.selectedPriceProvider;
  }
  if (typeof body.markupGuestPercent === "number") {
    updatable.markupGuestPercent = body.markupGuestPercent;
  }
  if (typeof body.markupOwnerPercent === "number") {
    updatable.markupOwnerPercent = body.markupOwnerPercent;
  }
  if (typeof body.minPriceThresholdUsd === "number") {
    updatable.minPriceThresholdUsd = body.minPriceThresholdUsd;
  }

  const settings = await prisma.pricingSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...updatable },
    update: updatable,
  });

  invalidateSettingsCache();

  return NextResponse.json({ settings });
}
