/**
 * GET — sync proxy to Hetzner steam-worker `/inventory` (retry, timeout, optional Redis cache).
 * Auth: session cookie or `x-csmoney-worker-proxy` when STEAM_INVENTORY_PROXY_CRON_SECRET is set.
 *
 * Query: tradeUrl (required), steamId (optional), nocache=1 skips Redis read (still writes on success).
 */
import { NextRequest, NextResponse } from "next/server";

import { assertSteamWorkerProxyAuthorized } from "@/lib/steam-worker-inventory-proxy-auth";
import {
  canonicalTradeUrlForWorkerCache,
  fetchSteamWorkerInventoryDirect,
  readWorkerInventoryCache,
  workerInventoryCacheTtlSec,
  writeWorkerInventoryCache,
  type SteamWorkerInventoryBody,
} from "@/lib/steam-worker-inventory-client";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const denied = await assertSteamWorkerProxyAuthorized(req);
  if (denied) return denied;

  const tradeUrl = req.nextUrl.searchParams.get("tradeUrl")?.trim();
  if (!tradeUrl) {
    return NextResponse.json({ error: "tradeUrl is required" }, { status: 400 });
  }
  const steamId = req.nextUrl.searchParams.get("steamId")?.trim();
  const nocache = req.nextUrl.searchParams.get("nocache") === "1";

  const canonical = canonicalTradeUrlForWorkerCache(tradeUrl);
  if (!canonical) {
    return NextResponse.json({ error: "invalid tradeUrl" }, { status: 400 });
  }

  if (!nocache) {
    const hit = await readWorkerInventoryCache(canonical);
    if (hit && hit.httpStatus === 200 && hit.body?.error == null) {
      const prevMeta = (hit.body.meta ?? {}) as Record<string, unknown>;
      return NextResponse.json(
        { ...hit.body, meta: { ...prevMeta, cacheHit: true, proxyCache: true } },
        { status: 200 },
      );
    }
  }

  try {
    const { httpStatus, body } = await fetchSteamWorkerInventoryDirect({ tradeUrl, steamId });
    const b = body as SteamWorkerInventoryBody;
    if (httpStatus === 200 && b.error == null) {
      await writeWorkerInventoryCache(canonical, { httpStatus, body: b }, workerInventoryCacheTtlSec());
    }
    return NextResponse.json(b, { status: httpStatus });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        items: [],
        source: null,
        accountId: null,
        durationMs: 0,
        error: "proxy_config_error",
        detail: msg,
        meta: {
          schemaVersion: 1,
          cacheHit: false,
          api: { attempted: false },
          trade: null,
        },
      },
      { status: 503 },
    );
  }
}
