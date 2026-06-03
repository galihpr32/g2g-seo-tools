import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sprint FRIDAY.KPI.GRAPH.4 — puppeteer + sparticuz/chromium must stay
  // external so Next doesn't try to bundle the 50MB chromium binary into the
  // function. Both are loaded at runtime inside the render-png route.
  serverExternalPackages: ['puppeteer-core', '@sparticuz/chromium'],

  // Sprint COOLIFY.NEXTCONFIG (345) — emit a self-contained server bundle
  // at .next/standalone/. The Dockerfile copies that bundle into the final
  // image instead of the full node_modules, cutting image size by ~70%
  // and matching Coolify's expected Docker layout. Vercel ignores this
  // flag and uses its own serverless packaging, so the same config works
  // both places during the migration overlap window.
  output: 'standalone',
};

export default nextConfig;
