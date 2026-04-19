/**
 * Float / phase via CSFloat API with Redis cache (inspect link → payload, 7d TTL),
 * multiple API keys (round-robin), bounded concurrency, rate-limit retry.
 */

import "server-only";

import crypto from "node:crypto";
import https from "node:https";

import type { NormalizedItem } from "./steam-inventory";
import { getRedis } from "./redis-client";

const PAINT_INDEX_PHASE: Record<number, string> = {
  415: "Ruby",
  416: "Sapphire",
  417: "Black Pearl",
  418: "Phase 1",
  419: "Phase 2",
  420: "Phase 3",
  421: "Phase 4",
  568: "Emerald",
  569: "Phase 1",
  570: "Phase 2",
  571: "Phase 3",
  572: "Phase 4",
  617: "Black Pearl",
  618: "Phase 2",
  619: "Sapphire",
  852: "Phase 1",
  853: "Phase 2",
  854: "Phase 3",
  855: "Phase 4",
};

const CACHE_PREFIX = "csmoney:csfloat:inspect:";
/** Default 365d — no repeat CSFloat HTTP for the same inspect link unless key is deleted. */
const TTL_SEC = Math.min(
  10 * 365 * 24 * 3600,
  Math.max(24 * 3600, parseInt(process.env.CSFLOAT_INSPECT_CACHE_TTL_SEC ?? String(365 * 24 * 3600), 10) || 365 * 24 * 3600),
);

const memoryInspectCache = new Map<string, InspectData & { tombstone?: boolean }>();

/** In-flight CSFloat fetches keyed by inspect link (dedupe concurrent enrich passes). */
const inspectInflight = new Map<string, Promise<InspectData | null>>();

const CSFLOAT_MAX_PARALLEL = Math.max(
  1,
  Math.min(20, parseInt(process.env.CSFLOAT_MAX_PARALLEL ?? "8", 10) || 8),
);

let csfloatParallel = 0;
const csfloatWaiters: Array<() => void> = [];

async function acquireCsFloatSlot(): Promise<void> {
  if (csfloatParallel < CSFLOAT_MAX_PARALLEL) {
    csfloatParallel++;
    return;
  }
  await new Promise<void>((resolve) => {
    csfloatWaiters.push(() => {
      csfloatParallel++;
      resolve();
    });
  });
}

function releaseCsFloatSlot(): void {
  csfloatParallel--;
  const w = csfloatWaiters.shift();
  if (w) w();
}

function parseApiKeys(): string[] {
  const multi = process.env.CSFLOAT_API_KEYS?.trim();
  if (multi) {
    const parts = multi
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts;
  }
  const one = process.env.CSFLOAT_API_KEY?.trim();
  return one ? [one] : [];
}

let keyIndex = 0;

export interface InspectData {
  floatValue: number;
  paintIndex: number;
  paintSeed: number;
  /** If true, CSFloat was already queried with no usable payload — never call API again for this inspect link. */
  tombstone?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function httpsGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("csfloat api timeout"));
    });
  });
}

/**
 * CSFloat supports classic `?s=&a=&d=` (and market `?m=&a=&d=`) plus full links via `?url=`
 * (required for CS2 hex / Item Certificate inspect strings).
 */
async function fetchFromCsFloatOnceForInspectLink(
  link: string,
  apiKey: string,
): Promise<{ status: number; body: string } | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(link);
  } catch {
    decoded = link;
  }

  const sad = /S(\d+)A(\d+)D(\d+)/.exec(decoded);
  if (sad) {
    const s = sad[1]!;
    const a = sad[2]!;
    const d = sad[3]!;
    if (s !== "0") {
      const url = `https://api.csfloat.com/?s=${encodeURIComponent(s)}&a=${encodeURIComponent(a)}&d=${encodeURIComponent(d)}`;
      return httpsGet(url, {
        Accept: "application/json",
        Authorization: apiKey,
      });
    }
    const url = `https://api.csfloat.com/?a=${encodeURIComponent(a)}&d=${encodeURIComponent(d)}`;
    return httpsGet(url, {
      Accept: "application/json",
      Authorization: apiKey,
    });
  }

  const mam = /M(\d+)A(\d+)D(\d+)/.exec(decoded);
  if (mam) {
    const url = `https://api.csfloat.com/?m=${encodeURIComponent(mam[1]!)}&a=${encodeURIComponent(mam[2]!)}&d=${encodeURIComponent(mam[3]!)}`;
    return httpsGet(url, {
      Accept: "application/json",
      Authorization: apiKey,
    });
  }

  if (decoded.includes("csgo_econ_action_preview") || link.includes("csgo_econ_action_preview")) {
    const url = `https://api.csfloat.com/?url=${encodeURIComponent(link)}`;
    return httpsGet(url, {
      Accept: "application/json",
      Authorization: apiKey,
    });
  }

  return null;
}

function cacheKeyForInspectLink(link: string): string {
  const h = crypto.createHash("sha256").update(link).digest("hex");
  return `${CACHE_PREFIX}${h}`;
}

async function readInspectCache(link: string): Promise<(InspectData & { tombstone?: boolean }) | null> {
  const mem = memoryInspectCache.get(link);
  if (mem) return mem;

  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(cacheKeyForInspectLink(link));
    if (raw == null || raw === "") return null;
    const parsed = JSON.parse(raw) as InspectData & { tombstone?: boolean };
    if (
      parsed &&
      typeof parsed.floatValue === "number" &&
      typeof parsed.paintIndex === "number" &&
      typeof parsed.paintSeed === "number"
    ) {
      memoryInspectCache.set(link, parsed);
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeInspectCache(link: string, data: InspectData & { tombstone?: boolean }): Promise<void> {
  memoryInspectCache.set(link, data);
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(cacheKeyForInspectLink(link), JSON.stringify(data), "EX", TTL_SEC);
  } catch {
    /* ignore */
  }
}

/** After exhausting CSFloat without usable payload — blocks repeat HTTP for this inspect link. */
async function writeInspectTombstone(link: string): Promise<void> {
  const row: InspectData & { tombstone: boolean } = {
    floatValue: 0,
    paintIndex: 0,
    paintSeed: 0,
    tombstone: true,
  };
  await writeInspectCache(link, row);
}

async function fetchInspectDataFromApi(link: string): Promise<InspectData | null> {
  const keys = parseApiKeys();
  if (keys.length === 0) return null;

  let delay = 400;
  const maxAttempts = keys.length * 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slot = (keyIndex + attempt) % keys.length;
    const key = keys[slot];
    if (!key) break;
    await acquireCsFloatSlot();
    try {
      const req = await fetchFromCsFloatOnceForInspectLink(link, key);
      if (req == null) {
        return null;
      }
      const { status, body } = req;
      if (status === 429) {
        console.log(
          JSON.stringify({
            type: "csfloat_fetch",
            event: "rate_limited",
            keySlot: slot,
            ts: Date.now(),
          }),
        );
        await sleep(delay);
        delay = Math.min(delay * 2, 10_000);
        continue;
      }
      if (status !== 200) {
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        continue;
      }
      const info = (json as { iteminfo?: unknown })?.iteminfo ?? json;
      if (!info || typeof info !== "object") continue;

      const floatValue =
        parseFloat(String((info as { floatvalue?: unknown }).floatvalue ?? (info as { float_value?: unknown }).float_value ?? "0")) || 0;
      const paintIndex =
        parseInt(String((info as { paintindex?: unknown }).paintindex ?? (info as { paint_index?: unknown }).paint_index ?? "0"), 10) || 0;
      const paintSeed =
        parseInt(String((info as { paintseed?: unknown }).paintseed ?? (info as { paint_seed?: unknown }).paint_seed ?? "0"), 10) || 0;

      keyIndex = (slot + 1) % keys.length;
      return { floatValue, paintIndex, paintSeed };
    } catch (err) {
      console.error("[csfloat] fetch error:", err);
    } finally {
      releaseCsFloatSlot();
    }
  }
  return null;
}

export function phaseFromPaintIndex(
  paintIndex: number | null | undefined,
  itemName: string,
): string | null {
  if (paintIndex == null) return null;
  if (!itemName.toLowerCase().includes("doppler")) return null;
  return PAINT_INDEX_PHASE[paintIndex] ?? null;
}

export function mergeInspectCache(
  items: Array<{
    assetId: string;
    inspectLink: string | null;
    marketHashName: string;
    floatValue: number | null;
    phaseLabel: string | null;
  }>,
): number {
  let count = 0;
  for (const item of items) {
    const data = memoryInspectCache.get(item.inspectLink ?? "");
    if (!data || !item.inspectLink) continue;
    if (data.tombstone) continue;
    if (data.floatValue > 0) item.floatValue = data.floatValue;
    const phase = phaseFromPaintIndex(data.paintIndex, item.marketHashName);
    if (phase) item.phaseLabel = phase;
    count++;
  }
  return count;
}

export type CsFloatEnrichLog = {
  totalItems: number;
  newWithoutApi: number;
  sentToCsfloat: number;
  cacheHits: number;
  enriched: number;
  failed: number;
  durationMs: number;
  keyRotations: number;
};

/**
 * CSFloat for any merged item that still lacks float (after Steam API + trade merge), with inspect-link cache.
 * `apiAssetIds` is kept for metrics (`newWithoutApi`); API-sourced rows without `asset_properties` float still qualify.
 * Mutates items in place.
 */
export async function enrichNewItemsWithCsFloat(
  items: NormalizedItem[],
  apiAssetIds: Set<string>,
  logCtx?: { taskId?: string },
): Promise<CsFloatEnrichLog> {
  const t0 = Date.now();
  const keys = parseApiKeys();
  if (keys.length === 0) {
    return {
      totalItems: items.length,
      newWithoutApi: 0,
      sentToCsfloat: 0,
      cacheHits: 0,
      enriched: 0,
      failed: 0,
      durationMs: Date.now() - t0,
      keyRotations: 0,
    };
  }

  const targets = items.filter(
    (i) => i.inspectLink && (i.floatValue == null || i.floatValue <= 0),
  );
  const newWithoutApi = items.filter((i) => !apiAssetIds.has(i.assetId)).length;

  console.log(
    JSON.stringify({
      type: "csfloat_enrich_start",
      keysConfigured: keys.length,
      inspectCacheTtlSec: TTL_SEC,
      apiAssetIdCount: apiAssetIds.size,
      itemsNeedingFloatRequest: targets.length,
      newWithoutApiCount: newWithoutApi,
      maxParallel: CSFLOAT_MAX_PARALLEL,
      ts: Date.now(),
    }),
  );

  let cacheHits = 0;
  let enriched = 0;
  let failed = 0;
  let sentToCsfloat = 0;
  const keySlotStart = keyIndex;

  for (const item of targets) {
    const link = item.inspectLink!;
    const cached = await readInspectCache(link);
    if (cached) {
      cacheHits++;
      if (cached.tombstone) {
        continue;
      }
      if (cached.floatValue > 0) item.floatValue = cached.floatValue;
      const ph = phaseFromPaintIndex(cached.paintIndex, item.marketHashName);
      if (ph) item.phaseLabel = ph;
      enriched++;
      continue;
    }

    let inflight = inspectInflight.get(link);
    if (!inflight) {
      inflight = (async (): Promise<InspectData | null> => {
        sentToCsfloat++;
        const data = await fetchInspectDataFromApi(link);
        if (data === null) {
          await writeInspectTombstone(link);
          return null;
        }
        await writeInspectCache(link, data);
        return data;
      })();
      inspectInflight.set(link, inflight);
      inflight.finally(() => {
        inspectInflight.delete(link);
      });
    }

    const data = await inflight;
    if (data === null) {
      failed++;
      await sleep(80);
      continue;
    }
    if (data.floatValue > 0) item.floatValue = data.floatValue;
    const ph = phaseFromPaintIndex(data.paintIndex, item.marketHashName);
    if (ph) item.phaseLabel = ph;
    enriched++;

    await sleep(120);
  }

  const log: CsFloatEnrichLog = {
    totalItems: items.length,
    newWithoutApi,
    sentToCsfloat,
    cacheHits,
    enriched,
    failed,
    durationMs: Date.now() - t0,
    keyRotations: Math.abs(keyIndex - keySlotStart),
  };

  console.log(
    JSON.stringify({
      type: "guest_inv_csfloat",
      ...logCtx,
      ...log,
      ts: Date.now(),
    }),
  );

  return log;
}

/** @deprecated Prefer enrichNewItemsWithCsFloat; kept for compatibility. */
export function enrichFromInspectLinks(
  items: Array<{
    assetId: string;
    inspectLink: string | null;
    marketHashName: string;
    floatValue: number | null;
    phaseLabel: string | null;
  }>,
): number {
  return mergeInspectCache(items);
}
