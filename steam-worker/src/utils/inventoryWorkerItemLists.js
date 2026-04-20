/**
 * Split merged trade / API inventory into tradable vs trade-locked rows for GET /inventory.
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

function steamClassInstanceKey(classid, instanceid) {
  const c =
    classid !== undefined && classid !== null && String(classid).trim() !== "" ? String(classid) : "";
  const hasInst = instanceid !== undefined && instanceid !== null && String(instanceid).trim() !== "";
  const i = hasInst ? String(instanceid) : "0";
  return `${c}_${i}`;
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
 * @param {unknown} merged
 */
export function buildWorkerTradeItemLists(merged) {
  const mainItems = [];
  const itemsFromTradeLock = [];
  if (!merged || typeof merged !== "object") {
    return { items: [], mainItems, itemsFromTradeLock };
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
    const tradable = desc?.tradable === 1 || desc?.tradable === true;

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
      tradable,
      floatValue: floatValue != null && floatValue > 0 ? floatValue : null,
      floatSource,
      paintIndex,
      phaseLabel,
      inspectHex,
    };

    if (tradable) mainItems.push(row);
    else itemsFromTradeLock.push(row);
  }

  const items = [...mainItems, ...itemsFromTradeLock];
  return { items, mainItems, itemsFromTradeLock };
}
