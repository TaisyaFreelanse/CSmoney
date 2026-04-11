import "server-only";

import { fetchGuestInventoryViaTradeOfferPuppeteer } from "@/lib/guest-inventory-puppeteer";
import { normalizeSteamId64ForCache, parseTradeUrl, steamId64FromPartner } from "@/lib/steam-community-url";

/**
 * Owner shop: same trade-offer / partner-column capture as guest, with OWNER_TRADE_URL pointing at this account.
 * Logs use `owner_inv_puppeteer` + `puppeteer_owner_invoke` (see guest-inventory-puppeteer).
 */
export async function fetchOwnerInventoryViaTradeOfferPuppeteer(tradeUrl: string) {
  const owner = process.env.OWNER_STEAM_ID?.trim();
  const parsed = parseTradeUrl(tradeUrl.trim());
  if (owner && parsed) {
    const partner64 = steamId64FromPartner(parsed.partner);
    if (partner64 && normalizeSteamId64ForCache(partner64) !== normalizeSteamId64ForCache(owner)) {
      console.warn("[owner-inv-puppeteer] OWNER_TRADE_URL partner SteamID !== OWNER_STEAM_ID", {
        ownerSteamId: owner,
        tradeUrlPartner: partner64,
      });
    }
  }
  return fetchGuestInventoryViaTradeOfferPuppeteer(tradeUrl.trim(), { logProfile: "owner" });
}
