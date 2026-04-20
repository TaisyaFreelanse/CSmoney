/**
 * Float / phase coverage from merged Steam inventory JSON (same intent as web `auditSteamInventoryFloatCoverage`).
 * Pure JS — no Puppeteer.
 */

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
  const c = classid !== undefined && classid !== null && String(classid).trim() !== "" ? String(classid) : "";
  const hasInst = instanceid !== undefined && instanceid !== null && String(instanceid).trim() !== "";
  const i = hasInst ? String(instanceid) : "0";
  return `${c}_${i}`;
}

export function buildAssetPropsMapFromSteamRaw(raw) {
  const map = new Map();
  if (!raw || typeof raw !== "object") return map;

  if (Array.isArray(raw.asset_properties)) {
    for (const ap of raw.asset_properties) {
      if (!ap || typeof ap !== "object") continue;
      const aid = ap.assetid ?? ap.assetId;
      const inner = ap.asset_properties;
      if (aid != null && Array.isArray(inner)) {
        const id = String(aid).trim();
        const cur = map.get(id) ?? [];
        map.set(id, [...cur, ...inner]);
      }
    }
  }

  const rg = raw.rgAssetProperties;
  if (rg && typeof rg === "object" && !Array.isArray(rg)) {
    for (const [assetid, rows] of Object.entries(rg)) {
      if (!Array.isArray(rows)) continue;
      const id = String(assetid).trim();
      const cur = map.get(id) ?? [];
      map.set(id, [...cur, ...rows]);
    }
  }
  return map;
}

function buildDescMapFromSteamRaw(raw) {
  const descMap = new Map();
  let descriptions = [];
  if (Array.isArray(raw.assets)) {
    descriptions = raw.descriptions ?? [];
  } else if (raw.rgInventory && raw.rgDescriptions) {
    descriptions = Object.values(raw.rgDescriptions);
  }
  for (const d of descriptions) {
    if (!d || typeof d !== "object") continue;
    const cid = d.classid ?? d.classId;
    const iid = d.instanceid ?? d.instanceId;
    if (cid === undefined || cid === null || String(cid).trim() === "") continue;
    const key = steamClassInstanceKey(cid, iid);
    if (!descMap.has(key)) descMap.set(key, d);
  }
  return descMap;
}

function listAssetRows(raw) {
  const out = [];
  if (Array.isArray(raw.assets)) {
    for (const a of raw.assets) {
      if (!a || typeof a !== "object") continue;
      const cid = a.classid ?? a.classId;
      const iid = a.instanceid ?? a.instanceId;
      if (cid === undefined || cid === null || String(cid).trim() === "") continue;
      const assetId = String(a.assetid ?? a.assetId ?? a.id ?? "").trim();
      if (!assetId) continue;
      out.push({ assetId, classId: String(cid), instanceId: iid !== undefined && iid !== null && String(iid) !== "" ? String(iid) : "0" });
    }
    return out;
  }
  if (raw.rgInventory && typeof raw.rgInventory === "object") {
    for (const a of Object.values(raw.rgInventory)) {
      if (!a || typeof a !== "object") continue;
      const assetId = String(a.id ?? a.assetid ?? "").trim();
      const cid = a.classid;
      const iid = a.instanceid ?? "0";
      if (!assetId || cid == null) continue;
      out.push({ assetId, classId: String(cid), instanceId: String(iid) });
    }
  }
  return out;
}

export function getRgAssetPropertyRows(raw, assetId) {
  if (!raw || typeof raw !== "object") return null;
  const rg = raw.rgAssetProperties;
  if (rg == null || typeof rg !== "object" || Array.isArray(rg)) return null;
  const rows = rg[String(assetId).trim()];
  if (!Array.isArray(rows)) return null;
  return rows;
}

export function extractFloatFromPropertyRows(rows) {
  if (!rows) return null;
  for (const p of rows) {
    const pid = Number(p.propertyid);
    if (pid === 2 && p.float_value != null) {
      const v = parseFloat(String(p.float_value));
      if (!Number.isNaN(v) && v > 0) return v;
    }
  }
  return null;
}

function extractFromAssetProperties(rows) {
  if (!rows || !Array.isArray(rows)) {
    return { floatValue: null, paintIndex: null, stringProps: new Map() };
  }
  let floatValue = null;
  let paintIndex = null;
  const stringProps = new Map();
  for (const prop of rows) {
    const pid = Number(prop.propertyid);
    if (pid === 2 && prop.float_value != null) {
      const parsed = parseFloat(String(prop.float_value));
      if (!Number.isNaN(parsed) && parsed > 0) floatValue = parsed;
    }
    if (pid === 7 && prop.int_value != null) {
      const parsed = parseInt(String(prop.int_value), 10);
      if (!Number.isNaN(parsed)) paintIndex = parsed;
    }
    if (typeof prop.string_value === "string" && prop.string_value) {
      stringProps.set(pid, prop.string_value);
    }
  }
  return { floatValue, paintIndex, stringProps };
}

function extractFloatFromDescriptions(descriptions) {
  if (!descriptions || !Array.isArray(descriptions)) return null;
  for (const d of descriptions) {
    const val = d.value ?? "";
    const m = /(?:Float|Wear\s*Rating|Степень\s*износа)\s*:?\s*([\d.]+)/i.exec(val);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function mergedPropRowsForAssetDesc(assetPropsMap, descMap, assetId, classId, instanceId) {
  const iid = instanceId?.trim() !== "" ? instanceId : "0";
  let desc = descMap.get(steamClassInstanceKey(classId, iid));
  if (!desc) desc = descMap.get(steamClassInstanceKey(classId, "0"));
  const descRec = desc && typeof desc === "object" ? desc : null;
  const inline =
    descRec && Array.isArray(descRec.properties) ? descRec.properties : [];
  const merged = [...(assetPropsMap.get(String(assetId).trim()) ?? []), ...inline];
  return { merged, desc: descRec };
}

function scanPid6Diagnostics(rows) {
  let hexCert = false;
  let intVal = null;
  for (const p of rows) {
    const pid = Number(p.propertyid);
    if (pid !== 6) continue;
    if (typeof p.string_value === "string") {
      const s = p.string_value.trim();
      if (/^[0-9A-F]{24,}$/i.test(s)) hexCert = true;
    }
    if (p.int_value != null) {
      const n = parseInt(String(p.int_value), 10);
      if (!Number.isNaN(n)) intVal = n;
    }
  }
  return { hexCert, intVal };
}

function extractPid6IntIfAny(rows) {
  if (!rows) return null;
  for (const p of rows) {
    if (Number(p.propertyid) !== 6 || p.int_value == null) continue;
    const n = parseInt(String(p.int_value), 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/**
 * @param {unknown} raw — merged inventory (worker `body.raw`)
 */
export function auditSteamTradeRaw(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      total: 0,
      withFloatSteam: 0,
      withoutFloatSteam: 0,
      withFloatMergedSources: 0,
      withoutFloatMergedSources: 0,
      withPaintIndexPid7: 0,
      dopplerFamilyItemCount: 0,
      dopplerWithPhaseFromPid7: 0,
      dopplerWithPhaseFromPid6IntHint: 0,
      pid6ItemCertificateHexCount: 0,
      pid6IntValueCount: 0,
      samplesWithoutFloat: [],
      notes: ["invalid raw"],
    };
  }

  const notes = [];
  if (raw.rgAssetProperties != null && typeof raw.rgAssetProperties === "object") {
    notes.push("includes rgAssetProperties");
  }
  if (Array.isArray(raw.asset_properties) && raw.asset_properties.length > 0) {
    notes.push("includes asset_properties[]");
  }

  const assetPropsMap = buildAssetPropsMapFromSteamRaw(raw);
  const descMap = buildDescMapFromSteamRaw(raw);
  const assetRows = listAssetRows(raw);

  let withFloatSteam = 0;
  let withFloatMergedSources = 0;
  let withPaintIndexPid7 = 0;
  let dopplerFamilyItemCount = 0;
  let dopplerWithPhaseFromPid7 = 0;
  let dopplerWithPhaseFromPid6IntHint = 0;
  let pid6ItemCertificateHexCount = 0;
  let pid6IntValueCount = 0;
  const samplesWithoutFloat = [];
  const SAMPLE_CAP = 15;

  for (const row of assetRows) {
    const { assetId, classId, instanceId } = row;
    const rgRows = getRgAssetPropertyRows(raw, assetId);
    if (extractFloatFromPropertyRows(rgRows) != null) {
      withFloatSteam++;
    }

    const { merged, desc } = mergedPropRowsForAssetDesc(assetPropsMap, descMap, assetId, classId, instanceId);
    const ex = extractFromAssetProperties(merged);
    const hints = scanPid6Diagnostics(merged);
    const itemName = desc?.market_hash_name ?? desc?.name ?? "";
    const paintPhasePid7 = phaseFromPaintIndex(ex.paintIndex, itemName);
    const pid6Int = extractPid6IntIfAny(merged);
    const paintPhasePid6Hint =
      paintPhasePid7 == null && pid6Int != null ? phaseFromPaintIndex(pid6Int, itemName) : null;

    if (ex.paintIndex != null && !Number.isNaN(ex.paintIndex)) {
      withPaintIndexPid7++;
    }
    if (hints.hexCert) pid6ItemCertificateHexCount++;
    if (hints.intVal != null) pid6IntValueCount++;

    if (isDopplerFamilySkin(itemName)) {
      dopplerFamilyItemCount++;
      if (paintPhasePid7 != null) dopplerWithPhaseFromPid7++;
      else if (paintPhasePid6Hint != null) dopplerWithPhaseFromPid6IntHint++;
    }

    const textFloat = extractFloatFromDescriptions(desc?.descriptions);
    const mergedFloat =
      ex.floatValue != null && ex.floatValue > 0
        ? ex.floatValue
        : textFloat != null && textFloat > 0
          ? textFloat
          : null;

    if (mergedFloat != null) {
      withFloatMergedSources++;
    } else if (samplesWithoutFloat.length < SAMPLE_CAP) {
      samplesWithoutFloat.push({
        assetId,
        marketHashName: itemName,
        floatFromRg: extractFloatFromPropertyRows(rgRows),
        paintIndexFromPid7: ex.paintIndex,
        pid6IntIfAny: hints.intVal,
        pid6HexCert: hints.hexCert,
        phaseFromPid7: paintPhasePid7,
      });
    }
  }

  const total = assetRows.length;
  return {
    total,
    withFloatSteam,
    withoutFloatSteam: total - withFloatSteam,
    withFloatMergedSources,
    withoutFloatMergedSources: total - withFloatMergedSources,
    withPaintIndexPid7,
    dopplerFamilyItemCount,
    dopplerWithPhaseFromPid7,
    dopplerWithPhaseFromPid6IntHint,
    pid6ItemCertificateHexCount,
    pid6IntValueCount,
    samplesWithoutFloat,
    notes,
  };
}
