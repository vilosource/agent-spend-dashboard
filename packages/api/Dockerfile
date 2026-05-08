# Multi-stage build for @vilosource/agent-spend-api + the SPA bundle.
#
# Stage 1: install workspace deps + build the SPA (Vite outputs to
#          packages/api/dist/spa/) AND the API TypeScript.
# Stage 2: copy only the runtime artefacts. The SPA dist sits at
#          /app/dist/spa, which app.ts resolves and serves via
#          express.static.

FROM node:20.18-bookworm-slim AS build
WORKDIR /repo

# Copy the monorepo manifest, lockfile, tsconfig + every workspace
# package.json so npm install resolves the full workspace graph
# (including @vilosource/agent-spend-spa).
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/_template/package.json ./packages/_template/
COPY packages/api/package.json ./packages/api/
COPY packages/spa/package.json ./packages/spa/
RUN npm install --no-audit --no-fund --ignore-scripts

# Source.
COPY packages/_template ./packages/_template
COPY packages/api ./packages/api
COPY packages/spa ./packages/spa

# Build the SPA first so its bundle lands in packages/api/dist/spa/
# before the API build runs. The order doesn't strictly matter — both
# write into different subtrees of dist/ — but keeping it deterministic
# helps when reading build logs.
RUN npm run -w @vilosource/agent-spend-spa build
RUN npm run -w @vilosource/agent-spend-api build

# Stage 2: lean runtime
FROM node:20.18-bookworm-slim AS runtime
WORKDIR /app

# Runtime deps + the API's compiled JS + the SPA's static bundle.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/api/dist ./dist
COPY --from=build /repo/packages/api/package.json ./

ENV NODE_ENV=production
EXPOSE 8080

# Use exec form so SIGTERM reaches Node (graceful shutdown wired in cli.ts)
CMD ["node", "./dist/server/cli.js"]
