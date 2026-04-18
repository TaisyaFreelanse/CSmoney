export function logJson(type, payload) {
  console.log(JSON.stringify({ type, ts: Date.now(), ...payload }));
}

/**
 * Standard inventory job log line.
 */
export function logInventoryEvent(phase, fields) {
  console.log(
    JSON.stringify({
      type: "steam_worker_inventory_job",
      phase,
      timestamp: Date.now(),
      ...fields,
    }),
  );
}
