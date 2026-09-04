# syntax=docker/dockerfile:1
# ---- deps: install production dependencies (cache-friendly) ----
FROM node:22-slim AS deps
WORKDIR /app
# Workspace manifests first so `npm ci` layers cache on dependency changes only.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/hris/package.json packages/hris/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0
WORKDIR /app
# Installed deps (root-owned, read-only) + app source (owned by the runtime user).
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
USER node
EXPOSE 8787
# The app runs the TypeScript entrypoint directly via tsx (a runtime dependency).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "start"]
