import { afterEach, describe, it, expect } from "vitest";
import {
  normalizeInventory,
  ownerInventoryErrorAllowsDefaultContextFallback,
  resolveOwnerInventoryContextId,
  _testing,
} from "../steam-inventory";

const {
  isDopplerFamilySkin,
  phaseFromPaintIndex,
  detectPhaseFromTagsDescs,
  extractFromAssetProperties,
  resolveInspectLink,
  detectTradeLock,
  INSPECT_PREFIX,
} = _testing;

/**
 * Steam trade hold (e.g. 7-day after trade/market) — what we actually consume:
 *
 * - There is no separate "trade ban" boolean in the Community inventory JSON we use.
 * - Each asset's description record has `tradable: 0 | 1`; during cooldown Steam usually sets 0.
 * - The nested `descriptions` array on that record often includes a line like "Tradable After: …"
 *   (locale-dependent). We parse that into `tradeLockUntil` via detectTradeLock().
 * - If tradable is 0 but no line matches our regexes, the item is still non-tradable — we just
 *   may not have an unlock timestamp in our model.
 *
 * Official ISteamEconomy / legacy Web API item endpoints are not what this app uses for CS2
 * inventory; behavior is defined by the Community inventory response shape we normalize.
 */

/** Same rule as trade UI: locked if Steam says not tradable OR parsed lock date is in the future. */
function isEffectivelyTradeLocked(
  item: { tradable: boolean; tradeLockUntil: string | null },
  now: Date,
): boolean {
  const hasTimedLock = !!item.tradeLockUntil && new Date(item.tradeLockUntil) > now;
  return !item.tradable || hasTimedLock;
}

// ---------------------------------------------------------------------------
// resolveInspectLink
// ---------------------------------------------------------------------------
describe("resolveInspectLink", () => {
  it("uses Item Certificate (propid:6) directly — ignores template placeholders", () => {
    const template =
      "steam://rungame/730/76561202255233023/+csgo_econ_action_preview %owner_steamid%A%assetid%D%propid:6%";
    const props = new Map<number, string>([[6, "AABBCCDD1122"]]);
    const result = resolveInspectLink(template, "7656119800", "12345", props);
    expect(result).toBe(INSPECT_PREFIX + "AABBCCDD1122");
  });

  it("falls back to template replacement when propid:6 is absent", () => {
    const template = "prefix_%propid:1%_middle_%propid:3%_end";
    const props = new Map<number, string>([
      [1, "AAA"],
      [3, "CCC"],
    ]);
    const result = resolveInspectLink(template, "0", "0", props);
    expect(result).toBe("prefix_AAA_middle_CCC_end");
  });

  it("removes %propid:N% when property is missing (fallback path)", () => {
    const template = "steam://run/730//+csgo_econ_action_preview %propid:9%";
    const result = resolveInspectLink(template, "0", "0", new Map());
    expect(result).toBe("steam://run/730//+csgo_econ_action_preview ");
  });

  it("handles old-style template without any propid placeholders (fallback)", () => {
    const template =
      "steam://rungame/730/76561202255233023/+csgo_econ_action_preview S%owner_steamid%A%assetid%D1234";
    const result = resolveInspectLink(template, "999", "555", new Map());
    expect(result).toBe(
      "steam://rungame/730/76561202255233023/+csgo_econ_action_preview S999A555D1234",
    );
  });
});

// ---------------------------------------------------------------------------
// extractFromAssetProperties
// ---------------------------------------------------------------------------
describe("extractFromAssetProperties", () => {
  it("extracts float, paintIndex, and string_value from asset_properties", () => {
    const props = [
      { propertyid: 1, int_value: "316", name: "Pattern Template" },
      { propertyid: 2, float_value: "0.42353", name: "Wear Rating" },
      {
        propertyid: 6,
        string_value: "415181CCEF9AFD4059E66661970F694771427",
        name: "Item Certificate",
      },
      { propertyid: 7, int_value: "418", name: "Finish Catalog" },
    ];
    const result = extractFromAssetProperties(props);
    expect(result.floatValue).toBeCloseTo(0.42353, 4);
    expect(result.paintIndex).toBe(418);
    expect(result.stringProps.get(6)).toBe("415181CCEF9AFD4059E66661970F694771427");
  });

  it("returns nulls for undefined input", () => {
    const result = extractFromAssetProperties(undefined);
    expect(result.floatValue).toBeNull();
    expect(result.paintIndex).toBeNull();
    expect(result.stringProps.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase detection — only Doppler family
// ---------------------------------------------------------------------------
describe("isDopplerFamilySkin", () => {
  it.each([
    ["★ Butterfly Knife | Doppler (Factory New)", true],
    ["★ M9 Bayonet | Gamma Doppler (Factory New)", true],
    ["AWP | Graphite (Minimal Wear)", false],
    ["AK-47 | Wild Lotus (Factory New)", false],
    ["★ Karambit | Doppler (Factory New)", true],
  ])("%s → %s", (name, expected) => {
    expect(isDopplerFamilySkin(name)).toBe(expected);
  });
});

describe("phaseFromPaintIndex", () => {
  it("returns Ruby for paintIndex 415 on Doppler", () => {
    expect(phaseFromPaintIndex(415, "★ Bayonet | Doppler (FN)")).toBe("Ruby");
  });

  it("returns null for paintIndex 415 on non-Doppler", () => {
    expect(phaseFromPaintIndex(415, "AWP | Graphite (MW)")).toBeNull();
  });

  it("returns Phase 2 for paintIndex 619 (gen2 Sapphire)", () => {
    expect(phaseFromPaintIndex(619, "★ Butterfly Knife | Doppler (FN)")).toBe("Sapphire");
  });

  it("returns null for unknown paintIndex on Doppler", () => {
    expect(phaseFromPaintIndex(999, "★ Karambit | Doppler (FN)")).toBeNull();
  });
});

describe("detectPhaseFromTagsDescs", () => {
  it("detects Phase 2 from tags", () => {
    const tags = [{ category: "Phase", localized_tag_name: "Phase 2" }];
    expect(detectPhaseFromTagsDescs(undefined, tags)).toBe("Phase 2");
  });

  it("detects Ruby from descriptions", () => {
    const descs = [{ value: "Ruby" }];
    expect(detectPhaseFromTagsDescs(descs, undefined)).toBe("Ruby");
  });

  it("returns null when no phase info", () => {
    const descs = [{ value: "Some random text" }];
    expect(detectPhaseFromTagsDescs(descs, undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeInventory — inspect link integration
// ---------------------------------------------------------------------------
describe("normalizeInventory — inspect link with Item Certificate", () => {
  it("builds direct link from Item Certificate (propid:6)", () => {
    const raw = {
      assets: [
        { assetid: "50604951680", classid: "111", instanceid: "222", amount: "1" },
      ],
      descriptions: [
        {
          classid: "111",
          instanceid: "222",
          market_hash_name: "AWP | Dragon Lore (Field-Tested)",
          name: "AWP | Dragon Lore",
          icon_url: "abc123",
          tradable: 1,
          marketable: 1,
          tags: [],
          actions: [
            {
              link: "steam://rungame/730/76561202255233023/+csgo_econ_action_preview %owner_steamid%A%assetid%D%propid:6%",
              name: "Inspect in Game...",
            },
          ],
        },
      ],
      asset_properties: [
        {
          assetid: "50604951680",
          asset_properties: [
            { propertyid: 2, float_value: "0.128", name: "Wear Rating" },
            {
              propertyid: 6,
              string_value: "7B68FB8EAD2B9C77A636B5BBA785",
              name: "Item Certificate",
            },
          ],
        },
      ],
    };

    const items = normalizeInventory(raw, "76561198000");
    expect(items).toHaveLength(1);
    expect(items[0].inspectLink).toBe(
      "steam://run/730//+csgo_econ_action_preview%207B68FB8EAD2B9C77A636B5BBA785",
    );
  });

  it("handles old-style template without Item Certificate (fallback)", () => {
    const raw = {
      assets: [
        { assetid: "99999", classid: "A1", instanceid: "B2", amount: "1" },
      ],
      descriptions: [
        {
          classid: "A1",
          instanceid: "B2",
          market_hash_name: "AK-47 | Redline (FT)",
          name: "AK-47 | Redline",
          icon_url: "icon",
          tradable: 1,
          marketable: 1,
          tags: [],
          actions: [
            {
              link: "steam://rungame/730/76561202255233023/+csgo_econ_action_preview S%owner_steamid%A%assetid%DABCDEF",
              name: "Inspect in Game...",
            },
          ],
        },
      ],
    };

    const items = normalizeInventory(raw, "12345");
    expect(items).toHaveLength(1);
    expect(items[0].inspectLink).toBe(
      "steam://rungame/730/76561202255233023/+csgo_econ_action_preview S12345A99999DABCDEF",
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeInventory — Doppler phase NOT applied to non-Doppler skins
// ---------------------------------------------------------------------------
describe("normalizeInventory — no false Doppler phase", () => {
  it("does not assign Ruby to AWP | Graphite even if descriptions mention Ruby", () => {
    const raw = {
      assets: [
        { assetid: "1111", classid: "C1", instanceid: "I1", amount: "1" },
      ],
      descriptions: [
        {
          classid: "C1",
          instanceid: "I1",
          market_hash_name: "AWP | Graphite (Minimal Wear)",
          name: "AWP | Graphite",
          icon_url: "x",
          tradable: 1,
          marketable: 1,
          tags: [],
          descriptions: [
            { value: "Sticker: Ruby (Foil)" },
          ],
        },
      ],
    };

    const items = normalizeInventory(raw);
    expect(items).toHaveLength(1);
    expect(items[0].phaseLabel).toBeNull();
  });

  it("correctly assigns Black Pearl to Doppler knife from asset_properties", () => {
    const raw = {
      assets: [
        { assetid: "2222", classid: "C2", instanceid: "I2", amount: "1" },
      ],
      descriptions: [
        {
          classid: "C2",
          instanceid: "I2",
          market_hash_name: "★ M9 Bayonet | Doppler (Factory New)",
          name: "★ M9 Bayonet | Doppler",
          icon_url: "y",
          tradable: 1,
          marketable: 1,
          tags: [],
        },
      ],
      asset_properties: [
        {
          assetid: "2222",
          asset_properties: [
            { propertyid: 7, int_value: "417" },
          ],
        },
      ],
    };

    const items = normalizeInventory(raw);
    expect(items).toHaveLength(1);
    expect(items[0].phaseLabel).toBe("Black Pearl");
  });
});

// ---------------------------------------------------------------------------
// detectTradeLock — parsed from Steam description lines (not a separate API field)
// ---------------------------------------------------------------------------
describe("detectTradeLock", () => {
  it("parses English «Tradable After: …» into an ISO timestamp when Date understands it", () => {
    const iso = detectTradeLock([
      { value: "Tradable After Apr 20, 2027 14:00:00 GMT" },
    ]);
    expect(iso).not.toBeNull();
    expect(new Date(iso!).getTime()).not.toBeNaN();
    expect(new Date(iso!).getUTCFullYear()).toBe(2027);
  });

  it("parses «Trade Protected … until …»", () => {
    const iso = detectTradeLock([{ value: "Trade Protected until May 01, 2028 0:00:00" }]);
    expect(iso).not.toBeNull();
    expect(new Date(iso!).getUTCFullYear()).toBe(2028);
  });

  it("parses Russian «Торговая блокировка … до …»", () => {
    const iso = detectTradeLock([{ value: "Торговая блокировка до Jun 15, 2027 12:00:00" }]);
    expect(iso).not.toBeNull();
    expect(new Date(iso!).getUTCFullYear()).toBe(2027);
  });

  it("returns null when no trade-hold line is present", () => {
    expect(detectTradeLock([{ value: "Float Value: 0.15" }])).toBeNull();
    expect(detectTradeLock(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeInventory — trade hold (7-day style): tradable flag + description text
// ---------------------------------------------------------------------------
describe("normalizeInventory — trade hold / tradable", () => {
  function minimalDesc(overrides: Record<string, unknown>) {
    return {
      classid: "C",
      instanceid: "I",
      market_hash_name: "AK-47 | Redline (Field-Tested)",
      name: "AK-47 | Redline",
      icon_url: "x",
      tags: [],
      ...overrides,
    };
  }

  it("sets tradable false and tradeLockUntil when Steam sends Tradable After + tradable 0", () => {
    const raw = {
      assets: [{ assetid: "100", classid: "C", instanceid: "I", amount: "1" }],
      descriptions: [
        minimalDesc({
          tradable: 0,
          marketable: 0,
          descriptions: [{ value: "Tradable After Apr 20, 2027 14:00:00 GMT" }],
        }),
      ],
    };
    const [item] = normalizeInventory(raw);
    expect(item.tradable).toBe(false);
    expect(item.tradeLockUntil).not.toBeNull();
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(isEffectivelyTradeLocked(item, now)).toBe(true);
  });

  it("item is still locked when tradable is 0 but no parsable Tradable After line", () => {
    const raw = {
      assets: [{ assetid: "101", classid: "C", instanceid: "I", amount: "1" }],
      descriptions: [
        minimalDesc({
          tradable: 0,
          marketable: 0,
          descriptions: [{ value: "Some other text without dates" }],
        }),
      ],
    };
    const [item] = normalizeInventory(raw);
    expect(item.tradable).toBe(false);
    expect(item.tradeLockUntil).toBeNull();
    expect(isEffectivelyTradeLocked(item, new Date())).toBe(true);
  });

  it("freely tradable item: tradable 1 and no future lock", () => {
    const raw = {
      assets: [{ assetid: "102", classid: "C", instanceid: "I", amount: "1" }],
      descriptions: [
        minimalDesc({
          tradable: 1,
          marketable: 1,
          descriptions: [{ value: "Exterior: Field-Tested" }],
        }),
      ],
    };
    const [item] = normalizeInventory(raw);
    expect(item.tradable).toBe(true);
    expect(item.tradeLockUntil).toBeNull();
    expect(isEffectivelyTradeLocked(item, new Date())).toBe(false);
  });

  it("after lock date passes, timed lock no longer counts (UI uses Date comparison)", () => {
    const raw = {
      assets: [{ assetid: "103", classid: "C", instanceid: "I", amount: "1" }],
      descriptions: [
        minimalDesc({
          tradable: 1,
          marketable: 1,
          descriptions: [{ value: "Tradable After Jan 01, 2020 0:00:00 GMT" }],
        }),
      ],
    };
    const [item] = normalizeInventory(raw);
    expect(item.tradable).toBe(true);
    expect(item.tradeLockUntil).not.toBeNull();
    expect(isEffectivelyTradeLocked(item, new Date("2026-01-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("resolveOwnerInventoryContextId", () => {
  afterEach(() => {
    delete process.env.OWNER_INVENTORY_CONTEXT_ID;
  });

  it("defaults to 2 when unset", () => {
    expect(resolveOwnerInventoryContextId()).toBe("2");
  });

  it("returns set context when numeric", () => {
    process.env.OWNER_INVENTORY_CONTEXT_ID = "16";
    expect(resolveOwnerInventoryContextId()).toBe("16");
  });

  it("ignores invalid value", () => {
    process.env.OWNER_INVENTORY_CONTEXT_ID = "not-a-context";
    expect(resolveOwnerInventoryContextId()).toBe("2");
  });
});

describe("ownerInventoryErrorAllowsDefaultContextFallback", () => {
  it("true for empty / private / old-json errors", () => {
    expect(ownerInventoryErrorAllowsDefaultContextFallback("all_failed(new:empty_inventory,old:private_inventory)")).toBe(
      true,
    );
    expect(ownerInventoryErrorAllowsDefaultContextFallback("community_old_error")).toBe(true);
  });

  it("false for unrelated errors", () => {
    expect(ownerInventoryErrorAllowsDefaultContextFallback("steam_rate_limit")).toBe(false);
  });
});
