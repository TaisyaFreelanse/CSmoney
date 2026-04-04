/**
 * Float value and Doppler phase enrichment via CSFloat API.
 *
 * Endpoint: GET https://api.csfloat.com/?s={steamid}&a={assetid}&d={d_param}
 * Auth: Authorization header with API key.
 * Rate limit: ~3 req/sec, 100k/day.
 *
 * Strategy:
 * - Background enrichment: items processed asynchronously with rate limiting.
 * - In-memory cache keyed by assetId.
 * - Merge on read: inventory routes merge cached data on every request.
 */

import https from "node:https";

const CSFLOAT_API_KEY = process.env.CSFLOAT_API_KEY ?? "";

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
};

export interface InspectData {
  floatValue: number;
  paintIndex: number;
  paintSeed: number;
}

const cache = new Map<string, InspectData>();
let enrichmentRunning = false;
let lastEnrichmentStart = 0;
const ENRICHMENT_COOLDOWN_MS = 5 * 60 * 1000;

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseInspectParams(link: string): { s: string; a: string; d: string } | null {
  const decoded = decodeURIComponent(link);
  const m = /S(\d+)A(\d+)D(\d+)/.exec(decoded);
  if (!m) return null;
  return { s: m[1], a: m[2], d: m[3] };
}

async function fetchFromCsFloat(
  s: string,
  a: string,
  d: string,
): Promise<InspectData | null> {
  const url = `https://api.csfloat.com/?s=${s}&a=${a}&d=${d}`;
  try {
    const { status, body } = await httpsGet(url, {
      Accept: "application/json",
      Authorization: CSFLOAT_API_KEY,
    });

    if (status === 429) {
      console.warn("[csfloat] rate limited");
      return null;
    }
    if (status !== 200) {
      console.warn(`[csfloat] status=${status} for a=${a}`);
      return null;
    }

    const json = JSON.parse(body);
    const info = json?.iteminfo ?? json;
    if (!info) return null;

    const floatValue =
      parseFloat(String(info.floatvalue ?? info.float_value ?? "0")) || 0;
    const paintIndex =
      parseInt(String(info.paintindex ?? info.paint_index ?? "0"), 10) || 0;
    const paintSeed =
      parseInt(String(info.paintseed ?? info.paint_seed ?? "0"), 10) || 0;

    return { floatValue, paintIndex, paintSeed };
  } catch (err) {
    console.error("[csfloat] fetch error:", err);
    return null;
  }
}

export function phaseFromPaintIndex(
  paintIndex: number | null | undefined,
  itemName: string,
): string | null {
  if (paintIndex == null) return null;
  if (!itemName.toLowerCase().includes("doppler")) return null;
  return PAINT_INDEX_PHASE[paintIndex] ?? null;
}

interface EnrichableItem {
  assetId: string;
  inspectLink: string | null;
  marketHashName: string;
  floatValue: number | null;
  phaseLabel: string | null;
}

export function mergeInspectCache(items: EnrichableItem[]): number {
  let count = 0;
  for (const item of items) {
    const data = cache.get(item.assetId);
    if (!data) continue;
    if (data.floatValue > 0) item.floatValue = data.floatValue;
    const phase = phaseFromPaintIndex(data.paintIndex, item.marketHashName);
    if (phase) item.phaseLabel = phase;
    count++;
  }
  return count;
}

export function startBackgroundEnrichment(items: EnrichableItem[]): void {
  if (enrichmentRunning) return;
  if (Date.now() - lastEnrichmentStart < ENRICHMENT_COOLDOWN_MS) return;
  if (!CSFLOAT_API_KEY) {
    console.warn("[csfloat] CSFLOAT_API_KEY not set, skipping enrichment");
    return;
  }

  const toEnrich = items.filter(
    (i) => i.inspectLink && !cache.has(i.assetId),
  );

  if (toEnrich.length === 0) return;

  console.log(`[csfloat] starting background enrichment: ${toEnrich.length} items`);
  enrichmentRunning = true;
  lastEnrichmentStart = Date.now();

  (async () => {
    let success = 0;
    let fail = 0;
    let rateLimitStreak = 0;

    for (const item of toEnrich) {
      const params = parseInspectParams(item.inspectLink!);
      if (!params || params.s === "0") {
        fail++;
        continue;
      }

      try {
        const data = await fetchFromCsFloat(params.s, params.a, params.d);
        if (data === null) {
          rateLimitStreak++;
          fail++;
        } else if (data.floatValue > 0 || data.paintIndex > 0) {
          cache.set(item.assetId, data);
          if (data.floatValue > 0) item.floatValue = data.floatValue;
          const phase = phaseFromPaintIndex(data.paintIndex, item.marketHashName);
          if (phase) item.phaseLabel = phase;
          success++;
          rateLimitStreak = 0;
        } else {
          fail++;
          rateLimitStreak = 0;
        }
      } catch {
        fail++;
      }

      if (rateLimitStreak > 10) {
        console.warn("[csfloat] too many failures in a row, pausing");
        break;
      }

      await sleep(350);
    }

    const withFloat = items.filter((i) => i.floatValue != null && i.floatValue > 0).length;
    const withPhase = items.filter((i) => i.phaseLabel != null).length;
    console.log(
      `[csfloat] enrichment done: success=${success}, fail=${fail}, cached=${cache.size}, with_float=${withFloat}, with_phase=${withPhase}`,
    );
    enrichmentRunning = false;
  })();
}

export function enrichFromInspectLinks(items: EnrichableItem[]): number {
  const merged = mergeInspectCache(items);
  startBackgroundEnrichment(items);
  return merged;
}
