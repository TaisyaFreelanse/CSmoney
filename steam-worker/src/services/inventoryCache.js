/**
 * In-memory cache: key = canonical trade URL string.
 */
export class InventoryCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    /** @type {Map<string, { data: object, expiresAt: number }>} */
    this.map = new Map();
  }

  get(key) {
    const row = this.map.get(key);
    if (!row) return null;
    if (Date.now() >= row.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return row.data;
  }

  set(key, data) {
    this.map.set(key, { data, expiresAt: Date.now() + this.ttlMs });
  }

  /** @param {string} key */
  delete(key) {
    this.map.delete(key);
  }
}
