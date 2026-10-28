FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/client/package.json packages/client/package.json
RUN npm ci --workspace @chatward/shared --workspace @chatward/server \
 && npm run build -w @chatward/shared && npm run build -w @chatward/server

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "packages/server/dist/index.js"]
