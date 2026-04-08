/**
 * PriceEmpire integration: fetch catalog prices and upsert into PriceCatalogItem.
 */

import { prisma } from "@/lib/prisma";

const API_BASE = "https://api.pricempire.com/v4/trader/items/prices";

export interface PriceEmpireItem {
  market_hash_name: string;
  prices: Array<{
    price: number; // cents
    count?: number;
    updated_at?: string;
    provider_key: string;
  }>;
}

/**
 * Fetch all CS2 prices from PriceEmpire for the given sources.
 * Returns raw items array.
 */
export async function fetchPriceEmpireCatalog(
  sources: string[] = ["buff163", "skins"],
): Promise<PriceEmpireItem[]> {
  const apiKey = process.env.PRICEMPIRE_API_KEY;
  if (!apiKey) throw new Error("PRICEMPIRE_API_KEY not set");

  const params = new URLSearchParams({
    app_id: "730",
    sources: sources.join(","),
    currency: "USD",
  });

  const res = await fetch(`${API_BASE}?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PriceEmpire ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Run a full price sync: fetch catalog, upsert into DB.
 * Returns number of upserted rows and any errors.
 */
export async function syncPrices(): Promise<{
  upserted: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let items: PriceEmpireItem[];

  try {
    items = await fetchPriceEmpireCatalog();
  } catch (e) {
    return { upserted: 0, errors: [(e as Error).message] };
  }

  let upserted = 0;

  for (const item of items) {
    for (const p of item.prices) {
      if (p.price <= 0) continue;

      const { baseName, phaseKey } = extractPhaseFromName(item.market_hash_name);

      try {
        await prisma.priceCatalogItem.upsert({
          where: {
            marketHashName_phaseKey_providerKey: {
              marketHashName: baseName,
              phaseKey,
              providerKey: p.provider_key,
            },
          },
          create: {
            marketHashName: baseName,
            phaseKey,
            providerKey: p.provider_key,
            priceUsd: p.price,
          },
          update: {
            priceUsd: p.price,
          },
        });
        upserted++;
      } catch (e) {
        errors.push(`${item.market_hash_name}: ${(e as Error).message}`);
        if (errors.length > 50) break;
      }
    }
    if (errors.length > 50) break;
  }

  return { upserted, errors: errors.slice(0, 20) };
}

const PHASE_NAMES = [
  "Phase 1",
  "Phase 2",
  "Phase 3",
  "Phase 4",
  "Emerald",
  "Sapphire",
  "Ruby",
  "Black Pearl",
];

/**
 * PriceEmpire appends phase as a suffix: "... - Phase 2", "... - Ruby".
 * Returns { baseName: name without suffix, phaseKey }.
 */
function extractPhaseFromName(name: string): { baseName: string; phaseKey: string } {
  for (const p of PHASE_NAMES) {
    const suffix = ` - ${p}`;
    if (name.endsWith(suffix)) {
      return { baseName: name.slice(0, -suffix.length), phaseKey: p };
    }
  }
  return { baseName: name, phaseKey: "default" };
}

// ---------------------------------------------------------------------------
// Price resolution: given an item, resolve the final display price
// ---------------------------------------------------------------------------

export interface ResolvedPrice {
  priceUsd: number; // cents
  source: "catalog" | "manual" | "unavailable";
  belowThreshold: boolean;
}

/**
 * Cents that count toward trade balance (must match trade UI: items with belowThreshold
 * are excluded from "Вы отдаёте" / "Вы получаете" sums even though resolvePrice still
 * returns a raw catalog cents value for display).
 */
export function centsCountedInTradeTotal(p: ResolvedPrice): number {
  if (p.belowThreshold) return 0;
  return p.priceUsd;
}

type PricingSettingsRow = Awaited<ReturnType<typeof _loadSettings>>;
type OwnerManualRow = Awaited<ReturnType<typeof prisma.ownerManualPrice.findMany>>[number];
type CatalogRow = Awaited<ReturnType<typeof prisma.priceCatalogItem.findMany>>[number];

function catalogCellKey(marketHashName: string, phaseKey: string) {
  return `${marketHashName}\0${phaseKey}`;
}

/** Public: same key stored on OwnerManualPrice.catalogMatchKey and used for guest-side manual lookup. */
export function pricingCatalogMatchKey(marketHashName: string, phaseLabel: string | null): string {
  return catalogCellKey(marketHashName, phaseLabel ?? "default");
}

function indexManualByCatalogKey(rows: OwnerManualRow[]): Map<string, OwnerManualRow> {
  const m = new Map<string, OwnerManualRow>();
  for (const row of rows) {
    const k = row.catalogMatchKey;
    if (!k) continue;
    const prev = m.get(k);
    if (!prev || row.setAt > prev.setAt) m.set(k, row);
  }
  return m;
}

function pickCatalogRow(
  map: Map<string, CatalogRow>,
  marketHashName: string,
  phaseKey: string,
): CatalogRow | null {
  const exact = map.get(catalogCellKey(marketHashName, phaseKey));
  if (exact) return exact;
  if (phaseKey !== "default") {
    return map.get(catalogCellKey(marketHashName, "default")) ?? null;
  }
  return null;
}

/**
 * Single base (USD cents) for an item, then side-specific multipliers:
 * - guest: base × (1 − markupGuestPercent/100)
 * - owner: base × (1 + markupOwnerPercent/100)
 */
function applySideMarkupFromBase(
  baseCents: number,
  side: "owner" | "guest",
  settings: PricingSettingsRow,
): number {
  if (side === "owner") {
    return Math.round(baseCents * (1 + settings.markupOwnerPercent / 100));
  }
  const discounted = Math.round(baseCents * (1 - settings.markupGuestPercent / 100));
  return Math.max(0, discounted);
}

/** basePrice = custom ?? api; then guest/owner markups from settings. */
function computeResolvedPrice(
  settings: PricingSettingsRow,
  side: "owner" | "guest",
  manual: OwnerManualRow | null | undefined,
  catalogItem: CatalogRow | null,
): ResolvedPrice {
  const manualMode = manual?.mode === "markup_percent" ? "markup_percent" : "fixed";

  if (manual && manualMode === "fixed" && manual.priceUsd != null) {
    const dollars = Number(manual.priceUsd);
    if (dollars > 0) {
      const baseCents = Math.round(dollars * 100);
      return {
        priceUsd: applySideMarkupFromBase(baseCents, side, settings),
        source: "manual",
        belowThreshold: false,
      };
    }
  }

  if (!catalogItem) {
    return { priceUsd: 0, source: "unavailable", belowThreshold: true };
  }

  const apiCents = catalogItem.priceUsd;
  const apiDollars = apiCents / 100;

  if (manual && manualMode === "markup_percent" && manual.markupPercent != null) {
    const baseCents = Math.round(apiCents * (1 + manual.markupPercent / 100));
    return {
      priceUsd: applySideMarkupFromBase(baseCents, side, settings),
      source: "manual",
      belowThreshold: false,
    };
  }

  if (apiDollars < settings.minPriceThresholdUsd) {
    return {
      priceUsd: applySideMarkupFromBase(apiCents, side, settings),
      source: "catalog",
      belowThreshold: true,
    };
  }

  return {
    priceUsd: applySideMarkupFromBase(apiCents, side, settings),
    source: "catalog",
    belowThreshold: false,
  };
}

/**
 * Resolve prices for many items with O(1) DB round-trips (settings cache + 2× findMany),
 * instead of ~3 queries per item.
 */
export async function resolvePricesBatch(
  items: Array<{ marketHashName: string; phaseLabel: string | null; assetId: string | null }>,
  side: "owner" | "guest",
): Promise<ResolvedPrice[]> {
  if (items.length === 0) return [];

  const settings = await getPricingSettings();
  const provider = settings.selectedPriceProvider;

  const assetIds = [...new Set(items.map((i) => i.assetId).filter((id): id is string => Boolean(id)))];

  const nameList = [...new Set(items.map((i) => i.marketHashName))].filter((n) => n.length > 0);

  const [manualRows, catalogRows] = await Promise.all([
    assetIds.length > 0
      ? prisma.ownerManualPrice.findMany({ where: { assetId: { in: assetIds } } })
      : Promise.resolve([]),
    nameList.length > 0
      ? prisma.priceCatalogItem.findMany({
          where: { providerKey: provider, marketHashName: { in: nameList } },
        })
      : Promise.resolve([]),
  ]);

  const manualByAsset = new Map(manualRows.map((m) => [m.assetId, m]));
  const manualByCatalogKey = indexManualByCatalogKey(manualRows);
  const catalogMap = new Map<string, CatalogRow>();
  for (const row of catalogRows) {
    catalogMap.set(catalogCellKey(row.marketHashName, row.phaseKey), row);
  }

  return items.map((item) => {
    const phaseKey = item.phaseLabel ?? "default";
    const skinKey = catalogCellKey(item.marketHashName, phaseKey);
    const manual =
      (item.assetId ? manualByAsset.get(item.assetId) : undefined) ?? manualByCatalogKey.get(skinKey);
    const catalogItem = pickCatalogRow(catalogMap, item.marketHashName, phaseKey);
    return computeResolvedPrice(settings, side, manual, catalogItem);
  });
}

export async function resolvePrice(
  marketHashName: string,
  phaseLabel: string | null,
  assetId: string | null,
  side: "owner" | "guest",
): Promise<ResolvedPrice> {
  const [one] = await resolvePricesBatch([{ marketHashName, phaseLabel, assetId }], side);
  return one!;
}

let _settingsCache: {
  data: Awaited<ReturnType<typeof _loadSettings>>;
  at: number;
} | null = null;

async function _loadSettings() {
  let s = await prisma.pricingSettings.findUnique({
    where: { id: "singleton" },
  });
  if (!s) {
    s = await prisma.pricingSettings.create({ data: { id: "singleton" } });
  }
  return s;
}

export async function getPricingSettings() {
  const now = Date.now();
  if (_settingsCache && now - _settingsCache.at < 30_000) {
    return _settingsCache.data;
  }
  const data = await _loadSettings();
  _settingsCache = { data, at: now };
  return data;
}

export function invalidateSettingsCache() {
  _settingsCache = null;
}
