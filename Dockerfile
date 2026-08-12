# syntax=docker/dockerfile:1

FROM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
# git for repo ops; ca-certificates for HTTPS calls to GitHub/Jira/Slack/Anthropic.
# Debian slim (glibc), not alpine — the Claude Agent SDK ships a compiled native binary that
# fails to launch on musl/Alpine even when the "-musl" package variant resolves correctly;
# glibc is what these prebuilt binaries are actually built and tested against.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
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
