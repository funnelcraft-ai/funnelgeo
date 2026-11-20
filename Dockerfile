# One image for every FunnelGeo service on Railway (api, worker, collector, web).
# Each Railway service picks its start command from infra/railway/<service>.json.
#
# Chromium is only needed by the worker (report PDFs). Railway passes service
# variables as build args, so set INSTALL_CHROMIUM=true on the worker service.
FROM node:22-bookworm-slim

ARG INSTALL_CHROMIUM=false
RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-noto-color-emoji ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build -w @geo/api && npm run build -w @geo/web

ENV NODE_ENV=production
CMD ["node", "apps/api/dist/server.js"]
