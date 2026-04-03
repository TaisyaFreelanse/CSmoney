/**
 * GET /api/prices/sync — trigger a price catalog sync from PriceEmpire.
 * Protected by a secret token (CRON_SECRET) or admin session.
 * Intended to be called by a cron job (e.g. Render Cron every hour).
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { syncPrices } from "@/lib/pricempire";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // allow up to 2 min for large catalogs

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const tokenFromHeader = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
  const tokenFromQuery = request.nextUrl.searchParams.get("token");

  const isValidCron =
    cronSecret &&
    (tokenFromHeader === cronSecret || tokenFromQuery === cronSecret);

  if (!isValidCron) {
    const user = await getSessionUser();
    if (!user?.isAdmin) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const started = Date.now();
  const result = await syncPrices();
  const elapsed = Date.now() - started;

  return NextResponse.json({
    ...result,
    elapsedMs: elapsed,
    syncedAt: new Date().toISOString(),
  });
}
