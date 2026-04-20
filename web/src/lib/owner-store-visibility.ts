import type { OwnerPublicInventoryRow } from "@/lib/owner-manual-trade-lock";

/** Split on commas / whitespace; ignore empty tokens. */
export function parseEnvAssetIdSet(raw: string | undefined | null): Set<string> {
  const s = raw?.trim();
  if (!s) return new Set();
  const out = new Set<string>();
  for (const part of s.split(/[\s,;]+/)) {
    const id = part.trim();
    if (id) out.add(id);
  }
  return out;
}

/**
 * Optional storefront filter (Render env).
 * - `OWNER_STORE_VISIBLE_ASSET_IDS` — if non-empty, only these asset ids are shown (whitelist).
 * - Else `OWNER_STORE_HIDE_ASSET_IDS` — if non-empty, these asset ids are removed (blacklist).
 * Manual-lock rows (`locked: true`) follow the same rules by `assetId`.
 */
export function filterOwnerStorePublicRows(items: OwnerPublicInventoryRow[]): OwnerPublicInventoryRow[] {
  const visible = parseEnvAssetIdSet(process.env.OWNER_STORE_VISIBLE_ASSET_IDS);
  const hidden = parseEnvAssetIdSet(process.env.OWNER_STORE_HIDE_ASSET_IDS);
  if (visible.size > 0) {
    return items.filter((i) => visible.has(String(i.assetId)));
  }
  if (hidden.size > 0) {
    return items.filter((i) => !hidden.has(String(i.assetId)));
  }
  return items;
}
