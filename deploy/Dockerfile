# syntax=docker/dockerfile:1

# ==============================================================================
# Telegram to Obsidian agent
#
#   stage 1 (base)    : Node.js + Hermes Agent (the AI agent that writes notes)
#   stage 2 (builder) : compiles the TypeScript sources
#   stage 3 (runtime) : the final image with the application and the agent
# ==============================================================================

FROM node:22.20.0-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HERMES_HOME=/home/node/.hermes \
    LLM_PROXY_PORT=11434 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# git and curl are needed by the Hermes installer, python by its own runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      python3 \
      python3-venv \
      python3-pip \
      build-essential \
      util-linux \
    && rm -rf /var/lib/apt/lists/*

# --- Hermes Agent ------------------------------------------------------------
# The agent is installed into the home directory of the `node` user, so it
# lives in the image and does not need the network at runtime.
#
# The version is pinned. The installer script is fetched from a remote address
# and runs with the rights of the build, so an unpinned install means that a
# rebuild of the same commit can produce a different agent, and a change on the
# other side of that address lands in the image without a review. The variable
# is here so a bump is one line and a rebuild.
ARG HERMES_VERSION=2026.9.24
USER node
WORKDIR /home/node

RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
      | bash -s -- --non-interactive --skip-browser --skip-computer-use --version "${HERMES_VERSION}"

# The MCP client of the agent (the Python SDK) is an optional extra.
RUN /home/node/.local/bin/hermes pm install --extra mcp

# The launchers are linked into the standard path, so the agent, the MCP
# servers and every `docker exec` find them.
USER root
RUN ln -sf /home/node/.hermes/hermes-agent/hermes /usr/local/bin/hermes \
    && ln -sf /home/node/.local/bin/hermes-agent /usr/local/bin/hermes-agent \
    && for dir in /home/node/.hermes/tools/uv-*; do \
         ln -sf "$dir/uv" /usr/local/bin/uv; \
         ln -sf "$dir/uvx" /usr/local/bin/uvx; \
       done
USER node

# The Obsidian skill of the agent (MIT, Teknium / Hermes Agent).
RUN mkdir -p /home/node/.hermes/skills/obsidian
COPY --chown=node:node hermes/skills/obsidian/SKILL.md /home/node/.hermes/skills/obsidian/SKILL.md

# --- Application build -------------------------------------------------------
FROM base AS builder

# The base image runs in production mode, but the compiler needs the dev
# dependencies.
ENV NODE_ENV=development

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Mini App build ----------------------------------------------------------
# The frontend of the Mini App: React and Vite.
FROM node:22.20.0-bookworm-slim AS web-builder

ENV NODE_ENV=development

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --include=dev
COPY web/ ./

# The build of the frontend. The bundle has to be in the image, without it the
# Mini App opens as a blank page, so the build checks that it is complete.
ENV NODE_ENV=production
RUN rm -rf dist \
    && npm run build \
    && test -f dist/index.html \
    && ls dist/assets/*.js

# --- Runtime -----------------------------------------------------------------
FROM base AS runtime

USER root

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=web-builder /web/dist ./web
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The frontend has to be complete in the image as well.
RUN test -f /app/web/index.html && ls /app/web/assets/*.js

# The rules of the agent and the entrypoint of the container.
COPY --chown=node:node hermes/workspace/.hermes.md /app/hermes-workspace/.hermes.md
COPY --chown=node:node deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

RUN mkdir -p /app/data /vault && chown -R node:node /app/data /vault
VOLUME ["/app/data"]

ENV HERMES_WORKSPACE=/app/hermes-workspace \
    OBSIDIAN_VAULT_PATH=/vault \
    VAULT_EVENTS_FILE=/app/data/vault-events.json \
    DB_PATH=/app/data/app.db \
    WEB_ROOT=/app/web

USER node
EXPOSE 11434

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
