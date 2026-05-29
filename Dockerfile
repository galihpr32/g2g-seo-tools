# syntax=docker/dockerfile:1.7
# ── G2G SEO Tools — Coolify-targeted Dockerfile ─────────────────────────────
#
# Sprint COOLIFY.DOCKERFILE (344) — replaces the Vercel serverless runtime
# with a self-hosted Docker image. Designed to run on the Branding Server
# (Coolify v4, Ubuntu 24.04, aarch64).
#
# Multi-stage build:
#   1. `deps`     — install npm packages (cacheable)
#   2. `builder`  — run `next build` producing the standalone server bundle
#   3. `runner`   — final small image with Chromium + the standalone build
#
# Chromium is installed natively via apt (NOT @sparticuz/chromium — that's
# Lambda-only). `PUPPETEER_EXECUTABLE_PATH` env var points the launcher at
# the system binary; src/lib/reports/puppeteer-launcher.ts branches on this.
#
# Notes for Coolify deploy:
#   - Coolify auto-injects env vars at runtime; we don't bake secrets here.
#   - `output: 'standalone'` in next.config.ts emits .next/standalone/ with
#     a self-contained server.js + minimal node_modules — that's what we copy.
#   - Final image size target: ~400-500 MB (Chromium is most of it).

# ─── Stage 1: deps ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Build tools are needed for some native modules (puppeteer-core, sharp, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests + lockfile for cacheable layer
COPY package.json package-lock.json* ./

# `npm ci` requires lockfile; use `--legacy-peer-deps` if peer-dep conflicts
# appear during install. PUPPETEER_SKIP_DOWNLOAD avoids pulling Chromium
# during install — we install it at the OS level in the runner stage.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --no-audit --no-fund

# ─── Stage 2: builder ───────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time env vars that Next.js needs for client-side bundle.
# These are PUBLIC values (NEXT_PUBLIC_*) — safe to bake into the image.
# Secret values are injected at runtime by Coolify, NOT here.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_TEST_SLACK_WEBHOOK
ARG NEXT_PUBLIC_TEST_SLACK_CHANNEL_ID
ARG NEXT_PUBLIC_TEST_SLACK_CHANNEL_LBL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
ENV NEXT_PUBLIC_TEST_SLACK_WEBHOOK=${NEXT_PUBLIC_TEST_SLACK_WEBHOOK}
ENV NEXT_PUBLIC_TEST_SLACK_CHANNEL_ID=${NEXT_PUBLIC_TEST_SLACK_CHANNEL_ID}
ENV NEXT_PUBLIC_TEST_SLACK_CHANNEL_LBL=${NEXT_PUBLIC_TEST_SLACK_CHANNEL_LBL}

# Suppress Next.js telemetry phone-home
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN npm run build

# ─── Stage 3: runner (final image) ──────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# Install Chromium + the fonts/libs it needs to render the Friday KPI PNG.
# `chromium` package on bookworm-slim is Debian's stable build (currently
# v131+). It uses the same headless flags puppeteer expects.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
      libnss3 \
      libnspr4 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libgtk-3-0 \
      libasound2 \
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Tell puppeteer-core where to find Chromium. Our puppeteer-launcher.ts
# checks this env var FIRST and uses the system binary when present.
# Skip puppeteer's bundled download (we use the system one).
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Production mode
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user for security (Next.js standalone is happy with this)
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# Copy standalone output + static assets. `output: 'standalone'` in
# next.config.ts produces a server.js bundle with only the minimum deps
# needed at runtime — slimmer than copying full node_modules.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Migrations folder — useful inside the container if we ever exec-into to
# run psql, plus future tooling that reads sql files at runtime. Optional
# but small (<1 MB) so we include.
COPY --from=builder --chown=nextjs:nodejs /app/supabase ./supabase

USER nextjs

EXPOSE 3000

# `tini` reaps zombie chromium processes that puppeteer sometimes leaves
# behind. Without it the Node PID 1 just inherits them and they accumulate.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Standalone bundle entry point. Next.js writes this for us.
CMD ["node", "server.js"]
