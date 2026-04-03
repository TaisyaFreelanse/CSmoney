/**
 * Steam CS2 inventory fetching and normalization.
 *
 * Owner inventory: fetched via Steam Web API (IEconItems / GetPlayerItems or
 * the community endpoint with the server-side API key) — sees trade-locked items.
 *
 * Guest inventory: fetched using the community endpoint with the partner + token
 * derived from their trade URL (avoids the public profile /inventory/ endpoint
 * which is more aggressively rate-limited by Steam).
 */

const CS2_APP_ID = 730;
const CONTEXT_ID = "2";
const STEAM_CDN = "https://community.akamai.steamstatic.com/economy/image/";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SteamStickerInfo {
  name: string;
  iconUrl: string;
}

export interface NormalizedItem {
  assetId: string;
  classId: string;
  instanceId: string;
  marketHashName: string;
  name: string;
  iconUrl: string;
  rarity: string | null;
  rarityColor: string | null;
  type: string | null;
  wear: string | null;
  floatValue: number | null;
  phaseLabel: string | null;
  stickers: SteamStickerInfo[];
  tradeLockUntil: string | null;
  tradable: boolean;
  marketable: boolean;
}

// ---------------------------------------------------------------------------
// Trade URL helpers
// ---------------------------------------------------------------------------

const TRADE_URL_RE =
  /steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)&token=([A-Za-z0-9_-]+)/;

export function parseTradeUrl(url: string): { partner: string; token: string } | null {
  const m = TRADE_URL_RE.exec(url);
  if (!m) return null;
  return { partner: m[1], token: m[2] };
}

export function steamId64FromPartner(partner: string): string {
  return (BigInt(partner) + BigInt("76561197960265728")).toString();
}

// ---------------------------------------------------------------------------
// Phase detection (Doppler / Gamma Doppler / etc.)
// ---------------------------------------------------------------------------

const PHASE_TAGS: Record<string, string> = {
  "Phase 1": "Phase 1",
  "Phase 2": "Phase 2",
  "Phase 3": "Phase 3",
  "Phase 4": "Phase 4",
  Emerald: "Emerald",
  Sapphire: "Sapphire",
  Ruby: "Ruby",
  "Black Pearl": "Black Pearl",
};

function detectPhase(
  descriptions: Array<{ value?: string; color?: string }> | undefined,
): string | null {
  if (!descriptions) return null;
  for (const d of descriptions) {
    const val = d.value?.trim();
    if (!val) continue;
    for (const [key, label] of Object.entries(PHASE_TAGS)) {
      if (val.includes(key)) return label;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sticker extraction
// ---------------------------------------------------------------------------

const STICKER_RE =
  /src="(https?:\/\/[^"]+)"[^>]*><br>\s*([^<]+)/g;

function extractStickers(
  descriptions: Array<{ value?: string }> | undefined,
): SteamStickerInfo[] {
  if (!descriptions) return [];
  const stickers: SteamStickerInfo[] = [];
  for (const d of descriptions) {
    if (!d.value?.includes("sticker_info")) continue;
    let match: RegExpExecArray | null;
    STICKER_RE.lastIndex = 0;
    while ((match = STICKER_RE.exec(d.value)) !== null) {
      stickers.push({ iconUrl: match[1], name: match[2].trim() });
    }
  }
  return stickers;
}

// ---------------------------------------------------------------------------
// Wear mapping
// ---------------------------------------------------------------------------

function wearFromTags(
  tags: Array<{ category?: string; localized_tag_name?: string }> | undefined,
): string | null {
  if (!tags) return null;
  const t = tags.find((t) => t.category === "Exterior");
  return t?.localized_tag_name ?? null;
}

function rarityFromTags(
  tags: Array<{ category?: string; localized_tag_name?: string; color?: string }> | undefined,
): { rarity: string | null; rarityColor: string | null } {
  if (!tags) return { rarity: null, rarityColor: null };
  const t = tags.find((t) => t.category === "Rarity");
  return { rarity: t?.localized_tag_name ?? null, rarityColor: t?.color ? `#${t.color}` : null };
}

function typeFromTags(
  tags: Array<{ category?: string; localized_tag_name?: string }> | undefined,
): string | null {
  if (!tags) return null;
  const t = tags.find((t) => t.category === "Type");
  return t?.localized_tag_name ?? null;
}

// ---------------------------------------------------------------------------
// Float value extraction from inspect link (placeholder — requires external service)
// For MVP we parse the "Float: X.XXXX" that some enriched endpoints provide,
// or leave null if unavailable.
// ---------------------------------------------------------------------------

function extractFloat(
  descriptions: Array<{ value?: string }> | undefined,
): number | null {
  if (!descriptions) return null;
  for (const d of descriptions) {
    const m = /Float:\s*([\d.]+)/i.exec(d.value ?? "");
    if (m) return parseFloat(m[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trade lock detection
// ---------------------------------------------------------------------------

function detectTradeLock(
  descriptions: Array<{ value?: string; color?: string }> | undefined,
): string | null {
  if (!descriptions) return null;
  for (const d of descriptions) {
    const val = d.value ?? "";
    // Steam puts e.g. "Tradable After Mar 30, 2026 (7:00:00) GMT"
    const m = /Tradable After\s+(.+)/i.exec(val);
    if (m) {
      try {
        return new Date(m[1].replace(/\s*\(.*\)/, "")).toISOString();
      } catch {
        return m[1];
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalize raw Steam JSON into NormalizedItem[]
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeInventory(raw: any): NormalizedItem[] {
  const assets: any[] = raw?.assets ?? [];
  const descriptions: any[] = raw?.descriptions ?? [];

  const descMap = new Map<string, any>();
  for (const d of descriptions) {
    descMap.set(`${d.classid}_${d.instanceid}`, d);
  }

  const items: NormalizedItem[] = [];
  for (const a of assets) {
    const desc = descMap.get(`${a.classid}_${a.instanceid}`);
    if (!desc) continue;

    const icon = desc.icon_url ? `${STEAM_CDN}${desc.icon_url}` : "";
    const { rarity, rarityColor } = rarityFromTags(desc.tags);
    const phase = detectPhase(desc.descriptions);
    const tradeLockUntil = detectTradeLock(desc.descriptions);

    items.push({
      assetId: a.assetid,
      classId: a.classid,
      instanceId: a.instanceid,
      marketHashName: desc.market_hash_name ?? desc.name ?? "",
      name: desc.name ?? "",
      iconUrl: icon,
      rarity,
      rarityColor,
      type: typeFromTags(desc.tags),
      wear: wearFromTags(desc.tags),
      floatValue: extractFloat(desc.descriptions),
      phaseLabel: phase,
      stickers: extractStickers(desc.descriptions),
      tradeLockUntil,
      tradable: desc.tradable === 1,
      marketable: desc.marketable === 1,
    });
  }
  return items;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Fetch inventory via Steam community endpoint
// ---------------------------------------------------------------------------

async function fetchSteamInventoryRaw(
  steamId64: string,
  apiKey?: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  // If we have an API key, use the authenticated endpoint (sees trade-locked items)
  const url = apiKey
    ? `https://api.steampowered.com/IEconService/GetInventoryItemsWithDescriptions/v1/?key=${apiKey}&steamid=${steamId64}&appid=${CS2_APP_ID}&contextid=${CONTEXT_ID}&get_descriptions=true&count=5000`
    : `https://steamcommunity.com/inventory/${steamId64}/${CS2_APP_ID}/${CONTEXT_ID}?l=english&count=5000`;

  const res = await fetch(url, { next: { revalidate: 0 } });

  if (res.status === 403) return { ok: false, error: "private_inventory" };
  if (res.status === 429) return { ok: false, error: "steam_rate_limit" };
  if (!res.ok) return { ok: false, error: `steam_http_${res.status}` };

  const json = await res.json();

  // Authenticated endpoint wraps under response
  const data = apiKey ? (json as any)?.response : json;
  if (!data || (!data.assets && !data.descriptions)) {
    return { ok: false, error: "empty_inventory" };
  }
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchOwnerInventory(): Promise<
  { ok: true; items: NormalizedItem[] } | { ok: false; error: string }
> {
  const apiKey = process.env.STEAM_WEB_API_KEY;
  const ownerSteamId = process.env.OWNER_STEAM_ID;
  if (!apiKey) return { ok: false, error: "missing_steam_api_key" };
  if (!ownerSteamId) return { ok: false, error: "missing_owner_steam_id" };

  const result = await fetchSteamInventoryRaw(ownerSteamId, apiKey);
  if (!result.ok) return result;
  return { ok: true, items: normalizeInventory(result.data) };
}

export async function fetchGuestInventory(
  tradeUrl: string,
): Promise<{ ok: true; items: NormalizedItem[] } | { ok: false; error: string }> {
  const parsed = parseTradeUrl(tradeUrl);
  if (!parsed) return { ok: false, error: "invalid_trade_url" };

  const steamId64 = steamId64FromPartner(parsed.partner);
  const result = await fetchSteamInventoryRaw(steamId64);
  if (!result.ok) return result;
  return { ok: true, items: normalizeInventory(result.data) };
}
