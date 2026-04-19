import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["puppeteer", "@puppeteer/browsers"],
  /** Allow importing shared helpers (e.g. partner-inventory-scroll) from repo `../shared`. */
  experimental: {
    externalDir: true,
  },
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
