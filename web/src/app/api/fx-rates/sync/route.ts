/**
 * GET /api/fx-rates/sync — refresh rates from ExchangeRate-API (one request).
 * Auth: CRON_SECRET (query ?token= or Bearer) or admin session.
 * Optional: ?force=1 to bypass min interval (see FX_RATES_MIN_SYNC_INTERVAL_HOURS).
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { syncFxRatesFromProvider } from "@/lib/exchange-rates-sync";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const tokenFromHeader = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const tokenFromQuery = request.nextUrl.searchParams.get("token");

  const isValidCron =
    cronSecret && (tokenFromHeader === cronSecret || tokenFromQuery === cronSecret);

  if (!isValidCron) {
    const user = await getSessionUser();
    if (!user?.isAdmin) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  if (!process.env.EXCHANGE_RATE_API_KEY?.trim()) {
    return NextResponse.json(
      { error: "EXCHANGE_RATE_API_KEY not configured" },
      { status: 503 },
    );
  }

  const force = request.nextUrl.searchParams.get("force") === "1";
  const result = await syncFxRatesFromProvider({ force });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    skipped: result.skipped === true,
    rates: result.rates,
    fetchedAt: result.fetchedAt,
  });
}
