# syntax=docker/dockerfile:1.7

# Pin Node to an exact LTS patch. Bump deliberately (Renovate/Dependabot recommended).
ARG NODE_VERSION=24.13.0-slim

# ============================================
# Stage 1: install ALL deps (dev included, needed for build + migrations)
# ============================================
FROM node:${NODE_VERSION} AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ============================================
# Stage 2: build Next.js (standalone output)
# ============================================
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* values are inlined at BUILD time, so pass them as build args.
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

# Do NOT touch the database at build time (no DATABASE_URL here).
RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# ============================================
# Stage 3: one-shot migration runner (used by the `migrate` compose service)
# ============================================
FROM node:${NODE_VERSION} AS migrator
WORKDIR /app

ENV NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json drizzle.config.ts ./
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node db/schema.ts ./db/schema.ts

USER node
CMD ["npx", "drizzle-kit", "migrate"]

# ============================================
# Stage 4: minimal runtime
# ============================================
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Writable cache dir for ISR / image optimization (compose mounts a tmpfs here
# because the root filesystem is read-only).
RUN mkdir -p .next/cache && chown -R node:node .next

USER node
EXPOSE 3000

# slim has no curl/wget; use Node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]