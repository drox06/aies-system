# Production image for the self-host fallback (docker/docker-compose.yml).
# Vercel does not use this — it builds from source directly.

FROM node:22-alpine AS base
# Prisma and sharp both need these on Alpine.
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# --- dependencies ------------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

# --- build -------------------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
# Build-time placeholders. next build evaluates env at module scope in a few places but never
# connects; the real values arrive at runtime from compose.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
ENV DIRECT_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
ENV AUTH_SECRET="build-time-placeholder-not-used-at-runtime"
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# --- runtime -----------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=build /app/public ./public
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# Needed so the container can run `prisma migrate deploy` on start.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts

USER nextjs
EXPOSE 3000

# Migrations run before the server accepts traffic. Safe on every start: `migrate deploy` applies
# only unapplied migrations and is a no-op otherwise.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
