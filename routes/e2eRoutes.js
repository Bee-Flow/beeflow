/**
 * E2E Testing Routes — Auto-starts & proxies the e2e-tests dashboard server
 * 
 * The dashboard server (TypeScript) is spawned as a child process automatically.
 * All routes are gated behind auth + 'e2e_testing' beta feature,
 * except screenshot/media routes which are public (scenario IDs are unguessable).
 */

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const { requireBetaFeature } = require('../core/betaFeatures');
const configStore = require('../stores/configStore');
const { getProviderForModel } = require('../core/aiAgent');

// ── Auth middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    console.log(`[E2E] Auth rejected: ${req.method} ${req.path} (no session)`);
    res.status(401).json({ error: 'Unauthorized' });
}

// Log all incoming requests to this router
router.use((req, _res, next) => {
    console.log(`[E2E Route] ${req.method} ${req.path}`);
    next();
});

// ── Dashboard server lifecycle ───────────────────────────────
const E2E_ROOT = path.resolve(__dirname, '../../e2e-tests');
const DASHBOARD_PORT = process.env.E2E_DASHBOARD_PORT || 4400;
const DASHBOARD_URL = process.env.E2E_DASHBOARD_URL || `http://localhost:${DASHBOARD_PORT}`;

let dashboardProcess = null;
let dashboardReady = false;
let startPromise = null;

async function startDashboardServer() {
    if (dashboardReady) return Promise.resolve();
    if (startPromise) return startPromise;

    startPromise = new Promise(async (resolve) => {
        console.log('[E2E] Starting dashboard server…');

        // Write BASE_URL and provider API keys into .env.test
        try {
            const envPath = path.join(E2E_ROOT, '.env.test');
            let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

            // Helper to upsert a key in the env file
            const upsertEnv = (key, value) => {
                const regex = new RegExp(`^${key}=.*$`, 'm');
                if (regex.test(envContent)) {
                    envContent = envContent.replace(regex, `${key}=${value}`);
                } else {
                    envContent += `\n${key}=${value}`;
                }
            };

            // Set BASE_URL from the server's public URL
            const protocol = process.env.CLIENT_PROTOCOL || 'https';
            const host = process.env.CLIENT_PUBLIC_HOST || 'dev.beeflow.ai';
            upsertEnv('BASE_URL', `${protocol}://${host}`);
            console.log(`[E2E] Wrote BASE_URL=${protocol}://${host} to .env.test`);

            // Inject provider API keys based on configured model tiers
            try {
                const tiersRaw = configStore.getConfig('chat_model_tiers');
                const tiers = typeof tiersRaw === 'string' ? JSON.parse(tiersRaw) : tiersRaw;
                const fastTier = tiers?.fast;
                if (fastTier?.modelId) {
                    const providerConfig = await getProviderForModel(fastTier.modelId);
                    const pType = (providerConfig.providerType || '').toLowerCase();
                    if (pType === 'anthropic' || fastTier.modelId.includes('claude')) {
                        upsertEnv('ANTHROPIC_API_KEY', providerConfig.apiKey);
                        upsertEnv('CLAUDE_MODEL', fastTier.modelId);
                    } else {
                        // For MiniMax / OpenAI-compatible providers
                        // Don't write BASE_URL — dashboard uses direct MiniMax API endpoint
                        upsertEnv('MINIMAX_API_KEY', providerConfig.apiKey);
                        upsertEnv('MINIMAX_MODEL', fastTier.modelId);
                        // Clear any stale proxy URL so dashboard uses its default
                        envContent = envContent.replace(/^MINIMAX_BASE_URL=.*\n?/m, '');
                    }
                    console.log(`[E2E] Injected ${pType} API key for model ${fastTier.modelId}`);
                }
            } catch (tierErr) {
                console.warn('[E2E] Could not resolve model tier:', tierErr.message);
            }

            fs.writeFileSync(envPath, envContent.trim() + '\n');
        } catch (envErr) {
            console.warn('[E2E] Failed to write .env.test:', envErr.message);
        }

        const tsEntry = path.join(E2E_ROOT, 'server', 'dashboard-server.ts');

        let started = false;
        dashboardProcess = spawn('npx', ['tsx', tsEntry], {
            cwd: E2E_ROOT,
            env: {
                ...process.env,
                DASHBOARD_PORT: String(DASHBOARD_PORT),
                NODE_ENV: 'development',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        dashboardProcess.stdout.on('data', (data) => {
            const text = data.toString().trim();
            if (text) console.log(`[E2E] ${text}`);
            if (!started && (text.includes('listening') || text.includes('http://'))) {
                started = true;
                dashboardReady = true;
                startPromise = null;
                resolve();
            }
        });

        dashboardProcess.stderr.on('data', (data) => {
            const text = data.toString().trim();
            if (text) console.error(`[E2E stderr] ${text}`);
        });

        dashboardProcess.on('exit', (code) => {
            console.log(`[E2E] Dashboard server exited (code ${code})`);
            dashboardReady = false;
            dashboardProcess = null;
            startPromise = null;
        });

        dashboardProcess.on('error', (err) => {
            console.error('[E2E] Failed to start dashboard server:', err.message);
            dashboardReady = false;
            dashboardProcess = null;
            startPromise = null;
            resolve(); // resolve anyway — proxy will return 502
        });

        // Timeout: if server doesn't signal ready in 15s, assume it's up
        setTimeout(() => {
            if (!started) {
                started = true;
                dashboardReady = true;
                startPromise = null;
                resolve();
            }
        }, 15_000);
    });

    return startPromise;
}

// Graceful shutdown
function stopDashboardServer() {
    if (dashboardProcess && !dashboardProcess.killed) {
        console.log('[E2E] Stopping dashboard server…');
        dashboardProcess.kill('SIGTERM');
        dashboardProcess = null;
        dashboardReady = false;
    }
}

process.on('SIGTERM', stopDashboardServer);
process.on('SIGINT', stopDashboardServer);
process.on('exit', stopDashboardServer);

// ── Proxy handler ────────────────────────────────────────────
async function proxyRequest(req, res) {
    // Auto-start dashboard server on first request
    if (!dashboardReady) {
        try { await startDashboardServer(); } catch (_) {}
    }

    if (!dashboardReady) {
        return res.status(502).json({
            error: 'E2E dashboard server failed to start. Check server logs for details.',
        });
    }

    try {
        const targetPath = '/api' + req.path;
        const url = new URL(targetPath, DASHBOARD_URL);

        for (const [key, val] of Object.entries(req.query)) {
            url.searchParams.set(key, String(val));
        }

        console.log(`[E2E Proxy] ${req.method} ${url.toString()}`);

        const fetchOptions = {
            method: req.method,
            headers: { 'Content-Type': 'application/json' },
        };

        if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
            const body = { ...req.body };

            // Resolve modelTier → provider for scenario/suite requests
            if (body.modelTier && (req.path.includes('/scenario') || req.path.includes('/suite'))) {
                try {
                    const tiers = await configStore.getConfig('chat_model_tiers') || {};
                    const tier = tiers[body.modelTier] || {};
                    if (tier.modelId) {
                        const providerConfig = await getProviderForModel(tier.modelId);
                        const pType = (providerConfig.providerType || '').toLowerCase();
                        if (pType === 'anthropic' || tier.modelId.includes('claude')) {
                            body.provider = 'claude';
                        } else {
                            body.provider = 'minimax';
                        }
                        console.log(`[E2E Proxy] Resolved tier "${body.modelTier}" → ${body.provider} (${tier.modelId})`);
                    }
                } catch (e) {
                    console.warn('[E2E Proxy] Tier resolution failed:', e.message);
                }
            }

            fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetch(url.toString(), fetchOptions);
        const contentType = response.headers.get('content-type') || '';

        console.log(`[E2E Proxy] → ${response.status} ${contentType}`);

        // SSE streams
        if (contentType.includes('text/event-stream')) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            req.on('close', () => { try { reader.cancel(); } catch (_) {} });

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) { res.end(); return; }
                    res.write(decoder.decode(value, { stream: true }));
                }
            } catch (_) {
                if (!res.writableEnded) res.end();
            }
            return;
        }

        // Binary (screenshots, images)
        if (contentType.includes('image/') || contentType.includes('application/octet-stream')) {
            const buffer = Buffer.from(await response.arrayBuffer());
            res.status(response.status);
            res.setHeader('Content-Type', contentType || 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            // Allow cross-origin loading (frontend on dev.beeflow.ai, API on server.dev.beeflow.ai)
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            res.send(buffer);
            return;
        }

        res.status(response.status);
        if (contentType) res.setHeader('Content-Type', contentType);

        // If the dashboard returned HTML instead of JSON, it means the route didn't match
        if (contentType.includes('text/html')) {
            console.warn(`[E2E Proxy] Dashboard returned HTML for ${req.method} ${targetPath} — route not found`);
            return res.status(502).json({
                error: 'E2E dashboard returned HTML instead of JSON. The dashboard server may not be fully initialized.',
            });
        }

        res.send(await response.text());
    } catch (err) {
        console.error('[E2E Proxy] Error:', err.message);
        if (!res.headersSent) {
            res.status(502).json({
                error: 'E2E dashboard not available. Check that e2e-tests dependencies are installed.',
                detail: err.message,
            });
        }
    }
}

// ── Public routes (no auth — scenario IDs are unguessable tokens) ─────
// Screenshots and accessibility trees must be loadable by <img> tags
// which can't send cross-origin cookies.
router.get('/scenario/:id/screenshots/:step', proxyRequest);
router.get('/scenario/:id/tree/:step', proxyRequest);
router.get('/user-manual/screenshots/:name', proxyRequest);

// ── Auth gate for all other routes ───────────────────────────
router.use(requireAuth);
router.use(requireBetaFeature('e2e_testing'));

// ── Authenticated routes ─────────────────────────────────────
// Config — intercept to handle YouTrack keys separately (dashboard rejects unknown keys)
const YOUTRACK_CONFIG_PATH = path.join(E2E_ROOT, 'youtrack-config.json');
const YOUTRACK_KEYS = ['YOUTRACK_URL', 'YOUTRACK_TOKEN'];

function readYouTrackConfig() {
    try { return JSON.parse(fs.readFileSync(YOUTRACK_CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

function writeYouTrackConfig(data) {
    fs.mkdirSync(path.dirname(YOUTRACK_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(YOUTRACK_CONFIG_PATH, JSON.stringify(data, null, 2));
}

// GET /config — proxy to dashboard then merge YouTrack keys
router.get('/config', async (req, res) => {
    // Get dashboard config via proxy
    if (!dashboardReady) { try { await startDashboardServer(); } catch (_) {} }
    if (!dashboardReady) return res.status(502).json({ error: 'Dashboard not available' });
    try {
        const url = new URL('/api/config', DASHBOARD_URL);
        const response = await fetch(url.toString(), { headers: { 'Content-Type': 'application/json' } });
        const data = await response.json();
        // Merge YouTrack config into the raw config
        const ytConfig = readYouTrackConfig();
        if (data.raw) Object.assign(data.raw, ytConfig);
        if (data.config) Object.assign(data.config, ytConfig);
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// POST /config — split YouTrack keys out, proxy rest to dashboard
router.post('/config', async (req, res) => {
    if (!dashboardReady) { try { await startDashboardServer(); } catch (_) {} }
    if (!dashboardReady) return res.status(502).json({ error: 'Dashboard not available' });
    try {
        // Split body into dashboard keys and YouTrack keys
        const body = { ...req.body };
        const ytConfig = readYouTrackConfig();
        for (const key of YOUTRACK_KEYS) {
            if (key in body) { ytConfig[key] = body[key]; delete body[key]; }
        }
        writeYouTrackConfig(ytConfig);

        // Forward remaining keys to dashboard
        const url = new URL('/api/config', DASHBOARD_URL);
        const response = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// App context
router.get('/app-context', proxyRequest);
router.post('/app-context', proxyRequest);
router.post('/app-context/generate', proxyRequest);

// Scenarios
router.post('/scenario', proxyRequest);
router.get('/scenario/:id/code', proxyRequest);

// Suite
router.post('/suite/generate', proxyRequest);
router.get('/suites', proxyRequest);
router.delete('/suites/:name', proxyRequest);

// Runner
router.post('/run', proxyRequest);
router.get('/run/:id/stream', proxyRequest);
router.post('/run/:id/cancel', proxyRequest);
router.get('/runs', proxyRequest);
router.get('/runs/:id', proxyRequest);

// User manual
router.get('/user-manual', proxyRequest);
router.post('/user-manual/generate', proxyRequest);

// YouTrack
router.get('/youtrack/projects', proxyRequest);
router.post('/youtrack/issues', proxyRequest);
router.get('/youtrack/issue/:id', proxyRequest);
router.post('/youtrack/generate-tests', proxyRequest);
router.get('/youtrack/plans', proxyRequest);
router.get('/youtrack/plan/:id', proxyRequest);
router.delete('/youtrack/plan/:id', proxyRequest);
router.get('/youtrack/runs', proxyRequest);
router.post('/youtrack/run-test', proxyRequest);
router.post('/youtrack/run-plan', proxyRequest);

module.exports = router;
module.exports.stopDashboardServer = stopDashboardServer;
