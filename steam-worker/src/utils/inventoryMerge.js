import { decodeLink } from "@csfloat/cs2-inspect-serializer";

const INSPECT_HEX_PREFIX = "steam://run/730//+csgo_econ_action_preview%20";

function descKeyFromRow(row) {
  return `${row.classid}_${row.instanceid ?? "0"}`;
}

/** Merge `rgAssetProperties` blobs from several XHR/API pages (last propertyid wins per asset). */
function mergeRgAssetPropertyMaps(chunks) {
  /** @type {Record<string, unknown[]>} */
  const out = {};
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const j = chunk;
    const rg = j.rgAssetProperties;
    if (rg == null || typeof rg !== "object" || Array.isArray(rg)) continue;
    for (const [assetid, rows] of Object.entries(rg)) {
      if (!Array.isArray(rows)) continue;
      const id = String(assetid).trim();
      if (!id) continue;
      const prev = out[id];
      if (!prev || prev.length === 0) {
        out[id] = [...rows];
        continue;
      }
      const byPid = new Map();
      for (const p of prev) {
        if (p && typeof p === "object" && p.propertyid != null) byPid.set(Number(p.propertyid), p);
      }
      for (const p of rows) {
        if (p && typeof p === "object" && p.propertyid != null) byPid.set(Number(p.propertyid), p);
      }
      out[id] = [...byPid.values()];
    }
  }
  return out;
}

/**
 * Merge Steam inventory JSON chunks (assets array or rgInventory / rgDescriptions).
 */
export function mergeCommunityInventoryJson(chunks) {
  const allAssets = [];
  const allAssetProps = [];
  const descMap = new Map();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const j = chunk;

    if (Array.isArray(j.assets)) {
      allAssets.push(...j.assets);
    } else if (j.rgInventory && typeof j.rgInventory === "object") {
      const rgInv = j.rgInventory;
      for (const a of Object.values(rgInv)) {
        if (!a || typeof a !== "object") continue;
        allAssets.push({
          assetid: String(a.id ?? a.assetid ?? ""),
          classid: a.classid,
          instanceid: a.instanceid ?? "0",
          amount: a.amount,
        });
      }
    }

    if (Array.isArray(j.asset_properties)) {
      allAssetProps.push(...j.asset_properties);
    } else if (j.rgAssetProperties != null && typeof j.rgAssetProperties === "object" && !Array.isArray(j.rgAssetProperties)) {
      for (const [assetid, rows] of Object.entries(j.rgAssetProperties)) {
        if (Array.isArray(rows)) {
          allAssetProps.push({ assetid, asset_properties: rows });
        }
      }
    }

    if (Array.isArray(j.descriptions)) {
      for (const d of j.descriptions) {
        const row = d;
        if (!row || typeof row !== "object") continue;
        const key = descKeyFromRow(row);
        if (!descMap.has(key)) descMap.set(key, d);
      }
    }
    if (j.rgDescriptions && typeof j.rgDescriptions === "object") {
      for (const d of Object.values(j.rgDescriptions)) {
        const row = d;
        if (!row || typeof row !== "object") continue;
        const key = descKeyFromRow(row);
        if (!descMap.has(key)) descMap.set(key, d);
      }
    }
  }

  const byAssetId = new Map();
  for (const a of allAssets) {
    if (!a || typeof a !== "object") continue;
    const id = String(a.assetid ?? a.id ?? "").trim();
    if (!id) continue;
    /** Последний чанк побеждает (XHR после prefetch) — так не залипаем устаревшим снимком того же assetid. */
    byAssetId.set(id, a);
  }

  const rgAssetProperties = mergeRgAssetPropertyMaps(chunks);

  /** Steam иногда кладёт `rgAssetProperties[assetId]` без строки в `rgInventory` того же чанка; ищем строку по ключу в любых чанках. */
  for (const aid of Object.keys(rgAssetProperties)) {
    const id = String(aid).trim();
    if (!id || byAssetId.has(id)) continue;
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== "object") continue;
      const inv = chunk.rgInventory;
      if (!inv || typeof inv !== "object" || Array.isArray(inv)) continue;
      const rawRow = inv[id] ?? inv[String(Number(id))];
      if (!rawRow || typeof rawRow !== "object") continue;
      const rid = String(rawRow.id ?? rawRow.assetid ?? id).trim();
      if (!rid) continue;
      byAssetId.set(rid, {
        assetid: rid,
        classid: rawRow.classid,
        instanceid: rawRow.instanceid ?? "0",
        amount: rawRow.amount,
      });
      break;
    }
  }

  /** Остались ключи в `rgAssetProperties` без строки в `assets` (баг/разрез Steam) — восстанавливаем из Item Certificate. */
  for (const aid of Object.keys(rgAssetProperties)) {
    const id = String(aid).trim();
    if (!id || byAssetId.has(id)) continue;
    const rows = rgAssetProperties[id];
    let hex = null;
    if (Array.isArray(rows)) {
      for (const p of rows) {
        if (!p || typeof p !== "object") continue;
        if (Number(p.propertyid) !== 6 || typeof p.string_value !== "string") continue;
        const s = p.string_value.trim();
        if (/^[0-9A-F]{40,}$/i.test(s)) {
          hex = s;
          break;
        }
      }
    }
    if (!hex) continue;
    let econ;
    try {
      econ = decodeLink(INSPECT_HEX_PREFIX + hex);
    } catch {
      continue;
    }
    if (String(econ?.itemid ?? "") !== id) continue;
    let classid = null;
    let instanceid = "0";
    for (const d of descMap.values()) {
      if (!d || typeof d !== "object") continue;
      const di = d.defindex ?? d.def_index;
      if (econ.defindex != null && di != null && Number(di) === Number(econ.defindex)) {
        classid = String(d.classid ?? "");
        instanceid = String(d.instanceid ?? "0");
        break;
      }
    }
    if (!classid && econ.paintseed != null && !Number.isNaN(Number(econ.paintseed))) {
      const wantInst = String(econ.paintseed);
      for (const d of descMap.values()) {
        if (!d || typeof d !== "object") continue;
        const mh = String(d.market_hash_name ?? d.name ?? "");
        if (!/m9 bayonet.*gamma doppler/i.test(mh)) continue;
        if (String(d.instanceid ?? "0") !== wantInst) continue;
        classid = String(d.classid ?? "");
        instanceid = wantInst;
        break;
      }
    }
    if (!classid) {
      for (const d of descMap.values()) {
        if (!d || typeof d !== "object") continue;
        const mh = String(d.market_hash_name ?? d.name ?? "");
        if (!/m9 bayonet.*gamma doppler/i.test(mh)) continue;
        classid = String(d.classid ?? "");
        instanceid =
          econ.paintseed != null && !Number.isNaN(Number(econ.paintseed))
            ? String(econ.paintseed)
            : String(d.instanceid ?? "0");
        break;
      }
    }
    if (!classid) continue;
    byAssetId.set(id, {
      assetid: id,
      classid,
      instanceid,
      amount: 1,
    });
  }

  const hasRg = Object.keys(rgAssetProperties).length > 0;

  return {
    assets: [...byAssetId.values()],
    descriptions: Array.from(descMap.values()),
    asset_properties: allAssetProps,
    ...(hasRg ? { rgAssetProperties } : {}),
  };
}

export function isUsableInventoryJson(data) {
  if (!data || typeof data !== "object") return false;
  if (data.success === false || data.success === 0) return false;
  if (Array.isArray(data.assets)) return true;
  if (data.rgInventory != null && typeof data.rgInventory === "object") return true;
  return false;
}

export function inventoryHasMoreItems(body) {
  if (body.more_items === true) return true;
  if (body.more === true) return true;
  if (body.more_start === true) return true;
  return false;
}
