import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["puppeteer", "@puppeteer/browsers"],
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
