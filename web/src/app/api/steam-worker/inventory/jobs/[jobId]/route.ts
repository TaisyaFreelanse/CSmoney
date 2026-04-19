/**
 * GET — poll async job from POST /api/steam-worker/inventory/jobs.
 * Session user must match job creator unless cron proxy header is used.
 */
import { NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";
import { assertSteamWorkerProxyAuthorized } from "@/lib/steam-worker-inventory-proxy-auth";
import { readWorkerInventoryJob } from "@/lib/steam-worker-inventory-client";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const denied = await assertSteamWorkerProxyAuthorized(req);
  if (denied) return denied;

  const { jobId } = await ctx.params;
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const row = await readWorkerInventoryJob(jobId);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const cron = process.env.STEAM_INVENTORY_PROXY_CRON_SECRET?.trim();
  const hdr = req.headers.get("x-csmoney-worker-proxy")?.trim();
  const isCron = Boolean(cron && hdr && hdr === cron);

  if (!isCron && row.createdBySteamId) {
    const user = await getSessionUser();
    if (!user || user.steamId !== row.createdBySteamId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  return NextResponse.json(row);
}
