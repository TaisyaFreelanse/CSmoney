import "server-only";

/**
 * When true, this Node process must not call Steam Community HTTPS or launch Puppeteer/Chromium.
 * Inventory is fetched only via {@link fetchSteamWorkerInventoryDirect} (Hetzner steam-worker).
 *
 * - On Render.com, `RENDER` is set to `"true"` → remote-only unless explicitly opted out with
 *   `STEAM_INVENTORY_REMOTE_WORKER_ONLY=0`.
 * - Locally, set `STEAM_INVENTORY_REMOTE_WORKER_ONLY=1` to match production behavior.
 */
export function isSteamInventoryRemoteWorkerOnly(): boolean {
  const ex = process.env.STEAM_INVENTORY_REMOTE_WORKER_ONLY?.trim().toLowerCase();
  if (ex === "1" || ex === "true" || ex === "yes") return true;
  if (ex === "0" || ex === "false" || ex === "no") return false;
  return process.env.RENDER === "true";
}
