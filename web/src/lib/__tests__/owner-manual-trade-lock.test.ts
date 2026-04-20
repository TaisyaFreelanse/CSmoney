import { describe, it, expect } from "vitest";
import {
  extractManualTradeLockAssetIds,
  extractManualTradeLockEntries,
  filterSteamItemsTradableForTradeTab,
  itemMatchesOwnerManualLock,
  mergeOwnerSteamAndManualLockJson,
  splitOwnerSteamSelectableAndTradeLockedForStore,
  type OwnerManualTradeLockRule,
} from "../owner-manual-trade-lock";
import type { NormalizedItem } from "../steam-inventory";

const baseItem = (assetId: string, tradable: boolean, classId = "c", instanceId = "i"): NormalizedItem => ({
  assetId,
  classId,
  instanceId,
  marketHashName: "AK-47 | Redline (Field-Tested)",
  name: "AK-47 | Redline",
  iconUrl: "",
  rarity: null,
  rarityColor: null,
  type: null,
  wear: null,
  floatValue: null,
  phaseLabel: null,
  stickers: [],
  tradeLockUntil: null,
  tradable,
  marketable: true,
  inspectLink: null,
});

describe("extractManualTradeLockEntries", () => {
  it("reads asset ids and classid_instanceid from Steam assets[]", () => {
    const r = extractManualTradeLockEntries({
      assets: [
        { assetid: "50881305496", classid: "7993039468", instanceid: "8347147322", amount: "1" },
      ],
    });
    expect(r.assetIds).toContain("50881305496");
    expect(r.classInstanceKeys).toContain("7993039468_8347147322");
  });
});

describe("extractManualTradeLockAssetIds", () => {
  it("reads myskins-style assets[].assetid", () => {
    const ids = extractManualTradeLockAssetIds({
      assets: [
        { assetid: "111", classid: "a" },
        { assetid: 222, classid: "b" },
      ],
    });
    expect(ids).toEqual(["111", "222"]);
  });

  it("reads assetIds array", () => {
    expect(extractManualTradeLockAssetIds({ assetIds: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("reads plain string array", () => {
    expect(extractManualTradeLockAssetIds(["x", "y"])).toEqual(["x", "y"]);
  });

  it("returns empty for unknown shape", () => {
    expect(extractManualTradeLockAssetIds({})).toEqual([]);
    expect(extractManualTradeLockAssetIds(null)).toEqual([]);
  });
});

describe("itemMatchesOwnerManualLock", () => {
  it("matches by class+instance when assetId differs", () => {
    const rule: OwnerManualTradeLockRule = {
      assetIds: new Set(),
      classInstanceKeys: new Set(["7993039468_8347147322"]),
    };
    const item = baseItem("different-asset-id", true, "7993039468", "8347147322");
    expect(itemMatchesOwnerManualLock(item, rule)).toBe(true);
  });
});

describe("filterSteamItemsTradableForTradeTab", () => {
  it("keeps tradable items without future lock", () => {
    const items = [baseItem("1", true), baseItem("2", true)];
    const out = filterSteamItemsTradableForTradeTab(items);
    expect(out.map((i) => i.assetId).sort()).toEqual(["1", "2"]);
  });

  it("drops non-tradable steam rows", () => {
    const items = [baseItem("1", true), baseItem("2", false)];
    const out = filterSteamItemsTradableForTradeTab(items);
    expect(out.map((i) => i.assetId)).toEqual(["1"]);
  });

  it("drops rows with future tradeLockUntil", () => {
    const future = new Date(Date.now() + 864e5 * 7).toISOString();
    const items = [baseItem("1", true), { ...baseItem("2", true), tradeLockUntil: future }];
    const out = filterSteamItemsTradableForTradeTab(items);
    expect(out.map((i) => i.assetId)).toEqual(["1"]);
  });
});

describe("splitOwnerSteamSelectableAndTradeLockedForStore", () => {
  it("partitions live steam rows without overlap; union equals input count", () => {
    const future = new Date(Date.now() + 864e5 * 3).toISOString();
    const items = [
      baseItem("a", true),
      baseItem("b", false),
      { ...baseItem("c", true), tradeLockUntil: future },
    ];
    const { selectable, steamTradeLocked } = splitOwnerSteamSelectableAndTradeLockedForStore(items);
    const selIds = new Set(selectable.map((i) => i.assetId));
    const lockIds = new Set(steamTradeLocked.map((i) => i.assetId));
    expect(selIds.size).toBe(selectable.length);
    for (const id of selIds) expect(lockIds.has(id)).toBe(false);
    expect(selIds.size + lockIds.size).toBe(items.length);
    expect([...selIds].sort()).toEqual(["a"]);
    expect([...lockIds].sort()).toEqual(["b", "c"]);
  });
});

describe("mergeOwnerSteamAndManualLockJson", () => {
  it("appends manual rows with locked true and tradable false", () => {
    const steam = [baseItem("1", true)];
    const manual = [baseItem("99", true, "cx", "ix")];
    const merged = mergeOwnerSteamAndManualLockJson(steam, [], manual);
    expect(merged).toHaveLength(2);
    expect(merged[0].locked).toBe(false);
    expect(merged[1].locked).toBe(true);
    expect(merged[1].tradable).toBe(false);
  });

  it("inserts steam trade-locked slice between selectable and manual with locked false", () => {
    const future = new Date(Date.now() + 864e5 * 5).toISOString();
    const selectable = [baseItem("1", true)];
    const steamLocked = [{ ...baseItem("2", true), tradeLockUntil: future }];
    const manual = [baseItem("99", true, "cx", "ix")];
    const merged = mergeOwnerSteamAndManualLockJson(selectable, steamLocked, manual);
    expect(merged).toHaveLength(3);
    expect(merged.map((i) => i.assetId)).toEqual(["1", "2", "99"]);
    expect(merged[0].locked).toBe(false);
    expect(merged[1].locked).toBe(false);
    expect(merged[1].tradeLockUntil).toBe(future);
    expect(merged[2].locked).toBe(true);
  });
});
