# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim

# Build on the native platform: the output is plain JS, so it works on any CPU.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Runtime: Node + two bundles. No node_modules needed (SQLite is built into Node).
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/golden-balls.db \
    WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /app/server/dist ./server
COPY --from=build /app/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "--enable-source-maps", "server/server.js"]
