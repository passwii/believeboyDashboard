# AWS Public ECR mirrors the official Node image and is reachable from both the
# local Mac (where auth.docker.io is blocked) and GitHub Actions.
FROM public.ecr.aws/docker/library/node:24-alpine AS base
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    npm_config_registry=https://registry.npmmirror.com
RUN --mount=type=cache,id=believeboy-corepack,target=/root/.cache/node/corepack \
    corepack enable && corepack prepare pnpm@10.18.0 --activate
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=believeboy-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# proxy.ts validates this value during `next build`; mounting it as a BuildKit
# secret keeps the production value out of image layers and build history.
RUN --mount=type=secret,id=nextauth_secret \
    NEXTAUTH_SECRET="$(cat /run/secrets/nextauth_secret)" \
    NEXTAUTH_URL="https://dash.believeboy.com" \
    AUTH_URL="https://dash.believeboy.com" \
    NEXT_PUBLIC_CRM_API_MODE="http" \
    pnpm build

FROM public.ecr.aws/docker/library/node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3200

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3200/healthz || exit 1

CMD ["node", "server.js"]
