#!/bin/bash
set -euo pipefail

# Script vars
REPO_URL="https://github.com/4-life/mcp-error-handler.git"
APP_DIR="${APP_DIR:-$HOME/mcp-error-handler}"
PORT="${PORT:-3000}"

echo "==> Updating packages"
sudo apt update -y

echo "==> Installing Docker"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
else
  echo "Docker already installed, skipping."
fi

if command -v ufw &>/dev/null; then
  echo "==> Opening firewall port $PORT"
  sudo ufw allow "$PORT"/tcp || true
  sudo ufw allow ssh || true
  sudo ufw --force enable || true
fi

echo "==> Fetching the app"
if [ -d "$APP_DIR/.git" ]; then
  echo "Directory $APP_DIR already exists. Pulling latest changes..."
  git -C "$APP_DIR" pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

echo "==> Setting up config"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it with real credentials before wiring up integrations."
fi
echo "App configs live in $APP_DIR/config/apps/ — copy example.yaml per onboarded app and fill it in."

echo "==> Building and starting the container"
sudo PORT="$PORT" docker compose up -d --build

SERVER_IP=$(curl -s -4 ifconfig.me || echo "<server-ip>")
cat <<EOF

========================================
  mcp-error-handler is running
  http://$SERVER_IP:$PORT/healthz
========================================

MCP endpoint:    http://$SERVER_IP:$PORT/mcp
Webhook routes:  http://$SERVER_IP:$PORT/webhooks/{sentry,bugsnag,generic}/:appId

Next steps:
  1. Edit $APP_DIR/.env with real API credentials
  2. Add app configs under $APP_DIR/config/apps/
  3. Re-run: cd $APP_DIR && sudo docker compose up -d --build
========================================
EOF