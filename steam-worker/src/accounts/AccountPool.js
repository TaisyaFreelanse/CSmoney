import path from "node:path";
import fs from "node:fs";
import { logJson } from "../utils/logger.js";

const DEFAULT_INVALID_MS = 20 * 60 * 1000;

function parseAccounts() {
  const raw = process.env.STEAM_ACCOUNTS?.trim();
  if (!raw) {
    console.warn("[steam-worker] STEAM_ACCOUNTS is empty");
    return [];
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const cwd = process.cwd();
    return arr
      .map((row, i) => {
        if (!row || typeof row !== "object") return null;
        const id = typeof row.id === "string" ? row.id.trim() : `acc_${i}`;
        const rel = typeof row.userDataDir === "string" ? row.userDataDir.trim() : "";
        if (!rel) return null;
        const userDataDir = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
        return { id, userDataDir };
      })
      .filter(Boolean);
  } catch (e) {
    console.error("[steam-worker] STEAM_ACCOUNTS JSON parse failed", e);
    return [];
  }
}

export class AccountPool {
  constructor() {
    this.accounts = parseAccounts();
    this.rr = 0;
    /** @type {Map<string, number>} */
    this.invalidUntil = new Map();
    /** @type {Set<string>} */
    this.busy = new Set();
    this.invalidMs = Number(process.env.STEAM_ACCOUNT_INVALID_MS) || DEFAULT_INVALID_MS;
  }

  list() {
    return this.accounts;
  }

  getStats() {
    const now = Date.now();
    let invalid = 0;
    for (const a of this.accounts) {
      const u = this.invalidUntil.get(a.id);
      if (u != null && u > now) invalid++;
    }
    return {
      total: this.accounts.length,
      busy: this.busy.size,
      invalid,
    };
  }

  /** @returns {Array<{ id: string, busy: boolean, invalidUntil: number }>} */
  getDebugAccounts() {
    const now = Date.now();
    return this.accounts.map((a) => {
      const until = this.invalidUntil.get(a.id);
      const invalidUntil =
        until != null && until > now ? until : 0;
      return {
        id: a.id,
        busy: this.busy.has(a.id),
        invalidUntil,
      };
    });
  }

  isUsable(id) {
    const until = this.invalidUntil.get(id);
    if (until == null) return true;
    if (Date.now() >= until) {
      this.invalidUntil.delete(id);
      logJson("steam_worker_account_recovered", { accountId: id });
      return true;
    }
    return false;
  }

  markSessionInvalid(accountId, reason) {
    this.invalidUntil.set(accountId, Date.now() + this.invalidMs);
    logJson("steam_worker_account_invalidated", {
      accountId,
      reason,
      cooldownMs: this.invalidMs,
      until: new Date(this.invalidUntil.get(accountId)).toISOString(),
    });
  }

  tryAcquire() {
    if (this.accounts.length === 0) return null;
    const n = this.accounts.length;
    for (let k = 0; k < n; k++) {
      const idx = (this.rr + k) % n;
      const acc = this.accounts[idx];
      if (!this.isUsable(acc.id)) continue;
      if (this.busy.has(acc.id)) continue;
      this.rr = (idx + 1) % n;
      this.busy.add(acc.id);
      const id = acc.id;
      return {
        account: acc,
        release: () => {
          this.busy.delete(id);
        },
      };
    }
    return null;
  }

  async acquire(timeoutMs = 300_000, pollMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const got = this.tryAcquire();
      if (got) return got;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  }

  ensureProfileDir(account) {
    try {
      fs.mkdirSync(account.userDataDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}
