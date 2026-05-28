# Throwaway Playwright runner image.
#
# Each Studio test run executes inside a short-lived container built from this
# image. The base ships Chromium + all OS deps baked in and matches the server's
# pinned Playwright version (1.58.2), so we never download browsers at runtime.
#
# Two sub-commands (see entrypoint.js):
#   suite  — run the bind-mounted spec via `playwright test`, write report.json
#   serve  — launch a Chromium server and print its wsEndpoint for the worker
#            to drive over the wire (explore / agent modes)
#
# IMPORTANT: this version MUST match the `playwright` version the server
# installs (server/package.json). Playwright's connect() handshake rejects a
# client/server minor-version mismatch (HTTP 428). Bump both together.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /runner

# Browsers are already baked into the base image — never re-download them.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Generated specs `import { test } from '@playwright/test'` while running with
# cwd=/runner; NODE_PATH lets that resolve from /runner/node_modules even though
# the spec file lives under the bind-mounted /work.
ENV NODE_PATH=/runner/node_modules

COPY package.json ./
RUN npm install --no-audit --no-fund --omit=dev

COPY entrypoint.js ./

ENTRYPOINT ["node", "/runner/entrypoint.js"]
