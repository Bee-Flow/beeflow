# Bee Flow Server
FROM node:22-slim

WORKDIR /app

# Install system dependencies (build-essential + python3 are required by
# isolated-vm's native addon used for the automation `code` step sandbox)
RUN apt-get update && apt-get install -y wget curl gnupg python3 build-essential && rm -rf /var/lib/apt/lists/*

# Install Docker CLI for terminal-agent container management (Docker-out-of-Docker pattern)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && . /etc/os-release \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# No Chromium is baked into this image. All browser work (PDF export, webpage
# thumbnails, SPA URL ingestion, Tests Studio) is driven REMOTELY against a
# long-lived, network-isolated browser container that the server launches via
# the mounted docker socket (see services/pwtRunner.js + services/browserProvider.js),
# or against an external Playwright server via BROWSER_WS_ENDPOINT. The
# `playwright` npm package stays as the thin client. Belt-and-braces: make sure
# `npm install` never pulls browser binaries either.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install dependencies with npm cache. `npm ci` (not `npm install`) is
# deterministic and never rewrites package-lock.json, so the install layer cache
# stays valid across rebuilds — the expensive isolated-vm native compile is only
# re-run when package*.json actually changes. Requires package-lock.json to be in
# sync with package.json (it is tracked); a drift makes the build fail loudly,
# which is the intended signal to commit an updated lockfile.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# Copy server source
COPY . .

# Create data directory for uploads and generated files
RUN mkdir -p /app/data

# Environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV SESSION_SECRET=change-me-in-production

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost:3001/api/health || exit 1

# Run the server using nodemon for live deploy auto-reloading
CMD ["npx", "nodemon", "--ignore", "data/", "--ignore", "components/", "--ignore", "node_modules/", "index.js"]
