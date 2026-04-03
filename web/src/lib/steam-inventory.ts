/**
 * Steam CS2 inventory fetching and normalization.
 *
 * Multiple fetch strategies are attempted in order:
 * 1. IEconService API (with Steam Web API Key)
 * 2. Community endpoint (new format)
 * 3. Community endpoint (old JSON format /inventory/json/)
 *
 * Steam aggressively blocks server-side requests from cloud IPs.
 * We use Node.js native https to avoid Next.js fetch patching interference.
 */

import https from "node:https";

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
  inspectLink: string | null;
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
// Phase detection
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
  tags: Array<{ category?: string; internal_name?: string; localized_tag_name?: string }> | undefined,
): string | null {
  if (tags) {
    for (const t of tags) {
      const name = t.localized_tag_name ?? t.internal_name ?? "";
      for (const [key, label] of Object.entries(PHASE_TAGS)) {
        if (name.includes(key)) return label;
      }
    }
  }
  if (descriptions) {
    for (const d of descriptions) {
      const val = d.value?.trim();
      if (!val) continue;
      for (const [key, label] of Object.entries(PHASE_TAGS)) {
        if (val.includes(key)) return label;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sticker extraction
// ---------------------------------------------------------------------------

function extractStickers(
  descriptions: Array<{ value?: string }> | undefined,
): SteamStickerInfo[] {
  if (!descriptions) return [];
  const stickers: SteamStickerInfo[] = [];
  for (const d of descriptions) {
    if (!d.value?.includes("sticker_info")) continue;
    const html = d.value;

    const re = /<img[^>]+src="([^"]+)"[^>]*>\s*(?:<br\s*\/?\s*>)\s*([^<]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const url = match[1];
      const name = match[2].trim();
      if (url && name) stickers.push({ iconUrl: url, name });
    }

    if (stickers.length === 0) {
      const altRe = /<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/gi;
      while ((match = altRe.exec(html)) !== null) {
        const url = match[1];
        const alt = match[2].replace(/^Sticker\s*\|\s*/i, "").trim();
        if (url && alt) stickers.push({ iconUrl: url, name: alt });
      }
    }
  }
  return stickers;
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

function wearFromTags(
  tags: Array<{ category?: string; localized_tag_name?: string }> | undefined,
): string | null {
  if (!tags) return null;
  return tags.find((t) => t.category === "Exterior")?.localized_tag_name ?? null;
}

function rarityFromTags(
  tags: Array<{ category?: string; localized_tag_name?: string; color?: string }> | undefined,
): { rarity: string | null; rarityColor: string | null } {
  if (!tags) return { rarity: null, rarityColor: null };
  const t = tags.find((t) => t.category === "Rarity");
  return {
    rarity: t?.localized_tag_name ?? null,
    rarityColor: t?.color ? `#${t.color}` : null,
  };
}

function typeFromTags(
  tags: Array<{ category?: string; localized_tag_name?: string }> | undefined,
): string | null {
  if (!tags) return null;
  return tags.find((t) => t.category === "Type")?.localized_tag_name ?? null;
}

function extractFloat(
  descriptions: Array<{ value?: string }> | undefined,
): number | null {
  if (!descriptions) return null;
  for (const d of descriptions) {
    const val = d.value ?? "";
    const m = /(?:Float|Wear\s*Rating|Степень\s*износа)\s*:?\s*([\d.]+)/i.exec(val);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function extractInspectLink(actions: Array<{ link?: string; name?: string }> | undefined): string | null {
  if (!actions) return null;
  for (const a of actions) {
    if (a.link && a.link.includes("csgo_econ_action_preview")) return a.link;
  }
  return null;
}

function detectTradeLock(
  descriptions: Array<{ value?: string; color?: string }> | undefined,
): string | null {
  if (!descriptions) return null;
  for (const d of descriptions) {
    const val = d.value ?? "";

    const patterns = [
      /Tradable After\s+(.+)/i,
      /(?:cannot be (?:traded|consumed|modified|transferred) until|trade cooldown[^:]*:\s*)(.+)/i,
      /(?:Trade Protected|Торговая блокировка)[^a-zA-Z]*(?:until|до)\s+(.+)/i,
    ];
    for (const re of patterns) {
      const m = re.exec(val);
      if (m) {
        const raw = m[1].replace(/\s*\(.*\)/, "").replace(/\s*GMT.*/, "").trim();
        try {
          const parsed = new Date(raw);
          if (!isNaN(parsed.getTime())) return parsed.toISOString();
        } catch { /* fall through */ }
        return raw;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalizer — handles both new and old Steam JSON formats
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeInventory(raw: any): NormalizedItem[] {
  // New format: { assets: [...], descriptions: [...] }
  // Old format: { rgInventory: { assetid: {...} }, rgDescriptions: { classid_instanceid: {...} } }
  let assets: any[] = [];
  let descriptions: any[] = [];

  if (Array.isArray(raw?.assets)) {
    assets = raw.assets;
    descriptions = raw.descriptions ?? [];
  } else if (raw?.rgInventory && raw?.rgDescriptions) {
    // Old format
    const rgInv = raw.rgInventory;
    const rgDesc = raw.rgDescriptions;
    assets = Object.values(rgInv).map((a: any) => ({
      assetid: a.id,
      classid: a.classid,
      instanceid: a.instanceid,
      amount: a.amount,
    }));
    descriptions = Object.values(rgDesc);
  }

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
    const phase = detectPhase(desc.descriptions, desc.tags);
    const tradeLockUntil = detectTradeLock(desc.descriptions);

    const inspectRaw = extractInspectLink(desc.actions);
    const inspectLink = inspectRaw
      ? inspectRaw.replace("%owner_steamid%", "0").replace("%assetid%", a.assetid ?? a.id)
      : null;

    items.push({
      assetId: a.assetid ?? a.id,
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
      inspectLink,
      tradable: desc.tradable === 1 || desc.tradable === true,
      marketable: desc.marketable === 1 || desc.marketable === true,
    });
  }
  return items;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Native HTTPS fetcher (bypasses Next.js fetch patching)
// ---------------------------------------------------------------------------

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
      reject(new Error("timeout"));
    });
  });
}

// ---------------------------------------------------------------------------
// Strategy 1: IEconService API
// ---------------------------------------------------------------------------

async function fetchViaApi(
  steamId64: string,
  apiKey: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const url = `https://api.steampowered.com/IEconService/GetInventoryItemsWithDescriptions/v1/?key=${apiKey}&steamid=${steamId64}&appid=${CS2_APP_ID}&contextid=${CONTEXT_ID}&get_descriptions=1&count=1000&language=english`;
  console.log(`[steam-inv] strategy=api steamid=${steamId64} appid=${CS2_APP_ID}`);

  try {
    const { status, body } = await httpsGet(url);
    console.log(`[steam-inv] api HTTP ${status}, body_len=${body.length}, preview: ${body.slice(0, 300)}`);
    if (status !== 200) {
      return { ok: false, error: `steam_api_${status}` };
    }
    const json = JSON.parse(body);
    const data = json?.response;
    const keys = data ? Object.keys(data) : [];
    console.log(`[steam-inv] api response keys: [${keys.join(",")}] total=${data?.total_inventory_count}`);
    if (!data?.assets && !data?.descriptions) {
      return { ok: false, error: "empty_or_private_inventory" };
    }
    console.log(`[steam-inv] api OK: ${data.assets?.length ?? 0} assets, ${data.descriptions?.length ?? 0} descriptions`);
    return { ok: true, data };
  } catch (e) {
    console.error(`[steam-inv] api error:`, e);
    return { ok: false, error: "steam_api_error" };
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Community endpoint (new format)
// ---------------------------------------------------------------------------

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

async function fetchViaCommunityNew(
  steamId64: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  console.log(`[steam-inv] strategy=community-new (paginated)`);

  const allAssets: unknown[] = [];
  const descMap = new Map<string, unknown>();
  let startAssetId: string | undefined;
  const MAX_PAGES = 10;

  for (let page = 0; page < MAX_PAGES; page++) {
    let url = `https://steamcommunity.com/inventory/${steamId64}/${CS2_APP_ID}/${CONTEXT_ID}?l=english&count=2000`;
    if (startAssetId) url += `&start_assetid=${startAssetId}`;

    try {
      const { status, body } = await httpsGet(url, BROWSER_HEADERS);
      if (status === 403) return { ok: false, error: "private_inventory" };
      if (status === 429) return { ok: false, error: "steam_rate_limit" };
      if (status !== 200) {
        console.error(`[steam-inv] community-new HTTP ${status}: ${body.slice(0, 300)}`);
        return { ok: false, error: `steam_http_${status}` };
      }
      const json = JSON.parse(body);
      if (page === 0 && !json?.assets && !json?.descriptions) {
        console.error(`[steam-inv] community-new empty:`, body.slice(0, 300));
        return { ok: false, error: "empty_inventory" };
      }

      if (Array.isArray(json.assets)) {
        allAssets.push(...json.assets);
      }
      if (Array.isArray(json.descriptions)) {
        for (const d of json.descriptions) {
          const key = `${d.classid}_${d.instanceid}`;
          if (!descMap.has(key)) descMap.set(key, d);
        }
      }

      console.log(`[steam-inv] community-new page=${page}: +${json.assets?.length ?? 0} assets (total=${allAssets.length}, more=${json.more_items ?? 0})`);

      if (!json.more_items || !json.last_assetid) break;
      startAssetId = json.last_assetid;
    } catch (e) {
      console.error(`[steam-inv] community-new error (page=${page}):`, e);
      if (allAssets.length > 0) break;
      return { ok: false, error: "community_error" };
    }
  }

  if (allAssets.length === 0) {
    return { ok: false, error: "empty_inventory" };
  }

  console.log(`[steam-inv] community-new TOTAL: ${allAssets.length} assets, ${descMap.size} descriptions`);
  return {
    ok: true,
    data: { assets: allAssets, descriptions: Array.from(descMap.values()) },
  };
}

// ---------------------------------------------------------------------------
// Strategy 3: Community endpoint (old JSON format)
// ---------------------------------------------------------------------------

async function fetchViaCommunityOld(
  steamId64: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const url = `https://steamcommunity.com/profiles/${steamId64}/inventory/json/${CS2_APP_ID}/${CONTEXT_ID}?l=english&trading=1`;
  console.log(`[steam-inv] strategy=community-old`);

  try {
    const { status, body } = await httpsGet(url, BROWSER_HEADERS);
    if (status === 403) return { ok: false, error: "private_inventory" };
    if (status === 429) return { ok: false, error: "steam_rate_limit" };
    if (status !== 200) {
      console.error(`[steam-inv] community-old HTTP ${status}: ${body.slice(0, 300)}`);
      return { ok: false, error: `steam_http_${status}` };
    }
    const json = JSON.parse(body);
    if (json?.success !== true && json?.success !== 1) {
      console.error(`[steam-inv] community-old success=false:`, body.slice(0, 300));
      return { ok: false, error: "steam_rejected" };
    }
    if (!json?.rgInventory || Object.keys(json.rgInventory).length === 0) {
      console.error(`[steam-inv] community-old empty inventory`);
      return { ok: false, error: "empty_inventory" };
    }
    console.log(`[steam-inv] community-old OK: ${Object.keys(json.rgInventory).length} items`);
    return { ok: true, data: json };
  } catch (e) {
    console.error(`[steam-inv] community-old error:`, e);
    return { ok: false, error: "community_old_error" };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator: tries all strategies in order
// ---------------------------------------------------------------------------

async function fetchSteamInventoryRaw(
  steamId64: string,
  apiKey?: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const errors: string[] = [];

  if (apiKey) {
    const r = await fetchViaApi(steamId64, apiKey);
    if (r.ok) return r;
    errors.push(`api:${r.error}`);
  }

  const r2 = await fetchViaCommunityNew(steamId64);
  if (r2.ok) return r2;
  errors.push(`new:${r2.error}`);

  const r3 = await fetchViaCommunityOld(steamId64);
  if (r3.ok) return r3;
  errors.push(`old:${r3.error}`);

  console.error(`[steam-inv] ALL strategies failed for ${steamId64}: ${errors.join(", ")}`);
  return { ok: false, error: `all_failed(${errors.join(",")})` };
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
