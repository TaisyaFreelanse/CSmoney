import "server-only";

import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth";

/**
 * Browser: logged-in session. Automation: header `x-csmoney-worker-proxy` === STEAM_INVENTORY_PROXY_CRON_SECRET.
 */
export async function assertSteamWorkerProxyAuthorized(req: Request): Promise<NextResponse | null> {
  const cron = process.env.STEAM_INVENTORY_PROXY_CRON_SECRET?.trim();
  const hdr = req.headers.get("x-csmoney-worker-proxy")?.trim();
  if (cron && hdr && hdr === cron) {
    return null;
  }
  const user = await getSessionUser();
  if (user) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
