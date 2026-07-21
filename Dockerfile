# ---- build ----
FROM node:24-slim AS build
# toolchain so better-sqlite3 can compile if no prebuilt binary applies
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/ai/package.json packages/ai/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/bridge.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/ai/package.json ./packages/ai/package.json
COPY --from=build /app/packages/ai/dist ./packages/ai/dist
COPY --from=build /app/packages/ai/models ./packages/ai/models
COPY --from=build /app/packages/ai/vendor ./packages/ai/vendor
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
VOLUME /data
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
