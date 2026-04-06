/**
 * Owner/store: trade-lock-only JSON from admin (paste Steam export, often context 16).
 *
 * Public inventory = live Steam (context 2, tradable-only slice) **concat** normalized JSON rows,
 * with JSON rows marked `locked: true`. No matching or merging by assetid between sources.
 *
 * Rule keys (assetIds / classInstanceKeys) remain for admin diagnostics; optional file fallback for display JSON.
 */

import fs from "node:fs";
import path from "node:path";

import { prisma } from "@/lib/prisma";

import { normalizeInventory } from "./steam-inventory";
import type { NormalizedItem, SteamStickerInfo } from "./steam-inventory";

/** API row after merging Steam + manual lock JSON. */
export type OwnerPublicInventoryRow = NormalizedItem & { locked: boolean };

export type OwnerManualTradeLockRule = {
  assetIds: ReadonlySet<string>;
  classInstanceKeys: ReadonlySet<string>;
};

const EMPTY_RULE: OwnerManualTradeLockRule = {
  assetIds: new Set(),
  classInstanceKeys: new Set(),
};

/** If true, ignore asset ids from the rule (JSON from another Steam context often has different assetid). */
export function useClassInstanceOnlyManualLock(): boolean {
  const v = process.env.OWNER_MANUAL_TRADE_LOCK_CLASS_INSTANCE_ONLY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function itemMatchesOwnerManualLock(item: NormalizedItem, rule: OwnerManualTradeLockRule): boolean {
  const key = `${String(item.classId)}_${String(item.instanceId)}`;
  // Prefer class+instance first: stable across context 2 vs 16 when Steam keeps the same pair.
  if (rule.classInstanceKeys.size > 0 && rule.classInstanceKeys.has(key)) return true;
  if (useClassInstanceOnlyManualLock()) return false;
  return rule.assetIds.has(String(item.assetId));
}

function coerceSticker(x: unknown): SteamStickerInfo {
  if (!x || typeof x !== "object") return { name: "", iconUrl: "" };
  const o = x as Record<string, unknown>;
  return {
    name: typeof o.name === "string" ? o.name : "",
    iconUrl: typeof o.iconUrl === "string" ? o.iconUrl : "",
  };
}

/** Rehydrate NormalizedItem[] from Prisma Json. */
export function coerceLockDisplayItemsFromDbJson(raw: unknown): NormalizedItem[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedItem[] = [];
  for (const el of raw) {
    if (!el || typeof el !== "object") continue;
    const o = el as Record<string, unknown>;
    const stickersRaw = o.stickers;
    const stickers = Array.isArray(stickersRaw) ? stickersRaw.map(coerceSticker) : [];
    out.push({
      assetId: String(o.assetId ?? ""),
      classId: String(o.classId ?? ""),
      instanceId: String(o.instanceId ?? ""),
      marketHashName: String(o.marketHashName ?? ""),
      name: String(o.name ?? ""),
      iconUrl: String(o.iconUrl ?? ""),
      rarity: typeof o.rarity === "string" ? o.rarity : null,
      rarityColor: typeof o.rarityColor === "string" ? o.rarityColor : null,
      type: typeof o.type === "string" ? o.type : null,
      wear: typeof o.wear === "string" ? o.wear : null,
      floatValue: typeof o.floatValue === "number" && Number.isFinite(o.floatValue) ? o.floatValue : null,
      phaseLabel: typeof o.phaseLabel === "string" ? o.phaseLabel : null,
      stickers,
      tradeLockUntil: typeof o.tradeLockUntil === "string" ? o.tradeLockUntil : null,
      tradable: o.tradable === true || o.tradable === 1,
      marketable: o.marketable === true || o.marketable === 1,
      inspectLink: typeof o.inspectLink === "string" ? o.inspectLink : null,
    });
  }
  return out;
}

/**
 * Normalize pasted Steam inventory JSON (assets + descriptions + optional asset_properties).
 * Uses `normalizeInventory`, which joins each asset to its description via `steamClassInstanceKey`
 * (string/number ids, camelCase fields, optional instance → `_0` fallback).
 */
export function buildOwnerLockOnlySnapshotFromParsedJson(
  parsed: unknown,
  ownerSteamId?: string,
): NormalizedItem[] {
  if (parsed == null || typeof parsed !== "object") return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Steam payload
    return normalizeInventory(parsed as any, ownerSteamId, { ownerDescriptionsTradeLock: true });
  } catch {
    return [];
  }
}

/** Live Steam rows eligible for trading (context 2 fetch); excludes untradable and active time-locks. */
export function filterSteamItemsTradableForTradeTab(items: NormalizedItem[]): NormalizedItem[] {
  const now = new Date();
  return items.filter((i) => {
    if (!i.tradable) return false;
    if (i.tradeLockUntil && new Date(i.tradeLockUntil) > now) return false;
    return true;
  });
}

/**
 * Single public list: tradable Steam slice first, then manual JSON rows (locked, not selectable).
 * Sources are not deduped — admin should upload lock-only JSON that does not duplicate tradable Steam rows.
 */
export function mergeOwnerSteamAndManualLockJson(
  steamTradable: NormalizedItem[],
  manualLockNormalized: NormalizedItem[],
): OwnerPublicInventoryRow[] {
  const steamPart: OwnerPublicInventoryRow[] = steamTradable.map((i) => ({ ...i, locked: false }));
  const manualPart: OwnerPublicInventoryRow[] = manualLockNormalized.map((i) => ({
    ...i,
    locked: true,
    tradable: false,
  }));
  return [...steamPart, ...manualPart];
}

export type OwnerManualTradeLockDiagnostics = {
  inventoryItemCount: number;
  matchedByAssetIdCount: number;
  matchedByClassInstanceKeyCount: number;
  /** class+instance matched but asset id not in rule (typical for context 16 JSON vs context 2 inventory) */
  matchedClassButNotAssetIdCount: number;
  wouldLockCount: number;
  sampleLockedNames: string[];
  /** Rule asset ids (first 8) not present on any loaded inventory row */
  sampleRuleAssetIdsMissingInInventory: string[];
  /** Rule class_instance keys (first 8) not present on any loaded inventory row */
  sampleRuleClassKeysMissingInInventory: string[];
};

export function computeOwnerManualTradeLockDiagnostics(
  items: NormalizedItem[],
  rule: OwnerManualTradeLockRule,
): OwnerManualTradeLockDiagnostics {
  let matchedByAssetIdCount = 0;
  let matchedByClassInstanceKeyCount = 0;
  let matchedClassButNotAssetIdCount = 0;
  const wouldLockAssetIds = new Set<string>();

  for (const item of items) {
    const aid = String(item.assetId);
    const key = `${String(item.classId)}_${String(item.instanceId)}`;
    const byAsset = rule.assetIds.has(aid);
    const byClass = rule.classInstanceKeys.size > 0 && rule.classInstanceKeys.has(key);
    if (byAsset) matchedByAssetIdCount++;
    if (byClass) matchedByClassInstanceKeyCount++;
    if (byClass && !byAsset) matchedClassButNotAssetIdCount++;
    const effectiveLock = useClassInstanceOnlyManualLock() ? byClass : byAsset || byClass;
    if (effectiveLock) wouldLockAssetIds.add(aid);
  }

  const invAssets = new Set(items.map((i) => String(i.assetId)));
  const invCi = new Set(items.map((i) => `${String(i.classId)}_${String(i.instanceId)}`));

  const sampleRuleAssetIdsMissingInInventory = [...rule.assetIds].filter((a) => !invAssets.has(a)).slice(0, 8);

  const sampleRuleClassKeysMissingInInventory = [...rule.classInstanceKeys]
    .filter((k) => !invCi.has(k))
    .slice(0, 8);

  const sampleLockedNames = items
    .filter((i) => wouldLockAssetIds.has(String(i.assetId)))
    .slice(0, 10)
    .map((i) => i.name);

  return {
    inventoryItemCount: items.length,
    matchedByAssetIdCount,
    matchedByClassInstanceKeyCount,
    matchedClassButNotAssetIdCount,
    wouldLockCount: wouldLockAssetIds.size,
    sampleLockedNames,
    sampleRuleAssetIdsMissingInInventory,
    sampleRuleClassKeysMissingInInventory,
  };
}

/** From pasted JSON: asset ids + classid_instanceid keys (from assets[] entries). */
export function extractManualTradeLockEntries(parsed: unknown): {
  assetIds: string[];
  classInstanceKeys: string[];
} {
  const assetIdSet = new Set<string>();
  const ciSet = new Set<string>();

  const addFromAssetsArray = (assets: unknown[]) => {
    for (const a of assets) {
      if (!a || typeof a !== "object") continue;
      const rec = a as Record<string, unknown>;
      const aid = rec.assetid ?? rec.assetId;
      if (typeof aid === "string" && aid.length > 0) assetIdSet.add(aid);
      else if (typeof aid === "number" && Number.isFinite(aid)) assetIdSet.add(String(aid));
      const cid = rec.classid ?? rec.classId;
      const iid = rec.instanceid ?? rec.instanceId;
      if (cid != null && iid != null) {
        const cs = String(cid);
        const is = String(iid);
        if (cs.length > 0 && is.length > 0) ciSet.add(`${cs}_${is}`);
      }
    }
  };

  if (parsed == null) return { assetIds: [], classInstanceKeys: [] };
  if (Array.isArray(parsed)) {
    for (const x of parsed) {
      if (typeof x === "string" && x.length > 0) assetIdSet.add(x);
    }
    return { assetIds: [...assetIdSet], classInstanceKeys: [...ciSet] };
  }
  if (typeof parsed !== "object") return { assetIds: [], classInstanceKeys: [] };
  const o = parsed as Record<string, unknown>;

  if (Array.isArray(o.assetIds)) {
    for (const x of o.assetIds) {
      if (typeof x === "string" && x.length > 0) assetIdSet.add(x);
    }
  }
  if (Array.isArray(o.assets)) {
    addFromAssetsArray(o.assets);
  }

  return { assetIds: [...assetIdSet], classInstanceKeys: [...ciSet] };
}

/** @deprecated narrow — prefer extractManualTradeLockEntries for full data */
export function extractManualTradeLockAssetIds(parsed: unknown): string[] {
  return extractManualTradeLockEntries(parsed).assetIds;
}

export function resolveOwnerManualTradeLockFilePath(): string | null {
  const fromEnv = process.env.OWNER_MANUAL_TRADE_LOCK_PATH?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(/* turbopackIgnore: true */ process.cwd(), fromEnv);
  }

  const def = path.join(/* turbopackIgnore: true */ process.cwd(), "data", "owner-manual-trade-lock.json");
  try {
    if (fs.existsSync(def)) return def;
  } catch {
    /* ignore */
  }
  return null;
}

let cachedMtimeMs = 0;
let cachedPath: string | null = null;
let cachedFileRule: OwnerManualTradeLockRule = EMPTY_RULE;

let displayFileMtimeMs = 0;
let displayFilePath: string | null = null;
let displayFileSnapshot: NormalizedItem[] = [];

function reloadRuleFromFile(filePath: string): OwnerManualTradeLockRule {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const { assetIds, classInstanceKeys } = extractManualTradeLockEntries(parsed);
  return {
    assetIds: new Set(assetIds),
    classInstanceKeys: new Set(classInstanceKeys),
  };
}

/** File-based rule only (cached by mtime). */
export function getOwnerManualTradeLockRuleFromFile(): OwnerManualTradeLockRule {
  const filePath = resolveOwnerManualTradeLockFilePath();
  if (!filePath) {
    cachedPath = null;
    cachedMtimeMs = 0;
    cachedFileRule = EMPTY_RULE;
    return cachedFileRule;
  }

  try {
    const st = fs.statSync(filePath);
    if (cachedPath === filePath && st.mtimeMs === cachedMtimeMs) return cachedFileRule;

    cachedFileRule = reloadRuleFromFile(filePath);
    cachedPath = filePath;
    cachedMtimeMs = st.mtimeMs;
    const n = cachedFileRule.assetIds.size + cachedFileRule.classInstanceKeys.size;
    if (n > 0) {
      console.log(
        `[owner-manual-trade-lock] loaded from file ${filePath}: ${cachedFileRule.assetIds.size} asset ids, ${cachedFileRule.classInstanceKeys.size} class+instance keys`,
      );
    }
    return cachedFileRule;
  } catch (e) {
    console.error("[owner-manual-trade-lock] failed to read lock file:", filePath, e);
    cachedFileRule = EMPTY_RULE;
    cachedPath = filePath;
    cachedMtimeMs = 0;
    return cachedFileRule;
  }
}

/** DB row if any, else file. */
export async function getOwnerManualTradeLockRule(): Promise<OwnerManualTradeLockRule> {
  try {
    const row = await prisma.ownerManualTradeLockList.findUnique({
      where: { id: "singleton" },
    });
    if (row) {
      return {
        assetIds: new Set(row.assetIds),
        classInstanceKeys: new Set(row.classInstanceKeys),
      };
    }
  } catch (e) {
    console.error("[owner-manual-trade-lock] db read failed:", e);
  }
  return getOwnerManualTradeLockRuleFromFile();
}

/**
 * Normalized rows from admin lock-only JSON. DB column wins when present (including []); else parse lock file (mtime-cached).
 */
export async function getOwnerManualLockDisplayItems(): Promise<NormalizedItem[]> {
  try {
    const row = await prisma.ownerManualTradeLockList.findUnique({
      where: { id: "singleton" },
    });
    if (row && row.lockDisplayItems != null) {
      return coerceLockDisplayItemsFromDbJson(row.lockDisplayItems);
    }
  } catch (e) {
    console.error("[owner-manual-trade-lock] db read lockDisplayItems failed:", e);
  }

  const filePath = resolveOwnerManualTradeLockFilePath();
  if (!filePath) return [];

  try {
    const st = fs.statSync(filePath);
    if (displayFilePath === filePath && st.mtimeMs === displayFileMtimeMs) return displayFileSnapshot;

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    displayFileSnapshot = buildOwnerLockOnlySnapshotFromParsedJson(parsed, process.env.OWNER_STEAM_ID);
    displayFilePath = filePath;
    displayFileMtimeMs = st.mtimeMs;
    return displayFileSnapshot;
  } catch (e) {
    console.error("[owner-manual-trade-lock] lock JSON file read failed:", filePath, e);
    return [];
  }
}
