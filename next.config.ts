import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sprint FRIDAY.KPI.GRAPH.4 — puppeteer + sparticuz/chromium must stay
  // external so Next doesn't try to bundle the 50MB chromium binary into the
  // function. Both are loaded at runtime inside the render-png route.
  serverExternalPackages: ['puppeteer-core', '@sparticuz/chromium'],
};

export default nextConfig;
