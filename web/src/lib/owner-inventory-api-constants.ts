/** Default page size when callers omit `limit` (e.g. scripts). */
export const OWNER_INVENTORY_PAGE_DEFAULT = 30;

/**
 * Hard cap for `limit` on GET /api/inventory/owner. Trade UI loads up to this many items per HTTP request
 * to avoid dozens of sequential round trips; inventories beyond this get a second request (rare).
 */
export const OWNER_INVENTORY_PAGE_MAX = 5000;
