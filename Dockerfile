# syntax=docker/dockerfile:1
# ---- deps: install production dependencies (cache-friendly) ----
FROM node:22-slim AS deps
WORKDIR /app
# Prisma's query engine needs OpenSSL present to detect the right libssl at both
# generate and run time (node:*-slim ships without it).
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Workspace manifests first so `npm ci` layers cache on dependency changes only.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/hris/package.json packages/hris/package.json
COPY apps/api/package.json apps/api/package.json
# Prisma schema is needed to generate the client (postgres store driver).
COPY prisma ./prisma
# Full install (incl. the prisma CLI) so we can generate the client, generate it,
# then prune dev deps — the generated @prisma/client + query engine stay (prod dep),
# the CLI/typescript are dropped. tsx (the runtime) is a prod dep and remains.
RUN npm ci
RUN npx prisma generate
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0
WORKDIR /app
# libssl for the Prisma query engine at runtime.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Installed deps (root-owned, read-only) + app source (owned by the runtime user).
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
EXPOSE 8787
# The app runs the TypeScript entrypoint directly via tsx (a runtime dependency).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "start"]
