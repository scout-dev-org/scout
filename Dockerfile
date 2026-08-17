# --- Build stage ---
FROM node:20-alpine AS builder

# Native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

# 1. Copy only dependency manifests (maximizes Docker layer cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY dashboard/package.json dashboard/package.json
COPY widget/package.json widget/package.json

# 2. Install dependencies. pnpm-workspace.yaml allows required native build scripts.
RUN pnpm install --frozen-lockfile

# 3. Copy source
COPY tsconfig.json tsconfig.server.json drizzle.config.ts ./
COPY server/ server/
COPY dashboard/ dashboard/
COPY widget/ widget/
COPY demo/ demo/
COPY drizzle/ drizzle/

# 4. Build all (server TS → JS, dashboard Vite, widget Vite)
RUN pnpm build

# --- Production stage (minimal) ---
FROM node:20-alpine

WORKDIR /app

# Copy node_modules with compiled native addon intact
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Compiled server
COPY --from=builder /app/dist/server ./dist/server

# Built frontend assets
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY --from=builder /app/widget/dist ./widget/dist

# Demo stand + DB migrations
COPY --from=builder /app/demo ./demo
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./

# Directories for data and uploads
RUN mkdir -p data storage/screenshots storage/recordings

VOLUME /app/data
VOLUME /app/storage
EXPOSE 10020

ENV NODE_ENV=production
ENV SCOUT_PORT=10020
ENV SCOUT_DB_PATH=data/scout.db

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://localhost:10020/health || exit 1

CMD ["node", "dist/server/index.js"]
