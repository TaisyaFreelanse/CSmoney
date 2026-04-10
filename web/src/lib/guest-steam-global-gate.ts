import "server-only";

const MIN_INTERVAL_MS = 15_000;
/** Max operations admitted to the serialized Steam pipeline (running + queued). */
export const STEAM_GUEST_MAX_QUEUE_SIZE = 2;

let lastOperationEnd = 0;
let chain: Promise<unknown> = Promise.resolve();
let pipelineDepth = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type SteamGuestGateOk<T> = { ok: true; value: T; queued: boolean };
export type SteamGuestGateFull = { ok: false; reason: "queue_full" };
export type SteamGuestGateResult<T> = SteamGuestGateOk<T> | SteamGuestGateFull;

/**
 * Serializes guest Steam browser/API work, enforces ≥15s between operations,
 * and rejects when the pipeline is full (no unbounded wait).
 *
 * `skipMinSpacing` is allowed **only** for the second browser attempt after
 * "This inventory is not available" (caller must enforce).
 */
export async function runThroughSteamGuestGate<T>(
  fn: () => Promise<T>,
  opts?: { skipMinSpacing?: boolean },
): Promise<SteamGuestGateResult<T>> {
  if (pipelineDepth >= STEAM_GUEST_MAX_QUEUE_SIZE) {
    return { ok: false, reason: "queue_full" };
  }

  pipelineDepth++;
  const thisTaskQueued = pipelineDepth > 1;
  let spacingWaited = false;

  const run = async (): Promise<T> => {
    if (!opts?.skipMinSpacing) {
      const elapsed = Date.now() - lastOperationEnd;
      const wait = Math.max(0, MIN_INTERVAL_MS - elapsed);
      if (wait > 0) {
        spacingWaited = true;
        await sleep(wait);
      }
    }
    try {
      return await fn();
    } finally {
      pipelineDepth--;
      lastOperationEnd = Date.now();
    }
  };

  const next = chain.then(run, run) as Promise<T>;
  chain = next.then(
    () => undefined,
    () => undefined,
  );

  const value = await next;
  return { ok: true, value, queued: thisTaskQueued || spacingWaited };
}
