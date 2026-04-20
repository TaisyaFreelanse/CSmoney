import type { OwnerPublicInventoryRow } from "@/lib/owner-manual-trade-lock";

function stripOnePairQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).trim();
    if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Split on commas / whitespace / semicolons; trim CR/BOM; strip wrapping quotes (Render / copy-paste).
 */
export function parseEnvAssetIdSet(raw: string | undefined | null): Set<string> {
  let s = raw?.trim().replace(/^\uFEFF/, "") ?? "";
  s = stripOnePairQuotes(s);
  if (!s) return new Set();
  const out = new Set<string>();
  for (const part of s.split(/[\s,;]+/)) {
    let id = part.replace(/\r/g, "").trim();
    if (!id) continue;
    id = stripOnePairQuotes(id);
    if (!id) continue;
    out.add(id);
  }
  return out;
}

/** Whitelist ids that do not appear on any merged row (typos / wrong account / stale cache). */
export function listWhitelistAssetIdsMissingFromRows(
  visible: Set<string>,
  rows: Pick<OwnerPublicInventoryRow, "assetId">[],
): string[] {
  if (visible.size === 0) return [];
  const have = new Set(rows.map((r) => String(r.assetId)));
  return [...visible].filter((id) => !have.has(id));
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
