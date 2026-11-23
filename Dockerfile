# syntax=docker/dockerfile:1
# One image for everything: launcher (behind tini) + app (baseline under /app) + Chromium. Data: volume /data.
# The base is pinned by digest (Dependabot keeps it current); `apk upgrade` pulls in Alpine security fixes at build time.

# ---- Build: build the frontend and assemble the app directory exactly like a release artifact ----
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
ARG VERSION=""
RUN npm run build \
 && node scripts/build-release.mjs --stage-only /out/app ${VERSION:+--version "$VERSION"}

# ---- Runtime ----
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ARG BASE_IMAGE=node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
# tini: forwards signals and reaps zombie processes (Chromium); tzdata: TZ for the backup schedule.
# apk upgrade: security updates of the base even when the base digest has not been bumped yet.
RUN apk upgrade --no-cache \
 && apk add --no-cache tini tzdata chromium nss freetype harfbuzz ca-certificates ttf-freefont
# PREVIEW_BROWSER_NO_SANDBOX: Chromium's sandbox needs user namespaces, which are not available in a default
# container (without --cap-add SYS_ADMIN / a custom seccomp profile) and would make it fail to start.
# The container (non-root, no extra privileges) is the isolation layer here; the flag is NOT set for local runs.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data \
    CHROME_PATH=/usr/bin/chromium PREVIEW_BROWSER_NO_SANDBOX=1
WORKDIR /app
# The baseline is owned by root and read-only for the app; app updates land in /data/app/releases/<version>
COPY --from=build /out/app /app
# Component list (Node, Alpine packages, Chromium, launcher) for the update view and the security watcher in CI
RUN WISHY_BASE_IMAGE="${BASE_IMAGE}" node /app/launcher/lib/components.js --app /app --out /app/components.json \
 && mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
# Healthy when the app responds OR an update/restore is currently running (the maintenance page is intended then)
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/__launcher/status').then(r=>r.json()).then(s=>process.exit(s.app_up||s.busy?0:1)).catch(()=>process.exit(1))"
# Without arguments: normal operation. With "--self-replace <job>": update helper (started by the launcher itself).
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/launcher/index.js"]
