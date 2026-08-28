# Tiny Stars Command Center.
#
# One long-running Node process with a real disk. That is the whole reason this
# is not on a serverless platform: the app's speed and privacy come from a local
# SQLite file, and an ephemeral filesystem would lose it between requests.
FROM node:24-slim AS build
WORKDIR /app

# Copy manifests first so a dependency layer is cached across code changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The server has zero runtime dependencies, so only the web build output and the
# source need to travel. No third-party node_modules in the final image.
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY --from=build /app/packages/server ./packages/server
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/package.json ./package.json

# No node_modules in the final image at all.
#
# The server imports the shared contract by RELATIVE path, not as @crm/shared.
# Two reasons, both found by simulating this layout rather than assuming it:
# a bare specifier needs a node_modules symlink that would not survive the copy,
# and Node refuses to strip TypeScript types for anything under node_modules,
# so putting the package there fails a second way.

# The volume is mounted here. Never bake data into the image.
ENV CRM_DATA_DIR=/data
# Bind to every interface so Fly's proxy can reach it. The process is still not
# publicly routable except through that proxy.
ENV CRM_HOST=0.0.0.0
ENV CRM_PORT=4317
ENV CRM_MODE=production

# Run unprivileged. The node image ships a 'node' user for exactly this.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 4317
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/src/main.ts"]
