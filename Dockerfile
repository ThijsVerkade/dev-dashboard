# Dev-mode image for the dev-dashboard.
# It runs `next dev` (the production `next build` is currently blocked by a Next 16
# .next/types React-namespace issue). Host integrations — AWS SSO cache, ~/.claude,
# ./repos, .env.local — are provided by bind mounts in docker-compose.yml, NOT baked in.
#
# `git` is installed so the setup gate can clone repos. The AWS CloudWatch panel reads
# credentials via the AWS SDK from the mounted ~/.aws (run `aws sso login` on the HOST);
# no AWS CLI is needed inside the container. The `claude` CLI is installed so the agent
# runner can spawn headless Claude Code jobs from inside the container (auth comes from
# the mounted ~/.claude — see docker-compose.yml).
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (agent runner spawns `claude` — see lib/agent/runner.ts, CLAUDE_BIN).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Install deps first for layer caching. When compose bind-mounts the source, the
# anonymous /app/node_modules volume is seeded from this layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

# Bypass the `predev` hook (host aws sso + repo check) — those run against the host.
# Echo the friendly local URL first (Next binds 0.0.0.0 inside the container, so it would
# otherwise print a non-clickable http://0.0.0.0:3000), then exec the dev server so signals
# (Ctrl-C / `docker compose down`) propagate to the Node process. `*.localhost` resolves to
# 127.0.0.1 automatically on macOS/Windows/Linux + all browsers — no /etc/hosts, no setup.
CMD ["sh", "-c", "echo '\\n  ➜  dev-dashboard ready at: http://master-dev-dashboard.localhost:3000\\n     (or plain http://localhost:3000)\\n' && exec npx next dev -H 0.0.0.0 -p 3000"]
