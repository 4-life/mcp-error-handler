# syntax=docker/dockerfile:1

FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
RUN apk add --no-cache git openssh-client
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    APP_CONFIG_DIR=/app/config/apps \
    REPO_CACHE_DIR=/app/data/repos \
    WORKTREE_DIR=/app/data/worktrees

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY config ./config

RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]