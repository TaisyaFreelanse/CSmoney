import { describe, expect, it } from "vitest";
import { generateLink } from "@csfloat/cs2-inspect-serializer";

import { tryInspectFromSerializedLink } from "../csfloat";

describe("tryInspectFromSerializedLink", () => {
  it("decodes CS2 hex inspect link without HTTP", () => {
    const link = generateLink({
      defindex: 7,
      paintindex: 282,
      paintseed: 361,
      paintwear: 0.22740158438682556,
      rarity: 5,
      quality: 4,
      stickers: [],
      keychains: [],
      variations: [],
    });
    const row = tryInspectFromSerializedLink(link);
    expect(row).not.toBeNull();
    expect(row!.paintIndex).toBe(282);
    expect(row!.paintSeed).toBe(361);
    expect(row!.floatValue).toBeGreaterThan(0.22);
    expect(row!.floatValue).toBeLessThan(0.23);
  });

  it("returns null for classic S…A…D… links (remote inspect only)", () => {
    const link =
      "steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S76561198084749846A22547095285D17054198177995786400";
    expect(tryInspectFromSerializedLink(link)).toBeNull();
  });
});
