/**
 * Merged trade / API inventory: фильтр трейдлока в raw и сборка `items` для GET /inventory.
 * Float: Steam `propertyid` 2, else decode from Item Certificate hex (`propertyid` 6) via @csfloat/cs2-inspect-serializer.
 */
import { decodeLink } from "@csfloat/cs2-inspect-serializer";
import { buildAssetPropsMapFromSteamRaw, extractFloatFromPropertyRows } from "./inventoryFloatAudit.js";

const INSPECT_PREFIX = "steam://run/730//+csgo_econ_action_preview%20";

const PAINT_INDEX_PHASE = {
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

function isDopplerFamilySkin(name) {
  return String(name ?? "").toLowerCase().includes("doppler");
}

function phaseFromPaintIndex(paintIndex, itemName) {
  if (paintIndex == null || Number.isNaN(paintIndex)) return null;
  if (!isDopplerFamilySkin(itemName)) return null;
  return PAINT_INDEX_PHASE[paintIndex] ?? null;
}

/** Парсинг даты из строк Steam (GMT); зеркало web `steamTradeLockMiddleToIso`. */
function steamTradeLockMiddleToIso(middle) {
  let s = String(middle ?? "").trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  s = s.replace(/\s*\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*/gi, " $1 ");
  s = s.replace(/\s*\([^)]*\)/g, "");
  s = s.replace(/\s*GMT\s*$/i, "").trim();
  if (!s) return null;

  const parsed = new Date(`${s} GMT`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Как trade UI: будущая дата в описаниях = трейдхолд даже при `tradable: 1`. */
function detectTradeLockUntilIso(descriptions) {
  if (!Array.isArray(descriptions)) return null;
  for (const d of descriptions) {
    if (!d || typeof d !== "object") continue;
    const val = d.value ?? "";
    const patterns = [
      /Tradable After\s+(.+)/i,
      /Tradable\s*\/\s*Marketable\s*After\s+(.+)/i,
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

function steamClassInstanceKey(classid, instanceid) {
  const c =
    classid !== undefined && classid !== null && String(classid).trim() !== "" ? String(classid) : "";
  const hasInst = instanceid !== undefined && instanceid !== null && String(instanceid).trim() !== "";
  const i = hasInst ? String(instanceid) : "0";
  return `${c}_${i}`;
}

/**
 * Трейдлок: не tradable по описанию Steam, явный `asset.tradable === 0`, или будущая дата в тексте описаний.
 * @param {unknown} desc
 * @param {unknown} asset
 */
export function assetInTradeHold(desc, asset) {
  const a = asset && typeof asset === "object" ? asset : null;
  if (a && (a.tradable === 0 || a.tradable === false)) return true;
  const steamTradable = desc?.tradable === 1 || desc?.tradable === true;
  const tradeLockUntilIso = detectTradeLockUntilIso(desc?.descriptions);
  const hasFutureLock =
    tradeLockUntilIso != null &&
    !Number.isNaN(new Date(tradeLockUntilIso).getTime()) &&
    new Date(tradeLockUntilIso).getTime() > Date.now();
  return !steamTradable || hasFutureLock;
}

/**
 * Убирает из merged raw все asset'ы в трейдлоке и подчищает `asset_properties` / `rgAssetProperties`.
 * @param {unknown} merged
 */
export function filterTradableMergedRaw(merged) {
  if (!merged || typeof merged !== "object") return merged;

  const m = merged;
  const descByKey = new Map();
  for (const d of m.descriptions ?? []) {
    if (!d || typeof d !== "object") continue;
    const dr = d;
    const k = steamClassInstanceKey(dr.classid ?? dr.classId, dr.instanceid ?? dr.instanceId ?? "0");
    if (!descByKey.has(k)) descByKey.set(k, d);
  }

  function descForAsset(a) {
    const cid = String(a.classid ?? "");
    const iid = String(a.instanceid ?? "0");
    const dk = steamClassInstanceKey(cid, iid);
    return descByKey.get(dk) ?? descByKey.get(steamClassInstanceKey(cid, "0"));
  }

  const keptAssets = [];
  const keptIds = new Set();
  for (const a of Array.isArray(m.assets) ? m.assets : []) {
    if (!a || typeof a !== "object") continue;
    const desc = descForAsset(a);
    if (assetInTradeHold(desc, a)) continue;
    keptAssets.push(a);
    const id = String(a.assetid ?? a.id ?? "").trim();
    if (id) keptIds.add(id);
  }

  const ap = m.asset_properties;
  const filteredAp = Array.isArray(ap)
    ? ap.filter((block) => {
        if (!block || typeof block !== "object") return false;
        const id = String(block.assetid ?? "").trim();
        return id && keptIds.has(id);
      })
    : [];

  /** @type {Record<string, unknown[]>} */
  const filteredRg = {};
  const rg = m.rgAssetProperties;
  if (rg != null && typeof rg === "object" && !Array.isArray(rg)) {
    for (const [assetid, rows] of Object.entries(rg)) {
      const id = String(assetid).trim();
      if (id && keptIds.has(id) && Array.isArray(rows)) filteredRg[id] = rows;
    }
  }

  const out = { ...m, assets: keptAssets, asset_properties: filteredAp };
  if (m.rgAssetProperties != null && typeof m.rgAssetProperties === "object" && !Array.isArray(m.rgAssetProperties)) {
    if (Object.keys(filteredRg).length > 0) out.rgAssetProperties = filteredRg;
    else delete out.rgAssetProperties;
  }
  return out;
}

function floatFromItemCertificateHex(hex) {
  if (!hex || typeof hex !== "string") return null;
  const h = hex.trim();
  if (!/^[0-9A-F]{40,}$/i.test(h)) return null;
  try {
    const link = INSPECT_PREFIX + h;
    const econ = decodeLink(link);
    const floatValue =
      typeof econ.paintwear === "number" && !Number.isNaN(econ.paintwear) ? econ.paintwear : 0;
    return floatValue > 0 ? floatValue : null;
  } catch {
    return null;
  }
}

/**
 * Список предметов для API: только реально tradable строки (после merge; при необходимости сначала вызовите `filterTradableMergedRaw`).
 * @param {unknown} merged
 */
export function buildWorkerTradeInventoryItems(merged) {
  const items = [];
  if (!merged || typeof merged !== "object") {
    return { items };
  }

  const m = merged;
  const descByKey = new Map();
  for (const d of m.descriptions ?? []) {
    if (!d || typeof d !== "object") continue;
    const dr = d;
    const k = steamClassInstanceKey(dr.classid ?? dr.classId, dr.instanceid ?? dr.instanceId ?? "0");
    if (!descByKey.has(k)) descByKey.set(k, d);
  }

  const assetPropsMap = buildAssetPropsMapFromSteamRaw(m);
  const assets = Array.isArray(m.assets) ? m.assets : [];

  for (const a of assets) {
    if (!a || typeof a !== "object") continue;
    const cid = String(a.classid ?? "");
    const iid = String(a.instanceid ?? "0");
    const dk = steamClassInstanceKey(cid, iid);
    const desc = descByKey.get(dk) ?? descByKey.get(steamClassInstanceKey(cid, "0"));
    const assetid = String(a.assetid ?? a.id ?? "").trim();
    if (!assetid || !cid) continue;

    const name = desc?.market_hash_name ?? desc?.name ?? "";
    const steamTradable = desc?.tradable === 1 || desc?.tradable === true;
    const tradeLockUntilIso = detectTradeLockUntilIso(desc?.descriptions);
    const inTradeHold = assetInTradeHold(desc, a);

    const rows = assetPropsMap.get(assetid) ?? [];
    const floatPid2 = extractFloatFromPropertyRows(rows);
    let paintIndex = null;
    let inspectHex = null;
    for (const p of rows) {
      const pid = Number(p.propertyid);
      if (pid === 7 && p.int_value != null) {
        const n = parseInt(String(p.int_value), 10);
        if (!Number.isNaN(n)) paintIndex = n;
      }
      if (pid === 6 && typeof p.string_value === "string") {
        const s = p.string_value.trim();
        if (/^[0-9A-F]{40,}$/i.test(s)) inspectHex = s;
      }
    }

    let floatValue = floatPid2;
    /** @type {"steam_property_2" | "steam_item_certificate_hex" | null} */
    let floatSource = floatPid2 != null && floatPid2 > 0 ? "steam_property_2" : null;
    if (floatValue == null || floatValue <= 0) {
      const fromHex = floatFromItemCertificateHex(inspectHex ?? "");
      if (fromHex != null && fromHex > 0) {
        floatValue = fromHex;
        floatSource = "steam_item_certificate_hex";
      }
    }

    const phaseLabel = phaseFromPaintIndex(paintIndex, name);

    const row = {
      assetid,
      classid: cid,
      instanceid: iid,
      amount: a.amount != null ? Number(a.amount) : 1,
      market_hash_name: desc?.market_hash_name ?? null,
      name: desc?.name ?? null,
      tradable: steamTradable,
      tradeLockUntil: tradeLockUntilIso,
      inTradeHold,
      floatValue: floatValue != null && floatValue > 0 ? floatValue : null,
      floatSource,
      paintIndex,
      phaseLabel,
      inspectHex,
    };

    if (!inTradeHold) items.push(row);
  }

  return { items };
}
