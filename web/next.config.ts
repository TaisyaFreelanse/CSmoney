import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["puppeteer", "@puppeteer/browsers"],
  /** Allow importing shared helpers (e.g. partner-inventory-scroll) from repo `../shared`. */
  experimental: {
    externalDir: true,
  },
  /**
   * Repo root (parent of `web/`) so Turbopack resolves `web/src/lib` → `shared/` imports.
   * Do not set this to `web` only — that breaks `../../../shared/*.js` and fails production build.
   */
  turbopack: {
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
