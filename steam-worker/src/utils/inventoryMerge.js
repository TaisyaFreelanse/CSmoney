function descKeyFromRow(row) {
  return `${row.classid}_${row.instanceid ?? "0"}`;
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

    if (Array.isArray(j.asset_properties)) allAssetProps.push(...j.asset_properties);

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
    if (!byAssetId.has(id)) byAssetId.set(id, a);
  }

  return {
    assets: [...byAssetId.values()],
    descriptions: Array.from(descMap.values()),
    asset_properties: allAssetProps,
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
