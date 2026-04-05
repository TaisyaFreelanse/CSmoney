import { describe, it, expect } from "vitest";
import { normalizeInventory, _testing } from "../steam-inventory";

const {
  isDopplerFamilySkin,
  phaseFromPaintIndex,
  detectPhaseFromTagsDescs,
  extractFromAssetProperties,
  resolveInspectLink,
  INSPECT_PREFIX,
} = _testing;

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
