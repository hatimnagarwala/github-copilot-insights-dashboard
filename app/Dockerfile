FROM node:26-alpine AS deps
WORKDIR /app
RUN npm install --global --no-audit --no-fund pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm store prune

FROM node:26-alpine AS builder
WORKDIR /app
RUN npm install --global --no-audit --no-fund pnpm@11.9.0
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ARG BUILD_ID=1
ARG BUILD_TIME
ENV NEXT_PUBLIC_BUILD_ID=$BUILD_ID
ENV NEXT_PUBLIC_BUILD_TIME=$BUILD_TIME
RUN pnpm run build

# --- Copilot CLI (AI Analyst) -------------------------------------------------
# The Copilot SDK shells out to the @github/copilot CLI — a thin wrapper that
# loads a platform-specific binary (e.g. @github/copilot-linuxmusl-x64 on Alpine)
# via detect-libc. Next's standalone tracer can't follow the SDK's dynamic
# require for it, so install the CLI on its own here as a clean, flat tree and
# point COPILOT_CLI_PATH at it in the runner.
# Keep this version in sync with @github/copilot in app/pnpm-lock.yaml.
FROM node:26-alpine AS copilot-cli
WORKDIR /cli
RUN npm install --omit=dev --no-audit --no-fund @github/copilot@1.0.68
RUN test -f /cli/node_modules/@github/copilot/npm-loader.js

FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Where the Copilot SDK finds the CLI it spawns (see the copilot-cli stage).
ENV COPILOT_CLI_PATH=/app/copilot-cli/node_modules/@github/copilot/npm-loader.js

# Upgrade base OS packages (e.g. zlib) to pick up security patches, then add the
# runtime library the native Copilot CLI binary needs on Alpine/musl.
RUN apk --no-cache upgrade && apk add --no-cache libstdc++

# The runtime only runs `node server.js` — npm is never invoked, and the npm that
# ships in the base image bundles vulnerable deps (undici, tar, minimatch,
# ip-address, brace-expansion). Remove npm entirely so it can't be flagged/used.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/demo-data ./demo-data
COPY --from=copilot-cli --chown=nextjs:nodejs /cli/node_modules ./copilot-cli/node_modules
RUN test -f "$COPILOT_CLI_PATH"

USER nextjs
EXPOSE 3000

# Liveness/readiness probe — hits /api/health (which also verifies DB
# connectivity) via Node's built-in fetch, so no curl/wget is required. The
# start period covers app boot + automatic migrations from instrumentation.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
