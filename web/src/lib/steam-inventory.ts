/**
 * Steam CS2 inventory fetching and normalization.
 *
 * Fetch strategies attempted in order:
 * 1. Community endpoint (new format — includes asset_properties with float/phase)
 * 2. Community endpoint (old JSON format /inventory/json/)
 *
 * Steam aggressively blocks server-side requests from cloud IPs.
 * We use Node.js native https to avoid Next.js fetch patching interference.
 */

import https from "node:https";

import {
  logSteamProfilesStorageHint,
  recordSteamProfileSuccess,
  resolveOwnerPuppeteerAccount,
} from "./steam-puppeteer-accounts";
import { normalizeSteamId64ForCache, parseTradeUrl, steamId64FromPartner } from "./steam-community-url";

export {
  normalizeSteamId64ForCache,
  parseTradeUrl,
  steamId64FromPartner,
  tradeOfferUrlsEquivalent,
  trySteamId64FromPartner,
} from "./steam-community-url";

const CS2_APP_ID = 730;
/** Default CS2 inventory context (in-game items). Guest inventory always uses this. */
export const DEFAULT_CS2_INVENTORY_CONTEXT_ID = "2";
const STEAM_CDN = "https://community.akamai.steamstatic.com/economy/image/";

/** Owner/store inventory context — must match the export you paste in admin (e.g. myskins.json often uses "16"). */
export function resolveOwnerInventoryContextId(): string {
  const c = process.env.OWNER_INVENTORY_CONTEXT_ID?.trim();
  if (c && /^\d+$/.test(c)) return c;
  return DEFAULT_CS2_INVENTORY_CONTEXT_ID;
}

/**
 * Steam community inventory from datacenter IPs often returns empty / private for non-default contexts (e.g. 16),
 * while the browser (logged in) gets full JSON. If the preferred context fails this way, we fall back to 2.
 */
export function ownerInventoryErrorAllowsDefaultContextFallback(error: string): boolean {
  return (
    error.includes("empty_inventory") ||
    error.includes("private_inventory") ||
    error.includes("community_old_error")
  );
}

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

/**
 * Merge browser + API inventory: on duplicate `assetId`, the API item wins (float/phase from asset_properties).
 */
export function mergeInventoriesPreferApi(apiItems: NormalizedItem[], browserItems: NormalizedItem[]): NormalizedItem[] {
  const m = new Map<string, NormalizedItem>();
  for (const i of browserItems) m.set(i.assetId, i);
  for (const i of apiItems) m.set(i.assetId, i);
  return [...m.values()];
}

// ---------------------------------------------------------------------------
// Phase detection — paint index from asset_properties (Finish Catalog)
// ---------------------------------------------------------------------------

const PAINT_INDEX_PHASE: Record<number, string> = {
  // Doppler (gen 1 — Bayonet, Flip, Gut, Karambit, M9, etc.)
  415: "Ruby",
  416: "Sapphire",
  417: "Black Pearl",
  418: "Phase 1",
  419: "Phase 2",
  420: "Phase 3",
  421: "Phase 4",
  // Gamma Doppler (gen 1)
  568: "Emerald",
  569: "Phase 1",
  570: "Phase 2",
  571: "Phase 3",
  572: "Phase 4",
  // Doppler gen 2 (Butterfly, Shadow Daggers) — verified via cs2items.pro
  617: "Black Pearl",
  618: "Phase 2",
  619: "Sapphire",
  // Doppler gen 3 (Talon Knife) — verified via cs2items.pro
  852: "Phase 1",
  853: "Phase 2",
  854: "Phase 3",
  855: "Phase 4",
};

interface AssetPropertyExtract {
  floatValue: number | null;
  paintIndex: number | null;
  /** Map of propertyid → string_value (e.g. pid 6 = Item Certificate hex). */
  stringProps: Map<number, string>;
}

function extractFromAssetProperties(
  assetProperties: Array<Record<string, unknown>> | undefined,
): AssetPropertyExtract {
  if (!assetProperties || !Array.isArray(assetProperties)) {
    return { floatValue: null, paintIndex: null, stringProps: new Map() };
  }

  let floatValue: number | null = null;
  let paintIndex: number | null = null;
  const stringProps = new Map<number, string>();

  for (const prop of assetProperties) {
    const pid = Number(prop.propertyid);
    if (pid === 2 && prop.float_value != null) {
      const parsed = parseFloat(String(prop.float_value));
      if (!isNaN(parsed) && parsed > 0) floatValue = parsed;
    }
    if (pid === 7 && prop.int_value != null) {
      const parsed = parseInt(String(prop.int_value), 10);
      if (!isNaN(parsed)) paintIndex = parsed;
    }
    if (typeof prop.string_value === "string" && prop.string_value) {
      stringProps.set(pid, prop.string_value);
    }
  }

  return { floatValue, paintIndex, stringProps };
}

const INSPECT_PREFIX = "steam://run/730//+csgo_econ_action_preview%20";

/**
 * Build the inspect link for a CS2 item.
 *
 * Steam's new inventory format stores the full protobuf-encoded «Item Certificate»
 * in asset_properties propertyid 6 (string_value). This hex blob already encodes
 * S (steamid), A (assetid), D (inspect code) internally, so using it directly as
 *   steam://rungame/730/.../+csgo_econ_action_preview%20<hex>
 * gives a working in-game inspect.
 *
 * When Item Certificate is available, we prefer it over the old template-based
 * approach (%owner_steamid%, %assetid%, D…) which sometimes produces broken links.
 */
function resolveInspectLink(
  template: string,
  ownerSteamId: string,
  assetId: string,
  stringProps: Map<number, string>,
): string {
  const itemCert = stringProps.get(6);
  if (itemCert) {
    return INSPECT_PREFIX + itemCert;
  }

  let link = template
    .replace("%owner_steamid%", ownerSteamId)
    .replace("%assetid%", assetId);

  link = link.replace(/%propid:(\d+)%/g, (_, pidStr) => {
    const pid = parseInt(pidStr, 10);
    return stringProps.get(pid) ?? "";
  });

  return link;
}

/** Ruby / Sapphire / Phase N etc. apply only to Doppler (incl. Gamma) knives — not to other skins' stickers or descriptions. */
function isDopplerFamilySkin(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("doppler"); // matches "Gamma Doppler" too
}

function phaseFromPaintIndex(paintIndex: number | null, itemName: string): string | null {
  if (paintIndex == null) return null;
  if (!isDopplerFamilySkin(itemName)) return null;
  return PAINT_INDEX_PHASE[paintIndex] ?? null;
}

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

function detectPhaseFromTagsDescs(
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

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractHtmlAttr(tag: string, attr: string): string | null {
  const dq = new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  if (dq) return dq[1];
  const sq = new RegExp(`${attr}\\s*=\\s*'([^']*)'`, "i").exec(tag);
  if (sq) return sq[1];
  return null;
}

/** Strip Steam prefixes; empty if alt/title is only the word "Sticker". */
function normalizeStickerLabel(raw: string): string {
  let s = decodeHtmlEntities(raw).replace(/\s+/g, " ").trim();
  s = s.replace(/^Sticker:?\s*/i, "").replace(/^Sticker\s*\|\s*/i, "").trim();
  if (!s || /^sticker$/i.test(s)) return "";
  return s;
}

function parseStickerNameFromImgTag(tag: string): string {
  for (const attr of ["title", "alt"] as const) {
    const v = extractHtmlAttr(tag, attr);
    if (v) {
      const n = normalizeStickerLabel(v);
      if (n) return n;
    }
  }
  return "";
}

function extractStickers(
  descriptions: Array<{ value?: string }> | undefined,
): SteamStickerInfo[] {
  if (!descriptions) return [];
  const stickers: SteamStickerInfo[] = [];
  for (const d of descriptions) {
    if (!d.value?.includes("sticker_info")) continue;
    const html = d.value;

    const imgTags = html.match(/<img[^>]+>/gi) ?? [];
    const rowStart = stickers.length;
    let searchPos = 0;
    for (let i = 0; i < imgTags.length; i++) {
      const tag = imgTags[i];
      const idx = html.indexOf(tag, searchPos);
      if (idx === -1) break;
      searchPos = idx + tag.length;

      const url = extractHtmlAttr(tag, "src");
      if (!url) continue;

      let name = parseStickerNameFromImgTag(tag);

      if (!name) {
        const afterTagPos = idx + tag.length;
        const nextIdx =
          i + 1 < imgTags.length ? html.indexOf(imgTags[i + 1], afterTagPos) : -1;
        const chunkEnd = nextIdx === -1 ? html.length : nextIdx;
        let chunk = html.slice(afterTagPos, chunkEnd);
        chunk = chunk
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/gi, " ");
        const lines = chunk
          .split(/\n+/)
          .map((l) => normalizeStickerLabel(l))
          .filter((l) => l.length > 0);
        if (lines.length > 0) name = lines[0];
      }

      stickers.push({ iconUrl: url, name });
    }

    // Steam often lists all names once after the last sticker image (comma-separated).
    const row = stickers.slice(rowStart);
    if (row.length > 0) {
      const unnamed = row.filter((s) => !s.name);
      if (unnamed.length > 0 && imgTags.length > 0) {
        const lastTag = imgTags[imgTags.length - 1];
        const lastIdx = html.lastIndexOf(lastTag);
        if (lastIdx !== -1) {
          const tail = html
            .slice(lastIdx + lastTag.length)
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ");
          const parts = tail
            .split(/[,，]/)
            .map((p) => normalizeStickerLabel(p))
            .filter((p) => p.length > 0);
          let pi = 0;
          for (const s of row) {
            if (!s.name && pi < parts.length) {
              s.name = parts[pi]!;
              pi++;
            }
          }
        }
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

/**
 * Parse a Steam trade-lock date fragment into UTC ISO.
 * Steam uses GMT for these strings; `new Date(string)` without a zone uses the host's local TZ,
 * which skews `toISOString()` and any "hours until unlock" math.
 */
export function steamTradeLockMiddleToIso(middle: string): string | null {
  let s = middle.trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // "Sep 21, 2025 (7:00:00)" → "Sep 21, 2025 7:00:00" before appending GMT
  s = s.replace(/\s*\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*/gi, " $1 ");
  s = s.replace(/\s*\([^)]*\)/g, "");
  s = s.replace(/\s*GMT\s*$/i, "").trim();
  if (!s) return null;

  const parsed = new Date(`${s} GMT`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Parse Steam English trade-hold line from `owner_descriptions[].value` (context 16 export).
 * Primary: "Tradable After Sep 21, 2025 (7:00:00) GMT".
 * Also handles common variant: "... until Apr 13, 2026 (7:00:00) GMT" (first `owner_descriptions` entry is often blank).
 */
export function extractTradeLockDate(text?: string | null): string | null {
  if (text == null || typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;

  let m = t.match(/Tradable After\s+(.+?)\s*GMT/i);
  if (m) {
    const iso = steamTradeLockMiddleToIso(m[1]);
    if (iso) return iso;
  }

  m = t.match(/\buntil\s+(.+?)\s*GMT/i);
  if (m) {
    const iso = steamTradeLockMiddleToIso(m[1]);
    if (iso) return iso;
  }

  return null;
}

function tradeLockFromOwnerDescriptions(desc: Record<string, unknown>): string | null {
  const od = desc.owner_descriptions ?? desc.ownerDescriptions;
  if (!Array.isArray(od)) return null;
  for (const entry of od) {
    if (!entry || typeof entry !== "object") continue;
    const v = (entry as { value?: unknown }).value;
    if (typeof v !== "string") continue;
    const iso = extractTradeLockDate(v);
    if (iso) return iso;
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
        const iso = steamTradeLockMiddleToIso(m[1]);
        if (iso) return iso;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalizer — handles both new and old Steam JSON formats
// ---------------------------------------------------------------------------

/**
 * Join key for Steam `assets[]` ↔ `descriptions[]` (and rg* shapes).
 * Normalizes number/string and camelCase field names so lookups do not miss.
 */
export function steamClassInstanceKey(classid: unknown, instanceid: unknown): string {
  const hasClass = classid !== undefined && classid !== null && String(classid).trim() !== "";
  const c = hasClass ? String(classid) : "";
  const hasInst =
    instanceid !== undefined && instanceid !== null && String(instanceid).trim() !== "";
  const i = hasInst ? String(instanceid) : "0";
  return `${c}_${i}`;
}

function rawClassId(obj: Record<string, unknown> | null | undefined): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return obj.classid ?? obj.classId;
}

function rawInstanceId(obj: Record<string, unknown> | null | undefined): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return obj.instanceid ?? obj.instanceId;
}

export type NormalizeInventoryOptions = {
  /**
   * When true (admin pasted context-16 style JSON), read unlock time from `owner_descriptions`
   * via {@link extractTradeLockDate}. Live Steam context-2 fetches must omit this flag.
   */
  ownerDescriptionsTradeLock?: boolean;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeInventory(
  raw: any,
  ownerSteamId?: string,
  options?: NormalizeInventoryOptions,
): NormalizedItem[] {
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
    if (!d || typeof d !== "object") continue;
    const dr = d as Record<string, unknown>;
    const cid = rawClassId(dr);
    const iid = rawInstanceId(dr);
    if (cid === undefined || cid === null || String(cid).trim() === "") continue;
    const key = steamClassInstanceKey(cid, iid);
    if (!descMap.has(key)) descMap.set(key, d);
  }

  // asset_properties is a SEPARATE top-level array in Steam's response
  const assetPropsMap = new Map<string, any[]>();
  if (Array.isArray(raw?.asset_properties)) {
    for (const ap of raw.asset_properties) {
      if (ap.assetid && Array.isArray(ap.asset_properties)) {
        assetPropsMap.set(String(ap.assetid), ap.asset_properties);
      }
    }
  }

  const items: NormalizedItem[] = [];
  for (const a of assets) {
    if (!a || typeof a !== "object") continue;
    const ar = a as Record<string, unknown>;
    const cid = rawClassId(ar);
    const iid = rawInstanceId(ar);
    if (cid === undefined || cid === null || String(cid).trim() === "") continue;

    let desc = descMap.get(steamClassInstanceKey(cid, iid));
    if (!desc) desc = descMap.get(steamClassInstanceKey(cid, "0"));

    if (!desc) continue;

    const icon = desc.icon_url ? `${STEAM_CDN}${desc.icon_url}` : "";
    const { rarity, rarityColor } = rarityFromTags(desc.tags);
    const descRec = desc as Record<string, unknown>;
    const fromOwner =
      options?.ownerDescriptionsTradeLock === true ? tradeLockFromOwnerDescriptions(descRec) : null;
    const tradeLockUntil = fromOwner ?? detectTradeLock(desc.descriptions);

    const itemName: string = desc.market_hash_name ?? desc.name ?? "";

    const assetId = String(ar.assetid ?? ar.assetId ?? ar.id ?? "");
    const propsForAsset = assetPropsMap.get(String(assetId));
    const { floatValue: apFloat, paintIndex, stringProps } = extractFromAssetProperties(propsForAsset);
    const apPhase = phaseFromPaintIndex(paintIndex, itemName);
    const phase =
      apPhase ??
      (isDopplerFamilySkin(itemName) ? detectPhaseFromTagsDescs(desc.descriptions, desc.tags) : null);
    const floatVal = apFloat ?? extractFloat(desc.descriptions);

    const inspectRaw = extractInspectLink(desc.actions);
    const inspectLink = inspectRaw
      ? resolveInspectLink(inspectRaw, ownerSteamId ?? "0", assetId, stringProps)
      : null;

    const stickers = extractStickers(desc.descriptions);

    items.push({
      assetId,
      classId: String(cid),
      instanceId:
        iid !== undefined && iid !== null && String(iid) !== "" ? String(iid) : "",
      marketHashName: desc.market_hash_name ?? desc.name ?? "",
      name: desc.name ?? "",
      iconUrl: icon,
      rarity,
      rarityColor,
      type: typeFromTags(desc.tags),
      wear: wearFromTags(desc.tags),
      floatValue: floatVal,
      phaseLabel: phase,
      stickers,
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
  timeoutMs = 15_000,
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
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function sleepSteam(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Inventory JSON pages can be large; retry 429 / transient errors like steam-worker. */
async function httpsGetInventoryPageWithRetries(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const timeoutMs = Math.min(
    120_000,
    Math.max(25_000, parseInt(process.env.STEAM_INVENTORY_HTTPS_TIMEOUT_MS ?? "55000", 10) || 55_000),
  );
  const maxAttempts = Math.min(
    40,
    Math.max(4, parseInt(process.env.STEAM_INVENTORY_PAGE_MAX_ATTEMPTS ?? "18", 10) || 18),
  );
  let delay = 700;
  let last: { status: number; body: string } = { status: 0, body: "" };
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await httpsGet(url, headers, timeoutMs);
      last = res;
      if (res.status === 429) {
        console.warn(`[steam-inv] community-new 429 retry attempt=${i + 1}`);
        await sleepSteam(Math.min(15_000, delay));
        delay = Math.min(Math.floor(delay * 1.55), 15_000);
        continue;
      }
      return res;
    } catch (e) {
      console.warn(`[steam-inv] community-new fetch retry attempt=${i + 1}`, e);
      await sleepSteam(Math.min(12_000, delay));
      delay = Math.min(Math.floor(delay * 1.45), 12_000);
    }
  }
  return last;
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
  contextId: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  console.log(`[steam-inv] strategy=community-new (paginated) context=${contextId}`);

  const allAssets: unknown[] = [];
  const allAssetProps: unknown[] = [];
  const descMap = new Map<string, unknown>();
  let startAssetId: string | undefined;
  const rawMax = process.env.STEAM_INVENTORY_COMMUNITY_MAX_PAGES?.trim();
  const MAX_PAGES =
    rawMax === "0" || rawMax === "unlimited"
      ? 2000
      : Math.min(2000, Math.max(1, parseInt(process.env.STEAM_INVENTORY_COMMUNITY_MAX_PAGES ?? "400", 10) || 400));

  let lastPageHadMore = false;
  let steamTotal: number | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    let url = `https://steamcommunity.com/inventory/${steamId64}/${CS2_APP_ID}/${contextId}?l=english&count=2000`;
    if (startAssetId) url += `&start_assetid=${startAssetId}`;

    try {
      const { status, body } = await httpsGetInventoryPageWithRetries(url, BROWSER_HEADERS);
      if (status === 403) return { ok: false, error: "private_inventory" };
      if (status === 429) return { ok: false, error: "steam_rate_limit" };
      if (status !== 200) {
        console.error(`[steam-inv] community-new HTTP ${status}: ${body.slice(0, 300)}`);
        if (allAssets.length > 0) break;
        return { ok: false, error: `steam_http_${status}` };
      }
      const json = JSON.parse(body) as Record<string, unknown>;
      if (page === 0 && !json?.assets && !json?.descriptions) {
        console.error(`[steam-inv] community-new empty:`, body.slice(0, 300));
        return { ok: false, error: "empty_inventory" };
      }

      const t = Number(json.total_inventory_count);
      if (Number.isFinite(t) && t > 0) steamTotal = t;

      if (Array.isArray(json.assets)) {
        allAssets.push(...json.assets);
      }
      if (Array.isArray(json.asset_properties)) {
        allAssetProps.push(...json.asset_properties);
      }
      if (Array.isArray(json.descriptions)) {
        for (const d of json.descriptions) {
          const key = `${d.classid}_${d.instanceid}`;
          if (!descMap.has(key)) descMap.set(key, d);
        }
      }

      const more = json.more_items === true;
      const lastId = json.last_assetid != null ? String(json.last_assetid) : "";
      lastPageHadMore = more && Boolean(lastId);

      console.log(
        `[steam-inv] community-new page=${page}: +${(json.assets as unknown[])?.length ?? 0} assets (total=${allAssets.length}, more=${String(json.more_items ?? false)}, steam_total=${json.total_inventory_count ?? "?"})`,
      );
      if (page === 0) {
        const sample = ((json.assets as unknown[]) ?? []).slice(0, 5);
        for (const a of sample) {
          const asset = a as Record<string, unknown>;
          const desc = ((json.descriptions as Record<string, unknown>[]) ?? []).find((d: Record<string, unknown>) => {
            return d.classid === asset.classid && d.instanceid === asset.instanceid;
          });
          if (desc)
            console.log(
              `[steam-inv] sample: ${String(desc.name)} tradable=${String(desc.tradable)} marketable=${String(desc.marketable)}`,
            );
        }
      }

      if (!more || !lastId) break;

      if (String(startAssetId) === lastId) {
        console.warn(`[steam-inv] community-new pagination stuck on last_assetid=${lastId}`);
        break;
      }

      if (steamTotal != null && steamTotal > 0 && allAssets.length >= steamTotal) break;

      startAssetId = lastId;

      if (page + 1 >= MAX_PAGES && lastPageHadMore) {
        console.warn(
          `[steam-inv] community-new INCOMPLETE: hit MAX_PAGES=${MAX_PAGES} with more_items still true (assets=${allAssets.length}, steam_total=${steamTotal ?? "?"})`,
        );
        break;
      }
    } catch (e) {
      console.error(`[steam-inv] community-new error (page=${page}):`, e);
      if (allAssets.length > 0) break;
      return { ok: false, error: "community_error" };
    }
  }

  if (allAssets.length === 0) {
    return { ok: false, error: "empty_inventory" };
  }

  if (lastPageHadMore || (steamTotal != null && steamTotal > 0 && allAssets.length < steamTotal)) {
    console.warn(
      `[steam-inv] community-new partial/incomplete: assets=${allAssets.length}, steam_total=${steamTotal ?? "?"}, lastPageHadMore=${lastPageHadMore}`,
    );
  }

  console.log(`[steam-inv] community-new TOTAL: ${allAssets.length} assets, ${descMap.size} descriptions`);
  return {
    ok: true,
    data: { assets: allAssets, descriptions: Array.from(descMap.values()), asset_properties: allAssetProps },
  };
}

// ---------------------------------------------------------------------------
// Strategy 3: Community endpoint (old JSON format)
// ---------------------------------------------------------------------------

async function fetchViaCommunityOld(
  steamId64: string,
  contextId: string,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const url = `https://steamcommunity.com/profiles/${steamId64}/inventory/json/${CS2_APP_ID}/${contextId}?l=english&trading=1`;
  console.log(`[steam-inv] strategy=community-old context=${contextId}`);

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
  contextId: string = DEFAULT_CS2_INVENTORY_CONTEXT_ID,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const errors: string[] = [];

  const r2 = await fetchViaCommunityNew(steamId64, contextId);
  if (r2.ok) return r2;
  errors.push(`new:${r2.error}`);

  const r3 = await fetchViaCommunityOld(steamId64, contextId);
  if (r3.ok) return r3;
  errors.push(`old:${r3.error}`);

  console.error(`[steam-inv] ALL strategies failed for ${steamId64}: ${errors.join(", ")}`);
  return { ok: false, error: `all_failed(${errors.join(",")})` };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type OwnerInventoryPrimarySource = "trade_url" | "api" | "snapshot";

export type FetchOwnerInventoryOptions = { forceRefresh?: boolean };

/** Плохие прогоны owner trade-offer Puppeteer → считаем в circuit breaker (не disabled/private/куки). */
function ownerTradeOfferPuppeteerStrikeCandidate(p: {
  ok: boolean;
  reason: string;
  detail?: string;
}): boolean {
  if (p.ok) return false;
  if (p.reason === "disabled" || p.reason === "launch_failed" || p.reason === "invalid_trade_url") return false;
  if (p.reason === "private" || p.reason === "cannot_trade" || p.reason === "rate_limited") return false;
  const d = p.detail ?? "";
  if (d === "owner_cookie_missing_steam_login_secure" || d === "owner_cookie_session_mismatch") return false;
  if (p.reason === "timeout") return true;
  if (d === "partnerinventory_cs2_xhr") return true;
  if (p.reason === "session_invalid") return true;
  if (p.reason === "empty") return true;
  if (p.reason === "not_available") return true;
  if (p.reason === "unknown") return true;
  return false;
}

/**
 * Owner store inventory from Steam (Puppeteer trade URL + API merge, or API-only).
 * By default reads existing Redis/memory snapshot if present — no browser/API round-trip.
 * Pass `forceRefresh: true` after invalidating cache or for admin refresh jobs.
 */
export async function fetchOwnerInventory(
  options?: FetchOwnerInventoryOptions,
): Promise<
  | { ok: true; items: NormalizedItem[]; ownerInventoryPrimarySource: OwnerInventoryPrimarySource }
  | { ok: false; error: string }
> {
  const ownerSteamId = process.env.OWNER_STEAM_ID?.trim();
  if (!ownerSteamId) return { ok: false, error: "missing_owner_steam_id" };

  if (!options?.forceRefresh) {
    const { getCached } = await import("@/lib/inventory-cache");
    const cached = await getCached(ownerSteamId);
    if (cached != null) {
      return {
        ok: true,
        items: cached,
        ownerInventoryPrimarySource: "snapshot",
      };
    }
  }

  const ctx = resolveOwnerInventoryContextId();
  console.log(`[steam-inv] fetchOwnerInventory steamId=${ownerSteamId} context=${ctx}`);

  const fetchOwnerApiNormalized = async (): Promise<
    { ok: true; items: NormalizedItem[] } | { ok: false; error: string }
  > => {
    let result = await fetchSteamInventoryRaw(ownerSteamId, ctx);
    if (
      !result.ok &&
      ctx !== DEFAULT_CS2_INVENTORY_CONTEXT_ID &&
      ownerInventoryErrorAllowsDefaultContextFallback(result.error)
    ) {
      console.warn(
        `[steam-inv] owner context=${ctx} failed (${result.error}) — Steam usually does not serve this context to servers like on the web with a session; retrying context=${DEFAULT_CS2_INVENTORY_CONTEXT_ID}`,
      );
      result = await fetchSteamInventoryRaw(ownerSteamId, DEFAULT_CS2_INVENTORY_CONTEXT_ID);
    }
    if (!result.ok) return result;
    return { ok: true, items: normalizeInventory(result.data, ownerSteamId) };
  };

  logSteamProfilesStorageHint();

  const tradeUrl = process.env.OWNER_TRADE_URL?.trim();
  const ownerAcc = resolveOwnerPuppeteerAccount();
  const canPuppeteer =
    process.env.STEAM_INVENTORY_BROWSER !== "0" &&
    Boolean(ownerAcc && (ownerAcc.userDataDir || ownerAcc.cookies));

  if (!tradeUrl || !canPuppeteer) {
    const api = await fetchOwnerApiNormalized();
    if (!api.ok) return api;
    return { ok: true, items: api.items, ownerInventoryPrimarySource: "api" };
  }

  const invCacheMod = await import("@/lib/inventory-cache");
  const circuitMs = await invCacheMod.ownerPuppeteerCircuitRemainingMs(ownerSteamId);
  if (circuitMs > 0) {
    console.log(
      JSON.stringify({
        type: "owner_inv_puppeteer",
        event: "circuit_open_skip_browser",
        remaining_ms: circuitMs,
        ownerSteamId: normalizeSteamId64ForCache(ownerSteamId),
        ts: Date.now(),
      }),
    );
    const api = await fetchOwnerApiNormalized();
    if (!api.ok) return api;
    return { ok: true, items: api.items, ownerInventoryPrimarySource: "api" };
  }

  const { runThroughSteamGuestApiGate, runThroughSteamGuestPuppeteerLaneGate } = await import(
    "@/lib/guest-steam-split-gate",
  );
  const { fetchOwnerInventoryViaTradeOfferPuppeteer } = await import("@/lib/owner-inventory-puppeteer");
  const { ensureGuestPuppeteerCookiesLoggedOnce } = await import("@/lib/guest-inventory-puppeteer");
  ensureGuestPuppeteerCookiesLoggedOnce();

  const ownerLaneId = ownerAcc?.laneId ?? normalizeSteamId64ForCache(ownerSteamId);

  const maybeStrikeOwnerPuppeteer = async (r: {
    ok: boolean;
    reason: string;
    detail?: string;
  }) => {
    if (!ownerTradeOfferPuppeteerStrikeCandidate(r)) return;
    await invCacheMod.ownerPuppeteerCircuitRecordStrike(ownerSteamId);
  };

  const apiAfterBrowser = async (skipMinSpacing: boolean) => {
    const g = await runThroughSteamGuestApiGate(() => fetchOwnerApiNormalized(), { skipMinSpacing });
    if (!g.ok) {
      console.warn("[steam-inv] owner inventory API (after browser) queue full — ungated API attempt");
      return fetchOwnerApiNormalized();
    }
    return g.value;
  };

  const gApi0 = await runThroughSteamGuestApiGate(() => fetchOwnerApiNormalized());
  let apiItems: NormalizedItem[] = [];
  if (!gApi0.ok) {
    console.warn("[steam-inv] owner API gate queue full — ungated fetch");
    const api = await fetchOwnerApiNormalized();
    if (!api.ok) return api;
    apiItems = api.items;
  } else if (gApi0.value.ok) {
    apiItems = gApi0.value.items;
  }

  const runOwnerPuppeteer = () => fetchOwnerInventoryViaTradeOfferPuppeteer(tradeUrl);

  const mergeOwnerWithApi = (browserRaw: unknown) => {
    const browserItems = normalizeInventory(browserRaw, ownerSteamId);
    return mergeInventoriesPreferApi(apiItems, browserItems);
  };

  const g1 = await runThroughSteamGuestPuppeteerLaneGate(ownerLaneId, runOwnerPuppeteer);
  if (!g1.ok) {
    const api = await fetchOwnerApiNormalized();
    if (!api.ok) return api;
    return { ok: true, items: api.items, ownerInventoryPrimarySource: "api" };
  }

  let p = g1.value;
  if (p.ok) {
    await invCacheMod.ownerPuppeteerCircuitRecordSuccess(ownerSteamId);
    recordSteamProfileSuccess(ownerLaneId, ownerAcc?.accountId);
    const items = mergeOwnerWithApi(p.raw);
    return { ok: true, items, ownerInventoryPrimarySource: "trade_url" };
  }

  await maybeStrikeOwnerPuppeteer(p);

  if (p.reason === "disabled" || p.reason === "launch_failed") {
    const api = await fetchOwnerApiNormalized();
    if (!api.ok) return api;
    return { ok: true, items: api.items, ownerInventoryPrimarySource: "api" };
  }

  if (p.reason === "not_available") {
    const g2 = await runThroughSteamGuestPuppeteerLaneGate(ownerLaneId, runOwnerPuppeteer, {
      skipMinSpacing: true,
    });
    if (g2.ok && g2.value.ok) {
      await invCacheMod.ownerPuppeteerCircuitRecordSuccess(ownerSteamId);
      recordSteamProfileSuccess(ownerLaneId, ownerAcc?.accountId);
      const items = mergeOwnerWithApi(g2.value.raw);
      return { ok: true, items, ownerInventoryPrimarySource: "trade_url" };
    }
    if (g2.ok && !g2.value.ok) {
      await maybeStrikeOwnerPuppeteer(g2.value);
    }
    const api = await apiAfterBrowser(false);
    if (!api.ok) return api;
    return { ok: true, items: api.items, ownerInventoryPrimarySource: "api" };
  }

  if (p.reason === "private") {
    const g2 = await runThroughSteamGuestPuppeteerLaneGate(ownerLaneId, runOwnerPuppeteer);
    if (g2.ok && g2.value.ok) {
      await invCacheMod.ownerPuppeteerCircuitRecordSuccess(ownerSteamId);
      recordSteamProfileSuccess(ownerLaneId, ownerAcc?.accountId);
      const items = mergeOwnerWithApi(g2.value.raw);
      return { ok: true, items, ownerInventoryPrimarySource: "trade_url" };
    }
    if (g2.ok && !g2.value.ok) {
      await maybeStrikeOwnerPuppeteer(g2.value);
    }
    const api = await apiAfterBrowser(false);
    if (!api.ok) return api;
    return { ok: true, items: api.items, ownerInventoryPrimarySource: "api" };
  }

  if (
    p.reason === "cannot_trade" ||
    p.reason === "empty" ||
    p.reason === "timeout" ||
    p.reason === "rate_limited" ||
    p.reason === "unknown" ||
    p.reason === "invalid_trade_url" ||
    p.reason === "session_invalid"
  ) {
    const api = await apiAfterBrowser(false);
    if (!api.ok) return api;
    return { ok: true, items: api.items, ownerInventoryPrimarySource: "api" };
  }

  const api = await apiAfterBrowser(false);
  if (!api.ok) return api;
  return { ok: true, items: api.items, ownerInventoryPrimarySource: "api" };
}

export async function fetchGuestInventory(
  tradeUrl: string,
): Promise<{ ok: true; items: NormalizedItem[] } | { ok: false; error: string }> {
  const parsed = parseTradeUrl(tradeUrl);
  if (!parsed) return { ok: false, error: "invalid_trade_url" };

  const steamId64 = steamId64FromPartner(parsed.partner);
  return fetchGuestInventoryBySteamId64(steamId64);
}

/** Direct community inventory fetch by SteamID64 (same strategies as trade-URL flow). */
export async function fetchGuestInventoryBySteamId64(
  steamId64: string,
): Promise<{ ok: true; items: NormalizedItem[] } | { ok: false; error: string }> {
  const result = await fetchSteamInventoryRaw(steamId64, DEFAULT_CS2_INVENTORY_CONTEXT_ID);
  if (!result.ok) return result;
  return { ok: true, items: normalizeInventory(result.data, steamId64) };
}

// ---------------------------------------------------------------------------
// Exported for testing only
// ---------------------------------------------------------------------------
export const _testing = {
  isDopplerFamilySkin,
  phaseFromPaintIndex,
  detectPhaseFromTagsDescs,
  extractFromAssetProperties,
  resolveInspectLink,
  extractStickers,
  extractInspectLink,
  detectTradeLock,
  steamTradeLockMiddleToIso,
  INSPECT_PREFIX,
};
