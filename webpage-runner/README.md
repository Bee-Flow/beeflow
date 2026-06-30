# Webpage full-tier runtime (`webpage-runner`)

A per-project Node.js dev container: a real **Vite** dev server (+ optional Node
backend) per actively-edited "full" webpage project. Gives native npm, ES
modules, JSX/TSX and Material UI — the preview iframe points at the container
through a reverse proxy instead of inlining a `srcdoc`.

> **STATUS: GATED + INERT.** Nothing here runs in production until ops enables it
> (below) and a **security review signs off**. The application code
> (`server/services/webpageRuntimeManager.js`) is written and reviewable but is
> NOT wired into server startup or any request path. Tom owns the deploy.

It deliberately mirrors the existing throwaway-container services
(`server/pwt-runner`, `server/terminal-runner`, `services/pwtRunner.js`,
`services/scanRunner.js`) so operators reason about one container story.

## How it fits

- A project with `settings.runtime === 'full'` (set via the `webpage_set_runtime`
  AI tool or the UI) should be served by this runtime.
- `webpageRuntimeManager.ensureRuntime({ webpageId, userId, orgId })` hydrates the
  project files from RustFS into a bind-mounted work dir, starts a capped
  container on the isolated `beeflow-webpage-net` network, waits for the dev
  server, and returns `{ reachableHost }` for the proxy.
- Light tier (default) needs none of this — it uses the in-browser esbuild-wasm
  preview + the isolated-vm `api/*.js` backend.

## Build the image

Cloud (CI → registry):

```
docker build -t ghcr.io/bee-flow/webpage-runner:latest server/webpage-runner
docker push ghcr.io/bee-flow/webpage-runner:latest
```

Self-hosted / air-gapped (local tag the manager auto-detects):

```
docker build -t beeflow-webpage-runner:local server/webpage-runner
```

## Enable (ops — after security review)

1. Ensure the API process can reach the Docker socket (already true where
   `pwt-runner` / `scan-runner` work).
2. Set env on the API service:
   - `WEBPAGE_FULL_RUNTIME_ENABLED=1`
   - `WEBPAGE_RUNNER_IMAGE=ghcr.io/bee-flow/webpage-runner:latest` (or rely on the
     `beeflow-webpage-runner:local` build)
   - Optional caps: `WEBPAGE_RUNNER_MEMORY_MB` (512), `WEBPAGE_RUNNER_CPUS` (0.5),
     `WEBPAGE_RUNNER_PIDS` (256), `WEBPAGE_RUNNER_IDLE_TTL_MS` (15m),
     `WEBPAGE_RUNNER_MAX_PER_ORG` (5).
3. **Wire-up in `server/index.js` (the deploy-sensitive step, intentionally NOT
   done in code yet):**
   - `require('./services/webpageRuntimeManager').startReaper();` after boot.
   - A reverse proxy for the full tier: forward the preview iframe and
     `/api/webpages-preview/:id/app/*` (when the project is `runtime:'full'`) to
     `await webpageRuntimeManager.getReachableBase(id)`, authenticated with the
     existing HMAC preview token. Add a **WebSocket upgrade** handler so Vite HMR
     works (the Node server is SSE-only today — this is new).
   - Point `WebpagePreview` at the proxied URL when `runtime==='full'`
     (`composeWebpagePreview` already branches for a `previewUrl`).

## Security model (enforced) + review checklist

Enforced by `webpageRuntimeManager.js` / this image:

- [x] Isolated bridge network `beeflow-webpage-net` — never `beeflow-network`, so
      user code can't reach postgres / rustfs / redis / the API.
- [x] `Memory` / `NanoCpus` / `PidsLimit` / `ShmSize` caps.
- [x] `SecurityOpt: ['no-new-privileges']`, `CapDrop: ['ALL']`, non-root user.
- [x] Allowlisted env only (no `process.env` spread → no secret leak).
- [x] Idle reaper (scale-to-zero) + max-age + orphan sweep.
- [x] Per-org concurrency cap.
- [x] Files hydrated from RustFS; container disposable.

Must be decided/added during the security review (NOT yet implemented):

- [ ] **Egress policy.** The bridge network reaches the public internet for npm /
      esm.sh. Lock down with a network policy / egress proxy / private npm mirror
      (also fixes air-gapped installs). Decide an allowlist.
- [ ] **npm supply chain.** Arbitrary `npm install` runs untrusted install
      scripts inside the container. Consider `--ignore-scripts`, an install
      timeout/size cap, a vetted registry mirror, and `NPM_CONFIG_*` hardening.
- [ ] **Stronger isolation.** Evaluate a gVisor/Kata `runtimeClass` (or rootless
      docker) for the daemon, given untrusted code.
- [ ] **Proxy authn + DoS.** The reverse proxy must scope the HMAC token to the
      runtime, rate-limit, and cap request/body sizes.
- [ ] **File sync-back.** Hydration is one-way today (RustFS → container). Decide
      whether edits made in the container persist back, and how (the editor still
      writes via the existing extra-file APIs, so this may be unnecessary).
- [ ] **Bind-mount ownership.** Confirm uid mapping between host work dir and the
      container's `runner` user across the target orchestrator (K8s/Scaleway).
- [ ] **Published-app hosting.** Publishing a full-tier app to anonymous viewers
      is out of scope here — it needs its own always-on hosting design.
