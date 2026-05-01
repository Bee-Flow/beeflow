# Bee Flow Server
FROM node:20-slim

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

# Install dependencies with npm cache
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev --no-audit --no-fund --prefer-offline

# Install Playwright Chromium for document rendering (PDF generation)
RUN --mount=type=cache,target=/root/.cache/ms-playwright \
    npx playwright install-deps chromium && npx playwright install chromium

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
