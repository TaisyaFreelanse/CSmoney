import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterOwnerStorePublicRows,
  listWhitelistAssetIdsMissingFromRows,
  parseEnvAssetIdSet,
} from "../owner-store-visibility";
import type { OwnerPublicInventoryRow } from "../owner-manual-trade-lock";

function row(assetId: string, locked = false): OwnerPublicInventoryRow {
  return {
    assetId,
    classId: "1",
    instanceId: "0",
    marketHashName: "Test",
    name: "Test",
    iconUrl: "",
    rarity: null,
    rarityColor: null,
    type: null,
    wear: null,
    floatValue: null,
    phaseLabel: null,
    stickers: [],
    tradeLockUntil: null,
    tradable: true,
    marketable: true,
    inspectLink: null,
    locked,
  };
}

describe("parseEnvAssetIdSet", () => {
  it("parses comma and whitespace", () => {
    const s = parseEnvAssetIdSet("  a, b ; c  ");
    expect([...s].sort()).toEqual(["a", "b", "c"]);
  });
  it("returns empty for empty", () => {
    expect(parseEnvAssetIdSet("").size).toBe(0);
    expect(parseEnvAssetIdSet(undefined).size).toBe(0);
  });

  it("strips BOM and wrapping quotes (Render / copy-paste)", () => {
    const s = parseEnvAssetIdSet('\uFEFF"111,222"');
    expect([...s].sort()).toEqual(["111", "222"]);
  });

  it("strips CR and per-token quotes", () => {
    const s = parseEnvAssetIdSet("333\r\n\"444\"");
    expect([...s].sort()).toEqual(["333", "444"]);
  });
});

describe("listWhitelistAssetIdsMissingFromRows", () => {
  it("lists ids not present in rows", () => {
    const miss = listWhitelistAssetIdsMissingFromRows(new Set(["1", "9"]), [row("1"), row("2")]);
    expect(miss).toEqual(["9"]);
  });
});

describe("filterOwnerStorePublicRows", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("whitelist keeps only listed ids", () => {
    vi.stubEnv("OWNER_STORE_VISIBLE_ASSET_IDS", "10,20");
    vi.stubEnv("OWNER_STORE_HIDE_ASSET_IDS", "");
    const out = filterOwnerStorePublicRows([row("10"), row("20"), row("30")]);
    expect(out.map((i) => i.assetId).sort()).toEqual(["10", "20"]);
  });

  it("whitelist wins over hide when both set", () => {
    vi.stubEnv("OWNER_STORE_VISIBLE_ASSET_IDS", "10");
    vi.stubEnv("OWNER_STORE_HIDE_ASSET_IDS", "10");
    const out = filterOwnerStorePublicRows([row("10"), row("20")]);
    expect(out.map((i) => i.assetId)).toEqual(["10"]);
  });

  it("blacklist removes ids when no whitelist", () => {
    vi.stubEnv("OWNER_STORE_VISIBLE_ASSET_IDS", "");
    vi.stubEnv("OWNER_STORE_HIDE_ASSET_IDS", "50745900691");
    const out = filterOwnerStorePublicRows([row("50745900691"), row("51178755989")]);
    expect(out.map((i) => i.assetId)).toEqual(["51178755989"]);
  });

  it("filters manual locked rows by asset id too", () => {
    vi.stubEnv("OWNER_STORE_VISIBLE_ASSET_IDS", "99");
    const out = filterOwnerStorePublicRows([row("99", true), row("100", true)]);
    expect(out).toHaveLength(1);
    expect(out[0].assetId).toBe("99");
  });
});
