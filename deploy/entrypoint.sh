#!/usr/bin/env bash
# Container entrypoint: prepares the Hermes Agent environment and starts the bot.
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-/home/node/.hermes}"
export HERMES_HOME

log() { printf '[entrypoint] %s\n' "$*"; }

# --- Hermes launcher --------------------------------------------------------
HERMES_BIN="$(command -v hermes || true)"
if [ -z "$HERMES_BIN" ]; then
  HERMES_BIN="$(find "$HERMES_HOME" -maxdepth 4 -type f -name hermes -perm -u+x 2>/dev/null | head -n1 || true)"
fi
if [ -z "$HERMES_BIN" ]; then
  log "FATAL: the hermes binary was not found"
  exit 1
fi
export HERMES_BIN
export PATH="$(dirname "$HERMES_BIN"):$PATH"
log "hermes: $HERMES_BIN"

# --- uv / uvx (the DuckDuckGo MCP server is started with uvx) ---------------
UV_BIN="$(find "$HERMES_HOME/tools" -maxdepth 3 -type f -name uv 2>/dev/null | head -n1 || true)"
if [ -n "$UV_BIN" ]; then
  export PATH="$(dirname "$UV_BIN"):$PATH"
  log "uv: $UV_BIN"
else
  log "warning: uv was not found, the DuckDuckGo MCP server will not start"
fi

# --- The Obsidian skill reads the vault path from the Hermes environment ----
mkdir -p "$HERMES_HOME"
cat > "$HERMES_HOME/.env" <<EOF
OBSIDIAN_VAULT_PATH=${OBSIDIAN_VAULT_PATH:-/vault}
EOF
chmod 600 "$HERMES_HOME/.env"

# --- The agent and the bot ---------------------------------------------------
# The agent gets no token of Telegram. When the token is in the environment,
# the agent starts a gateway of its own and polls Telegram with it, and the
# bot gets a conflict from Telegram. The application needs both values, so
# they are put back before the start.
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
OWNER_ID="${ALLOWED_TELEGRAM_ID:-}"
unset TELEGRAM_BOT_TOKEN
unset ALLOWED_TELEGRAM_ID
# The rest of the secrets are not needed by the agent either, and the agent
# inherits the environment of this shell. The application reads them from the
# file of the environment, so they are kept for the start below and removed
# from the environment the agent would see.
LLM_KEY="${LLM_API_KEY:-}"
MINI_TOKEN="${MINI_APP_TOKEN:-}"
WEBHOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET:-}"
unset LLM_API_KEY
unset MINI_APP_TOKEN
unset TELEGRAM_WEBHOOK_SECRET

# --- Model provider ---------------------------------------------------------
# The agent talks to a local proxy: it adds the session header the OpenCode Go
# relay requires and keeps the real key out of the agent configuration.
#
# A failure here is fatal. The agent without a provider answers nothing, and a
# bot that starts and silently writes no notes is worse than a container that
# refuses to start: the owner sees an error instead of losing messages.
set_provider() {
  local key="$1"
  local value="$2"
  if ! hermes config set "$key" "$value" >/dev/null 2>&1; then
    log "FATAL: could not set $key"
    exit 1
  fi
}

set_provider model.provider custom
set_provider model.base_url "http://127.0.0.1:${LLM_PROXY_PORT:-11434}/v1"
set_provider model.api_key "local-proxy"
set_provider model.default "${HERMES_MODEL:-beam-free}"

# --- MCP servers ------------------------------------------------------------
# The servers are written with `hermes config set`, the command that updates
# the configuration without any interactive question.
mcp_enabled() {
  local line
  line="$(hermes mcp list 2>/dev/null | grep -E "^[[:space:]]*$1[[:space:]]" || true)"
  case "$line" in
    *disabled*) return 1 ;;
    *enabled*) return 0 ;;
    *) return 1 ;;
  esac
}

# The vault: our own server, it writes the notes in a way that is safe for
# Syncthing. This one is not optional: without it the agent has no way to write
# a note at all, because the note run has no direct file tools.
if ! mcp_enabled vault; then
  set_provider mcp_servers.vault.command node
  set_provider mcp_servers.vault.args '["/app/dist/vault/mcp-server.js"]'
  set_provider mcp_servers.vault.env "{\"OBSIDIAN_VAULT_PATH\":\"${OBSIDIAN_VAULT_PATH:-/vault}\",\"VAULT_EVENTS_FILE\":\"${VAULT_EVENTS_FILE:-/app/data/vault-events.json}\",\"TIMEZONE\":\"${TZ:-Asia/Almaty}\",\"LOG_LEVEL\":\"${LOG_LEVEL:-info}\"}"
  set_provider mcp_servers.vault.enabled true
fi

# The web search: the DuckDuckGo server of the community. The version is
# pinned, so a user message never pulls a new release of the server from the
# network in the middle of a run.
if ! mcp_enabled ddg-search; then
  set_provider mcp_servers.ddg-search.command uvx
  set_provider mcp_servers.ddg-search.args '["--from","duckduckgo-mcp-server==0.2.5","duckduckgo-mcp-server"]'
  set_provider mcp_servers.ddg-search.enabled true
fi

log "mcp servers:"
hermes mcp list 2>&1 | sed 's/^/[entrypoint] /' || log "warning: could not list the mcp servers"

# --- Start ------------------------------------------------------------------
log "starting: $*"
export TELEGRAM_BOT_TOKEN="$BOT_TOKEN"
export ALLOWED_TELEGRAM_ID="$OWNER_ID"
export LLM_API_KEY="$LLM_KEY"
export MINI_APP_TOKEN="$MINI_TOKEN"
export TELEGRAM_WEBHOOK_SECRET="$WEBHOOK_SECRET"
exec "$@"
