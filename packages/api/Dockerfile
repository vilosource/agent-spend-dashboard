# Multi-stage build for @vilosource/agent-spend-api.
# Stage 1: build TypeScript at the monorepo root (so workspace deps resolve).
# Stage 2: copy only the runtime artefacts.

FROM node:20.18-bookworm-slim AS build
WORKDIR /repo

# Copy the monorepo manifest, lockfile, and tsconfig so npm install resolves
# workspace deps; then copy package source. This is the standard Node
# "install before src" cache-friendly layering.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/_template/package.json ./packages/_template/
COPY packages/api/package.json ./packages/api/
RUN npm install --no-audit --no-fund --ignore-scripts

# Now copy source and build
COPY packages/_template ./packages/_template
COPY packages/api ./packages/api
RUN npm run build --workspace=@vilosource/agent-spend-api

# Stage 2: lean runtime
FROM node:20.18-bookworm-slim AS runtime
WORKDIR /app

# Copy the built api package + its runtime deps tree
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/api/dist ./dist
COPY --from=build /repo/packages/api/package.json ./

ENV NODE_ENV=production
EXPOSE 8080

# Use exec form so SIGTERM reaches Node (graceful shutdown wired in cli.ts)
CMD ["node", "./dist/server/cli.js"]
