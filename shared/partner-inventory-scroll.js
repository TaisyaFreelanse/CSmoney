/**
 * Shared Puppeteer helper: scroll Steam trade-offer partner inventory pane to trigger paginated XHR.
 *
 * @param {{ evaluate: (fn: () => boolean | void) => Promise<unknown> }} page
 */
export async function scrollPartnerInventoryPane(page) {
  await page
    .evaluate(() => {
      const tryScroll = (el) => {
        if (!el || typeof el.scrollTop !== "number") return false;
        const prev = el.scrollTop;
        el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + 900);
        return el.scrollTop > prev;
      };
      const candidates = [
        document.querySelector("#trade_theirs .inventory_ctn"),
        document.querySelector("#trade_theirs .inventory_page"),
        document.querySelector("#inventories .inventory_ctn"),
        document.querySelector("#inventories"),
        document.querySelector("#trade_theirs"),
      ].filter(Boolean);
      for (const el of candidates) {
        if (tryScroll(el)) return true;
      }
      window.scrollBy(0, 500);
      return true;
    })
    .catch(() => {});
}
