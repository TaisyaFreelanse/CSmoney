import { describe, expect, it } from "vitest";
import {
  auditSteamInventoryFloatCoverage,
  buildAssetPropsMapFromSteamRaw,
  extractFloatFromPropertyRows,
  getRgAssetPropertyRows,
  normalizeInventory,
} from "../steam-inventory";

describe("rgAssetProperties (trade XHR shape)", () => {
  const raw = {
    rgInventory: {
      a1: { id: "51021367271", classid: "7993045816", instanceid: "8394832044", amount: "1" },
    },
    rgDescriptions: {
      k: {
        classid: "7993045816",
        instanceid: "8394832044",
        market_hash_name: "★ Karambit | Doppler (Factory New)",
        name: "★ Karambit | Doppler",
        icon_url: "x",
        tradable: 1,
        marketable: 1,
        tags: [],
      },
    },
    rgAssetProperties: {
      "51021367271": [
        { propertyid: 1, int_value: "647" },
        { propertyid: 2, float_value: "0.866007" },
        { propertyid: 6, string_value: "FBEB1C740A7345FAE3F2DB45F8D3FDCBFFC3671E0D01F8" },
        { propertyid: 7, int_value: "418" },
      ],
    },
  };

  it("buildAssetPropsMapFromSteamRaw flattens rgAssetProperties by asset id", () => {
    const m = buildAssetPropsMapFromSteamRaw(raw);
    expect(m.get("51021367271")?.length).toBe(4);
  });

  it("getRgAssetPropertyRows + extractFloatFromPropertyRows match trade XHR contract", () => {
    const rows = getRgAssetPropertyRows(raw, "51021367271");
    expect(rows?.length).toBe(4);
    expect(extractFloatFromPropertyRows(rows)).toBeCloseTo(0.866007, 5);
  });

  it("normalizeInventory reads float and paint from rgAssetProperties", () => {
    const items = normalizeInventory(raw as any, "76561198000000000");
    expect(items).toHaveLength(1);
    expect(items[0].floatValue).toBeCloseTo(0.866007, 5);
    expect(items[0].phaseLabel).toBe("Phase 1"); // paint index 418 — Doppler
    expect(items[0].inspectLink).toContain("FBEB1C740A7345FAE3F2DB45F8D3FDCBFFC3671E0D01F8");
  });

  it("auditSteamInventoryFloatCoverage counts steam float", () => {
    const r = auditSteamInventoryFloatCoverage(raw);
    expect(r.total).toBe(1);
    expect(r.withFloatSteam).toBe(1);
    expect(r.withoutFloat).toBe(0);
    expect(r.withFloatMergedSources).toBe(1);
    expect(r.withoutFloatMergedSources).toBe(0);
    expect(r.withPaintIndexPid7).toBe(1);
    expect(r.dopplerWithPhaseFromPid7).toBe(1);
    expect(r.samplesWithoutFloat).toHaveLength(0);
  });
});

describe("descriptions[].properties inline fallback", () => {
  const raw = {
    assets: [{ assetid: "1", classid: "C", instanceid: "0", amount: "1" }],
    descriptions: [
      {
        classid: "C",
        instanceid: "0",
        market_hash_name: "AK-47 | Redline (Field-Tested)",
        name: "AK-47 | Redline",
        icon_url: "i",
        tradable: 1,
        marketable: 1,
        tags: [],
        properties: [{ propertyid: 2, float_value: "0.25" }],
      },
    ],
    asset_properties: [],
  };

  it("uses inline properties when asset_properties empty", () => {
    const items = normalizeInventory(raw as any, "76561198000000000");
    expect(items[0].floatValue).toBeCloseTo(0.25, 4);
  });

  it("audit: withFloatSteam is 0 without rgAssetProperties but merged float exists", () => {
    const r = auditSteamInventoryFloatCoverage(raw);
    expect(r.withFloatSteam).toBe(0);
    expect(r.withoutFloat).toBe(1);
    expect(r.withFloatMergedSources).toBe(1);
    expect(r.withoutFloatMergedSources).toBe(0);
  });
});
