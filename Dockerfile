# Dev-mode image for the dev-dashboard.
# It runs `next dev` (the production `next build` is currently blocked by a Next 16
# .next/types React-namespace issue). Host integrations — AWS SSO cache, ~/.claude,
# ./repos, .env.local — are provided by bind mounts in docker-compose.yml, NOT baked in.
#
# `git` is installed so the setup gate can clone repos. The AWS CloudWatch panel reads
# credentials via the AWS SDK from the mounted ~/.aws (run `aws sso login` on the HOST);
# no AWS CLI is needed inside the container.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Install deps first for layer caching. When compose bind-mounts the source, the
# anonymous /app/node_modules volume is seeded from this layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

# Bypass the `predev` hook (host aws sso + repo check) — those run against the host.
CMD ["npx", "next", "dev", "-H", "0.0.0.0", "-p", "3000"]
