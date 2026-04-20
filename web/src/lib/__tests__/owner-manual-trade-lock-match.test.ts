import { describe, it, expect } from "vitest";
import {
  extractManualTradeLockEntries,
  itemMatchesOwnerManualLock,
  mergeOwnerSteamAndManualLockJson,
} from "../owner-manual-trade-lock";
import { normalizeInventory } from "../steam-inventory";
import type { NormalizedItem } from "../steam-inventory";

/**
 * Regression: Steam community JSON often uses numeric assetid/classid/instanceid in `assets[]`,
 * while pasted admin JSON uses strings. Set.has() must not miss because of number vs string.
 */
describe("manual trade lock matches normalized inventory (realistic types)", () => {
  it("itemMatchesOwnerManualLock: numeric-like item fields + string rule Set", () => {
    const item = {
      assetId: 50881305496,
      classId: 7993039468,
      instanceId: 8347147322,
    } as unknown as NormalizedItem;
    const rule = {
      assetIds: new Set(["50881305496"]),
      classInstanceKeys: new Set<string>(),
    };
    expect(itemMatchesOwnerManualLock(item, rule)).toBe(true);
  });

  it("itemMatchesOwnerManualLock: class+instance string rule + numeric-like item fields", () => {
    const item = {
      assetId: "other",
      classId: 7993039468,
      instanceId: 8347147322,
    } as unknown as NormalizedItem;
    const rule = {
      assetIds: new Set<string>(),
      classInstanceKeys: new Set(["7993039468_8347147322"]),
    };
    expect(itemMatchesOwnerManualLock(item, rule)).toBe(true);
  });

  it("end-to-end: normalize + merge marks pasted rows as locked tail", () => {
    const pasted = {
      assets: [
        {
          assetid: "50881305496",
          classid: "7993039468",
          instanceid: "8347147322",
          amount: "1",
        },
      ],
    };
    extractManualTradeLockEntries(pasted);

    const lockOnlyJson = {
      assets: [
        {
          assetid: 50881305496,
          classid: 7993039468,
          instanceid: 8347147322,
          amount: "1",
        },
      ],
      descriptions: [
        {
          classid: 7993039468,
          instanceid: 8347147322,
          market_hash_name: "AK-47 | Redline (Field-Tested)",
          name: "AK-47 | Redline",
          icon_url: "icon",
          tradable: 1,
          marketable: 1,
          tags: [],
        },
      ],
    };

    const steamJson = {
      assets: [{ assetid: "111", classid: "1", instanceid: "1", amount: "1" }],
      descriptions: [
        {
          classid: "1",
          instanceid: "1",
          market_hash_name: "P250 | Sand Dune (Field-Tested)",
          name: "P250 | Sand Dune",
          icon_url: "x",
          tradable: 1,
          marketable: 1,
          tags: [],
        },
      ],
    };

    const steam = normalizeInventory(steamJson);
    const manual = normalizeInventory(lockOnlyJson);
    expect(steam).toHaveLength(1);
    expect(manual).toHaveLength(1);

    const merged = mergeOwnerSteamAndManualLockJson(steam, [], manual);
    expect(merged).toHaveLength(2);
    expect(merged[0].locked).toBe(false);
    expect(merged[0].assetId).toBe("111");
    expect(merged[1].locked).toBe(true);
    expect(merged[1].assetId).toBe("50881305496");
  });
});
