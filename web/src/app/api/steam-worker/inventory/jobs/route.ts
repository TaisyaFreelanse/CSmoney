/**
 * POST — enqueue long inventory fetch; poll GET …/jobs/[jobId].
 * Requires Redis. Same auth as GET /api/steam-worker/inventory.
 */
import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { assertSteamWorkerProxyAuthorized } from "@/lib/steam-worker-inventory-proxy-auth";
import { getSessionUser } from "@/lib/auth";
import {
  canonicalTradeUrlForWorkerCache,
  fetchSteamWorkerInventoryDirect,
  writeWorkerInventoryCache,
  writeWorkerInventoryJob,
  workerInventoryCacheTtlSec,
  workerInventoryJobTtlSec,
} from "@/lib/steam-worker-inventory-client";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await assertSteamWorkerProxyAuthorized(req);
  if (denied) return denied;

  let body: { tradeUrl?: string; steamId?: string };
  try {
    body = (await req.json()) as { tradeUrl?: string; steamId?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const tradeUrl = body.tradeUrl?.trim();
  if (!tradeUrl) {
    return NextResponse.json({ error: "tradeUrl is required" }, { status: 400 });
  }
  const steamId = body.steamId?.trim();
  const canonical = canonicalTradeUrlForWorkerCache(tradeUrl);
  if (!canonical) {
    return NextResponse.json({ error: "invalid tradeUrl" }, { status: 400 });
  }

  const jobId = randomUUID();
  const user = await getSessionUser();
  const createdAt = Date.now();

  try {
    await writeWorkerInventoryJob(
      jobId,
      { status: "pending", createdAt, createdBySteamId: user?.steamId ?? null, canonicalTradeUrl: canonical },
      workerInventoryJobTtlSec(),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "job_queue_unavailable", detail: msg }, { status: 503 });
  }

  const ttl = workerInventoryJobTtlSec();

  void (async () => {
    try {
      await writeWorkerInventoryJob(
        jobId,
        {
          status: "running",
          createdAt,
          startedAt: Date.now(),
          createdBySteamId: user?.steamId ?? null,
          canonicalTradeUrl: canonical,
        },
        ttl,
      );
      const { httpStatus, body: result } = await fetchSteamWorkerInventoryDirect({ tradeUrl, steamId });
      if (httpStatus === 200 && result.error == null) {
        await writeWorkerInventoryCache(canonical, { httpStatus, body: result }, workerInventoryCacheTtlSec());
      }
      await writeWorkerInventoryJob(
        jobId,
        {
          status: "complete",
          createdAt,
          finishedAt: Date.now(),
          httpStatus,
          result,
          createdBySteamId: user?.steamId ?? null,
          canonicalTradeUrl: canonical,
        },
        ttl,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeWorkerInventoryJob(
        jobId,
        {
          status: "failed",
          createdAt,
          finishedAt: Date.now(),
          error: msg,
          createdBySteamId: user?.steamId ?? null,
          canonicalTradeUrl: canonical,
        },
        ttl,
      ).catch(() => {});
    }
  })();

  const pollUrl = `/api/steam-worker/inventory/jobs/${encodeURIComponent(jobId)}`;
  return NextResponse.json({ jobId, pollUrl, status: "pending" }, { status: 202 });
}
