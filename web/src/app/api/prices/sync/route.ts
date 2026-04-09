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

  // Stream JSON body so response headers are sent immediately. Otherwise cron clients
  // (undici fetch) hit HeadersTimeoutError while waiting for a long sync with no headers yet.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const started = Date.now();
      try {
        const result = await syncPrices();
        const elapsed = Date.now() - started;
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              ...result,
              elapsedMs: elapsed,
              syncedAt: new Date().toISOString(),
            }),
          ),
        );
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              upserted: 0,
              errors: [msg],
              elapsedMs: Date.now() - started,
              syncedAt: new Date().toISOString(),
            }),
          ),
        );
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
