# syntax=docker/dockerfile:1

FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
# Just git — repo auth is HTTPS via the GitHub App's installation token, no SSH needed.
RUN apk add --no-cache git
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
# The AI agent (and the fallback auto-commit if it forgets) needs a git identity to commit as.
RUN git config --global user.email "mcp-error-handler@local" && \
    git config --global user.name "mcp-error-handler"

EXPOSE 3000
CMD ["node", "dist/index.js"]