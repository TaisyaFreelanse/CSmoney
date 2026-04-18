import "server-only";

const MIN_INTERVAL_MS = 15_000;

/** Max queued + running API inventory fetches (community HTTPS). */
export const STEAM_GUEST_API_MAX_QUEUE = Math.max(
  1,
  Math.min(10, parseInt(process.env.STEAM_GUEST_API_MAX_QUEUE ?? "3", 10) || 3),
);

/** Per-lane max depth (running + queued), same spirit as legacy guest gate. */
export const STEAM_GUEST_PUPPETEER_LANE_MAX_QUEUE = Math.max(
  1,
  Math.min(5, parseInt(process.env.STEAM_GUEST_PUPPETEER_LANE_MAX_QUEUE ?? "2", 10) || 2),
);

/** Max Chromium processes across all lanes (3–5 recommended). */
export const STEAM_PUPPETEER_GLOBAL_MAX = Math.max(
  1,
  Math.min(10, parseInt(process.env.STEAM_PUPPETEER_GLOBAL_MAX ?? "4", 10) || 4),
);

let globalPuppeteerRunning = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type SteamGuestGateOk<T> = { ok: true; value: T; queued: boolean };
export type SteamGuestGateFull = { ok: false; reason: "queue_full" };
export type SteamGuestGateResult<T> = SteamGuestGateOk<T> | SteamGuestGateFull;

let apiChain: Promise<unknown> = Promise.resolve();
let apiLastEnd = 0;
let apiPipelineDepth = 0;

/**
 * Serializes Steam community API inventory fetches with ≥15s spacing (per chain).
 * Guest browser work uses {@link runThroughSteamGuestPuppeteerLaneGate} so API + different accounts can overlap.
 */
export async function runThroughSteamGuestApiGate<T>(
  fn: () => Promise<T>,
  opts?: { skipMinSpacing?: boolean },
): Promise<SteamGuestGateResult<T>> {
  if (apiPipelineDepth >= STEAM_GUEST_API_MAX_QUEUE) {
    return { ok: false, reason: "queue_full" };
  }

  apiPipelineDepth++;
  const thisTaskQueued = apiPipelineDepth > 1;
  let spacingWaited = false;

  const run = async (): Promise<T> => {
    if (!opts?.skipMinSpacing) {
      const elapsed = Date.now() - apiLastEnd;
      const wait = Math.max(0, MIN_INTERVAL_MS - elapsed);
      if (wait > 0) {
        spacingWaited = true;
        await sleep(wait);
      }
    }
    try {
      return await fn();
    } finally {
      apiLastEnd = Date.now();
      apiPipelineDepth--;
    }
  };

  const next = apiChain.then(run, run) as Promise<T>;
  apiChain = next.then(
    () => undefined,
    () => undefined,
  );

  const value = await next;
  return { ok: true, value, queued: thisTaskQueued || spacingWaited };
}

const laneChains = new Map<string, Promise<unknown>>();
const laneLastEnd = new Map<string, number>();
const laneDepth = new Map<string, number>();

/**
 * One Steam login session = one lane: serialized Puppeteer work per lane (≥15s spacing per lane),
 * different lanes may run in parallel (separate browser sessions).
 */
export async function runThroughSteamGuestPuppeteerLaneGate<T>(
  laneId: string,
  fn: () => Promise<T>,
  opts?: { skipMinSpacing?: boolean },
): Promise<SteamGuestGateResult<T>> {
  const lid = laneId.trim() || "default";
  const d = laneDepth.get(lid) ?? 0;
  if (d >= STEAM_GUEST_PUPPETEER_LANE_MAX_QUEUE) {
    return { ok: false, reason: "queue_full" };
  }

  laneDepth.set(lid, d + 1);
  const thisTaskQueued = d > 0;
  let spacingWaited = false;

  let chain = laneChains.get(lid) ?? Promise.resolve();

  const run = async (): Promise<T> => {
    globalPuppeteerRunning++;
    if (globalPuppeteerRunning > STEAM_PUPPETEER_GLOBAL_MAX) {
      globalPuppeteerRunning--;
      laneDepth.set(lid, (laneDepth.get(lid) ?? 1) - 1);
      throw new Error("steam_puppeteer_global_cap");
    }
    if (!opts?.skipMinSpacing) {
      const last = laneLastEnd.get(lid) ?? 0;
      const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - last));
      if (wait > 0) {
        spacingWaited = true;
        await sleep(wait);
      }
    }
    try {
      return await fn();
    } finally {
      globalPuppeteerRunning--;
      laneLastEnd.set(lid, Date.now());
      laneDepth.set(lid, (laneDepth.get(lid) ?? 1) - 1);
    }
  };

  const next = chain.then(run, run) as Promise<T>;
  laneChains.set(
    lid,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );

  try {
    const value = await next;
    return { ok: true, value, queued: thisTaskQueued || spacingWaited };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "steam_puppeteer_global_cap") {
      return { ok: false, reason: "queue_full" };
    }
    throw e;
  }
}
