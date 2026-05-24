require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// Core modules
const componentManager = require('./core/componentManager');
const executionEngine = require('./core/executionEngine');

// Route modules
const { router: authRouter } = require('./auth');
const componentsRouter = require('./routes/components');
const aiRouter = require('./routes/ai');
const executeRouter = require('./routes/execute');
const { router: agentsRouter } = require('./routes/agents');
const memoryRouter = require('./routes/memory');
const reportsRouter = require('./routes/reports');
const appsRouter = require('./routes/apps');


const app = express();
// Trust proxy: how many reverse-proxy hops sit in front of us. Default `1`
// matches the standard nginx-in-front production deploy. Override via
// `TRUST_PROXY_HOPS` (positive integer) if you have multiple proxies (e.g.
// CDN → load balancer → app). Setting this to `true` works for IP detection
// but causes express-rate-limit to refuse to start with ERR_ERL_PERMISSIVE_TRUST_PROXY
// because anyone could spoof X-Forwarded-For; the numeric value pins down
// exactly how many forwarded IPs to peel off.
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '1', 10) || 1);
app.set('trust proxy', TRUST_PROXY_HOPS);
const PORT = process.env.SERVER_PORT || process.env.PORT || 3001;

// ── Security headers (helmet) ─────────────────────────────────────────────────
const helmet = require('helmet');
app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    contentSecurityPolicy: false,        // Handled by Nginx
    crossOriginEmbedderPolicy: false,    // Can break embedded content
    crossOriginResourcePolicy: { policy: 'same-site' },  // Allow cross-subdomain resource loading (server.dev → dev.beeflow.nl)
    permissionsPolicy: false,            // Managed manually below (clipboard needs self)
}));
// Allow clipboard access so users can paste screenshots in the conversation area.
// navigator.clipboard.read() requires this header — without it the browser blocks
// the API before even showing a permission prompt.
app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), clipboard-read=(self), clipboard-write=(self)');
    next();
});

// ── Error handlers ────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

// ── Directories ───────────────────────────────────────────────────────────────
const WORKFLOWS_DIR = path.resolve(__dirname, '../workflows');
if (!fs.existsSync(WORKFLOWS_DIR)) fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });

// ── Middleware ─────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || 'https://dev.beeflow.nl,https://server.dev.beeflow.nl,http://localhost:5173')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const globalCors = cors({
    origin: (origin, cb) => {
        // Same-origin / curl / server-to-server (no Origin header)
        if (!origin) return cb(null, true);

        const normalizedOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        const isAllowed = ALLOWED_ORIGINS.some(o => (o.endsWith('/') ? o.slice(0, -1) : o) === normalizedOrigin);
        if (isAllowed) return cb(null, true);

        // Fail-closed: previously this returned `cb(null, origin)` which
        // reflects ANY origin and — combined with credentials:true — let
        // arbitrary websites issue authenticated XHRs against this API.
        console.warn(`[CORS] Rejected origin: ${origin}. Allowed:`, ALLOWED_ORIGINS);
        return cb(new Error(`CORS: origin not allowed: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token']
});

// Sandboxed preview iframes have an opaque origin (`Origin: null`) and never
// carry cookies. Auth on /api/webpages-preview/* is HMAC bearer tokens scoped
// to (userId, webpageId), so the origin check buys nothing — we just need
// permissive CORS so the browser doesn't pre-flight-block the calls.
const previewCors = cors({
    origin: true,           // reflect whatever Origin the iframe sends, including 'null'
    credentials: false,     // never send cookies; the bearer token is the trust anchor
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
});

app.use((req, res, next) => {
    if (req.path.startsWith('/api/webpages-preview/')) return previewCors(req, res, next);
    return globalCors(req, res, next);
});

// Stripe webhook needs raw body for signature verification — must be BEFORE bodyParser.json
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(bodyParser.json({ limit: '20mb' }));

// ── Sessions ──────────────────────────────────────────────────────────────────────
const pgSession = require('connect-pg-simple')(session);
const { pool, getRedis, disconnectRedis } = require('./db');
const { wrapWithRedisCache } = require('./auth/sessionCache');

// Sessions: PostgreSQL is the durable source of truth (survives Redis restarts).
// Redis is wired as a read-through cache layer on top — cache hit avoids a DB
// round-trip for the session lookup that happens on every authenticated request.
let sessionStore;
let _sessionRedisClient = null; // kept for graceful shutdown

// Primary: PostgreSQL (persistent via beeflow-pgdata volume)
const pgStore = new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true, pruneSessionInterval: 900 });
console.log('[Sessions] Using PostgreSQL session store (persistent across deploys)');

// Phase 3: Redis session cache — read-through layer over pgStore.
// Falls back transparently to pgStore if Redis is unavailable.
if (process.env.REDIS_URL) {
    try {
        const { createClient } = require('redis');
        // Scaleway managed Redis uses an internal CA. Scope TLS validation
        // skip to this client only (encryption stays on).
        const _redisIsTls = process.env.REDIS_URL.startsWith('rediss://');
        _sessionRedisClient = createClient({
            url: process.env.REDIS_URL,
            ...(_redisIsTls ? {
                socket: { tls: true, rejectUnauthorized: process.env.REDIS_TLS_STRICT === '1' }
            } : {})
        });
        _sessionRedisClient.on('error', (err) => console.warn('[Sessions] Redis error:', err.message));
        _sessionRedisClient.connect().then(() => {
            console.log('[Sessions] Redis connected — activating session read-through cache');
            // Re-wrap the store now that Redis is confirmed ready.
            // express-session holds a reference to sessionStore.get/set/destroy
            // so we patch the prototype methods in-place via the wrapper.
            const cached = wrapWithRedisCache(pgStore, _sessionRedisClient);
            // Copy the wrapped methods onto the live store object
            sessionStore.get     = cached.get.bind(cached);
            sessionStore.set     = cached.set.bind(cached);
            sessionStore.touch   = cached.touch.bind(cached);
            sessionStore.destroy = cached.destroy.bind(cached);
        }).catch((err) => {
            console.warn('[Sessions] Redis connect failed, using PG-only sessions:', err.message);
        });
    } catch (err) {
        console.warn('[Sessions] Failed to create Redis client:', err.message);
    }
}
sessionStore = pgStore;

app.use(session({
    store: sessionStore,
    name: process.env.COOKIE_NAME || 'connect.sid',
    secret: (() => {
        const s = process.env.SESSION_SECRET;
        if (!s || s.length < 32) {
            throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters. See .env.example. Generate with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
        }
        return s;
    })(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.COOKIE_SECURE === 'false' ? false : (process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true'),
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: process.env.COOKIE_SAMESITE || 'lax',
        ...(process.env.COOKIE_DOMAIN && { domain: process.env.COOKIE_DOMAIN })
    }
}));

// Nextcloud Connector JWT auth — handles requests from the Bee Flow ExApp
// connector. Tagged with `X-Beeflow-Source: nextcloud-connector`. Populates
// req.session so downstream handlers see no difference from a cookie session.
app.use(require('./auth/connectorJwt'));

// ── Session-token bridge (popup→iframe handoff for embedded mode) ──
// Helpers live in utils/sessionToken so OAuth callback can mint pickup tokens.
const { getSessionToken, setSessionToken, generateToken } = require('./utils/sessionToken');

app.use(async (req, res, next) => {
    const sessionToken = req.headers['x-session-token'];
    if (sessionToken) {
        const data = await getSessionToken(sessionToken);
        if (data) {
            Object.assign(req.session, data);
            // Re-validate license on bridge transfer. Without this the iframe
            // would inherit whatever tier was cached when the parent session
            // was created — possibly stale after a revocation/upgrade. The
            // resolution is memoised on req.session for 30s anyway.
            try {
                const { resolveBestTierForRequest } = require('./license/middleware');
                const resolution = await resolveBestTierForRequest(req);
                req.session._bridgeTier = resolution.tier;
            } catch (_e) { /* non-fatal */ }
        }
    }
    next();
});

app.get('/api/session-token', async (req, res) => {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });

    const userStore = require('./stores/userStore');
    const token = generateToken();
    const userId = req.session.user.id;
    const appPasswordData = await userStore.getAppPassword(userId);

    await setSessionToken(token, {
        user: req.session.user,
        accessToken: req.session.accessToken,
        refreshToken: req.session.refreshToken,
        oauthProvider: req.session.oauthProvider,
        nextcloudUid: req.session.nextcloudUid,
        appPassword: appPasswordData,
        isAuthenticated: req.session.isAuthenticated || false,
        isAdmin: req.session.isAdmin || false,
    });
    res.json({ token });
});

// ── Init components ───────────────────────────────────────────────────────────
componentManager.initialize()
    .then(() => console.log('Component Manager Initialized'))
    .catch(err => console.error('Failed to initialize components:', err));

// ── API info & health ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        appVersion: process.env.APP_BUILD_SHA || '',
    });
});

app.get('/api', (req, res) => {
    res.json({ name: 'Bee Flow API', status: 'ok' });
});

// ── Static files ──────────────────────────────────────────────────────────────
const agentHubDistPath = path.resolve(__dirname, '../agent-hub/dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(agentHubDistPath)) {
    // Hashed Vite assets get long-lived immutable cache; everything else (index.html) gets no-cache
    app.use('/assets', express.static(path.join(agentHubDistPath, 'assets'), {
        maxAge: '1y',
        immutable: true,
    }));
    app.use(express.static(agentHubDistPath, {
        maxAge: 0,
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('.html')) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
            }
        },
    }));
    console.log('[Production] Serving static files from agent-hub:', agentHubDistPath);
}
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// ── RustFS Storage Init ───────────────────────────────────────────────────────
const storageStore = require('./stores/storageStore');
storageStore.init().then(ok => {
    if (ok) console.log('[Server] RustFS storage initialized');
    else console.warn('[Server] RustFS unavailable — using local disk fallback');
}).catch(err => console.warn('[Server] RustFS init error:', err.message));


// ── Mount routes ──────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
// Component Designer is enterprise-tier — same `requireFeature` middleware
// the other gated routers use at L353+; inlined here because the
// destructure that exposes it as `requireLicenseFeature` lives further
// down (same pattern as /api/compliance on L304).
app.use('/components', (req, res, next) => require('./license/middleware').requireFeature('component_designer')(req, res, next), componentsRouter);
app.use('/ai', aiRouter);
app.use('/workflow-ai', (req, res) => res.status(404).json({ error: 'Workflow AI removed' }));
app.use('/', executeRouter);
app.use('/agents/memory', memoryRouter);   // Must be before /agents
app.use('/api/agent-presets', require('./routes/agentPresets'));
app.use('/agents', agentsRouter);
app.use('/reports', reportsRouter);
app.use('/apps', appsRouter);

app.use('/versions', require('./routes/versions'));
// The non-Overview Usage & Monitoring tabs (Safety / Integrations / Azure
// services) sit on `/api/usage/{guardrails,integrations,azure-services}/*`
// and require `advanced_usage_monitoring` (enterprise+). The Overview tab
// hits other paths (/summary, /timeline, /users, etc.) which stay free.
// We inject a path-aware gate that runs only for the gated sub-prefixes
// — the same /api/usage router serves both. `requireFeature` is
// destructured further down (L340), so we lazy-require it here.
const _ADV_USAGE_PREFIXES = ['/guardrails', '/integrations', '/azure-services'];
const _advUsagePrefixGate = (req, res, next) => {
    const path = req.path || '';
    const hit = _ADV_USAGE_PREFIXES.some(p => path === p || path.startsWith(p + '/'));
    if (!hit) return next();
    return require('./license/middleware').requireFeature('advanced_usage_monitoring')(req, res, next);
};
app.use('/api/usage', _advUsagePrefixGate, require('./routes/usage'));
// /api/terminations and /api/feedback back the Terminations + Feedback
// usage tabs — same advanced-monitoring gate, applied at the mount.
const _advUsageGate = (req, res, next) => require('./license/middleware').requireFeature('advanced_usage_monitoring')(req, res, next);
app.use('/api/terminations', _advUsageGate, require('./routes/terminations'));
app.use('/api/feedback', _advUsageGate, require('./routes/feedback'));
app.use('/api/client-errors', require('./routes/clientErrors'));
app.use('/api/web-vitals', require('./routes/webVitals'));
app.use('/api/csp-report', require('./routes/cspReport'));
app.use('/api/org-privacy-shield', require('./routes/orgPrivacyShield'));
app.use('/api/org-azure-config', require('./routes/orgAzureConfig'));
app.use('/api/house-styles', require('./routes/houseStyles'));
// Compliance Hub — Enterprise-tier feature.
app.use('/api/compliance', (req, res, next) => require('./license/middleware').requireFeature('compliance_hub_gdpr')(req, res, next), require('./routes/compliance'));
// DSR — public submission must remain reachable (GDPR Art. 12). Admin endpoints
// inside the router enforce admin_compliance permission; the router is mounted
// without the license gate so unauthenticated subjects can submit requests.
app.use('/api/dsr', require('./routes/dsr'));
app.use('/api/chat/dlp-decision', require('./routes/dlpDecision'));
app.use('/api/cms', require('./routes/cms'));
// Nextcloud webhook + admin sync — mounted under /auth so they share the
// auth router's session middleware (admin endpoints require requireAuth).
// The webhook itself uses HMAC over the body, so it sits BEFORE auth gates.
app.use('/auth', require('./routes/webhooks/ncEvents'));
app.use('/auth', require('./routes/admin/ncSync'));
app.use('/auth', require('./routes/admin/ncIntegrations'));
app.get('/api/guard/health', async (req, res) => {
    // PII Guard service health probe. The guard is the only PII detector;
    // when it's not installed this returns `not-configured` and the chat
    // path fails open (PII detection is OFF). Endpoint resolution prefers
    // configStore (admin install action), then env.
    const { getGuardEndpoint } = require('./core/piiDetection');
    const { probeGuardHealth } = require('./services/guardInstaller');
    const endpoint = await getGuardEndpoint();
    if (!endpoint.url) return res.json({ status: 'not-configured' });
    const health = await probeGuardHealth(endpoint.url, endpoint.apiKey);
    if (health) return res.json(health);
    res.json({ status: 'unavailable' });
});
app.use('/api/admin/guard', require('./routes/guardInstall'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/license', require('./routes/license'));
app.use('/api/admin/licenses', require('./routes/adminLicense'));
const { requireFeature: requireLicenseFeature, requireTier: requireLicenseTier } = require('./license/middleware');
app.use('/api/documents', require('./routes/documents'));
app.use('/api/notifications', require('./routes/notifications'));
// Project feature gate middleware
const projectFeatureGate = async (req, res, next) => {
    try {
        const configStore = require('./stores/configStore');
        const enabled = await configStore.getConfig('feature_projects_enabled');
        if (enabled === false) {
            return res.status(403).json({ error: 'Projects feature is disabled' });
        }
    } catch (_) { /* allow on error — fail open */ }
    next();
};
// Licence gate fires BEFORE the configStore feature gate so a community
// user sees the actionable `feature_locked` upgrade body rather than the
// less informative "Projects feature is disabled" string. The configStore
// gate remains as an operator override for enterprise installs that want
// to disable Projects per deployment.
app.use('/api/projects', requireLicenseFeature('projects'), projectFeatureGate, require('./routes/projects'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/ai-tasks', require('./routes/aiTasks'));
app.use('/api/automation/builder', requireLicenseFeature('automations'), require('./routes/ai/automationBuilder'));
app.use('/api/automation', requireLicenseFeature('automations'), require('./routes/automation'));
app.use('/api/integrations/gdrive', require('./routes/integrations/googleDrive'));
app.use('/api/integrations/gmail', require('./routes/integrations/gmail'));
app.use('/api/integrations/calendar', require('./routes/integrations/calendar'));
app.use('/api/integrations/contacts', require('./routes/integrations/contacts'));
app.use('/api/integrations/keep', require('./routes/integrations/keep'));
app.use('/api/storage', require('./routes/storageProxy'));
app.use('/api/integrations/linkedin', require('./routes/integrations/linkedin'));
app.use('/api/integrations/github', require('./routes/integrations/github'));
app.use('/api/integrations/github-sync', require('./routes/integrations/githubSync'));
app.use('/api/integrations/gamma', require('./routes/integrations/gamma'));
app.use('/api/integrations/outlook', require('./routes/integrations/outlook'));
app.use('/api/integrations/onedrive', require('./routes/integrations/oneDrive'));
app.use('/api/templates', require('./routes/templates'));
// Notebook feature gate middleware
const notebookFeatureGate = async (req, res, next) => {
    try {
        const configStore = require('./stores/configStore');
        const enabled = await configStore.getConfig('feature_notebooks_enabled');
        if (enabled === false) {
            return res.status(403).json({ error: 'Notebooks feature is disabled' });
        }
    } catch (_) { /* allow on error — fail open */ }
    next();
};
// Licence gate fires before notebookFeatureGate so the frontend gets the
// actionable `feature_locked` body it already knows how to render; the
// configStore.feature_notebooks_enabled flag remains as an operator
// kill-switch for enterprise installs that want to disable the feature
// per deployment.
app.use('/api/notebooks', requireLicenseFeature('notebooks'), notebookFeatureGate, require('./routes/notebooks'));
app.use('/api/notebooks', requireLicenseFeature('notebooks'), notebookFeatureGate, require('./routes/notebookExport'));
// Webpages — gated per-organization via the beta-feature registry.
const { requireBetaFeature: requireWebpagesBeta } = require('./core/betaFeatures');
app.use('/api/webpages', requireLicenseFeature('webpages'), requireWebpagesBeta('webpages'), require('./routes/webpages'));
app.use('/api/webpages', requireLicenseFeature('webpages'), requireWebpagesBeta('webpages'), require('./routes/webpageExport'));
// Cross-origin endpoints called from the sandboxed preview iframe — guarded
// by HMAC bearer tokens (issued by the session-authenticated route above),
// not by the session itself, since the iframe has no cookies.
app.use('/api/webpages-preview', require('./routes/webpagesPreview'));
// Public webpage viewer — unauthenticated `/share/:token` route for external
// recipients of a published webpage. Has its own rate limiter, strict CSP,
// HMAC-signed magic links and unlock cookies. License/beta gates do NOT
// apply: once a publisher (whose org is gated) creates a share, recipients
// are anonymous third parties.
app.use('/share', require('./routes/publicViewer'));
// Meeting Notes beta feature gate
const { requireBetaFeature } = require('./core/betaFeatures');
app.use('/api/transcriptions', requireLicenseFeature('meeting_notes'), requireBetaFeature('meeting_notes'), require('./routes/transcriptions'));
app.use('/api/skills', requireLicenseFeature('skills'), requireBetaFeature('skills'), require('./routes/skills'));
// ITIL Ticket Assistant (formerly Email Knowledge Base). Both mount paths point
// to the same router while the `email_knowledge_base` beta-flag alias is live;
// remove the `/api/email-kb` alias and the alias entry in betaFeatures.js in
// the release after this one lands.
const ticketAssistantRouter = require('./routes/ticketAssistant');
app.use('/api/ticket-assistant', requireLicenseFeature('ticket_assistant'), requireBetaFeature('itil_ticket_assistant'), ticketAssistantRouter);
app.use('/api/email-kb',        requireLicenseFeature('ticket_assistant'), requireBetaFeature('itil_ticket_assistant'), ticketAssistantRouter);

// Customer Support — Bee Flow's own AI-first support inbox. Mounted publicly
// (no license/beta gate) because the POST /threads endpoint accepts anonymous
// submissions from the marketing site; staff-only endpoints enforce
// admin_support inside the router.
app.use('/api/support', require('./routes/support'));

// Tests Studio — Playwright generation + runs. Beta-gated + enterprise feature.
app.use('/api/tests', requireLicenseFeature('playwright_tests'), requireBetaFeature('playwright_tests'), require('./routes/tests'));

app.use('/', require('./routes/knowledge'));
app.use('/api/kb', require('./routes/knowledgeBases'));
app.use('/api/search', require('./routes/search'));
app.use('/api/languages', require('./routes/admin/languageRoutes'));
app.use('/api/icons', require('./routes/icons'));
app.use('/api/branding', require('./routes/branding'));

// ── SPA fallback (production) ─────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
    const indexPath = path.join(agentHubDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        app.use((req, res) => {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.sendFile(indexPath);
        });
    }
}

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);

    // Run first-boot setup from INIT_* env vars (set by install wizard)
    const { runBootInit } = require('./boot-init');
    runBootInit().catch(err => console.error('[boot-init] Fatal:', err));

    // Connector bootstrap sanity probe — verifies the tables the
    // /auth/connector/bootstrap endpoint relies on actually exist after the
    // store modules' implicit migrations. Runs after a short delay so the
    // store init has time to finish CREATE TABLE statements. If a critical
    // table is missing we log fatal and exit non-zero so Kubernetes treats
    // the rollout as failed and we see it in `kubectl rollout status`
    // instead of catching cryptic 500s at the first customer install.
    setTimeout(() => {
        const userStore = require('./stores/userStore');
        userStore.getOrganizationByNcInstanceId('__sanity_probe__')
            .then(() => console.log('[Server] Connector bootstrap tables: OK'))
            .catch(err => {
                console.error(`[Server] FATAL: Connector bootstrap sanity probe failed: ${err.message}`);
                console.error('[Server] The /auth/connector/bootstrap endpoint will return 500s. Exiting so Kubernetes restarts.');
                process.exit(1);
            });
    }, 8000).unref();

    // Dutch Legal Sources — auto-seed the system KB if it's empty. The
    // service itself is idempotent (content_hash skip) and runs in the
    // background via setImmediate, so this never blocks boot. Admins can
    // re-trigger from the System Knowledge Bases admin panel.
    try {
        const dutchLawIngest = require('./services/dutchLawIngest');
        dutchLawIngest.seedIfMissing();
        // Weekly refresh — re-fetch each BWB statute so amended legislation
        // propagates to existing customers without an admin clicking
        // "Refresh". Idempotent (content_hash dedup), runs in background.
        // Configurable via SYSTEM_KB_REFRESH_INTERVAL_MS (default 7 days).
        const SYSTEM_KB_REFRESH_INTERVAL_MS = parseInt(process.env.SYSTEM_KB_REFRESH_INTERVAL_MS || String(7 * 24 * 60 * 60 * 1000), 10);
        const runSystemKBRefresh = () => {
            try {
                dutchLawIngest.refresh({ force: false });
                console.log('[dutchLawIngest] Weekly refresh kicked off');
            } catch (e) {
                console.warn('[dutchLawIngest] Weekly refresh start failed:', e.message);
            }
        };
        // First refresh fires 30 min after boot so the boot seed has time
        // to settle, then repeats on the configured interval.
        setTimeout(runSystemKBRefresh, 30 * 60 * 1000).unref();
        setInterval(runSystemKBRefresh, SYSTEM_KB_REFRESH_INTERVAL_MS).unref();
    } catch (e) {
        console.warn('[dutchLawIngest] Boot auto-seed could not start:', e.message);
    }

    // CPU cross-encoder + CPU embedder — pre-load the Transformers.js
    // pipelines so the first user KB search / web rerank doesn't pay the
    // ~280 MB cold-start cost. Both warmup()s are non-blocking and
    // fail-open; if the model load fails the pipelines stay disabled and
    // search falls back to RRF / cosine.
    try {
        const { warmup: warmRerank } = require('./core/rerank/cpuCrossEncoder');
        const { warmup: warmEmbed } = require('./core/embed/cpuEmbed');
        setImmediate(() => { warmRerank().catch(() => {}); });
        setImmediate(() => { warmEmbed().catch(() => {}); });
    } catch (e) {
        console.warn('[CpuPipelines] Warmup could not start:', e.message);
    }

    // PII Guard model migration hint — non-blocking. If the configStore still
    // records the older `urchade/gliner_multi_pii-v1` model, nudge the admin
    // to reinstall the guard via the dashboard to pick up the newer Dutch +
    // healthcare/finance fine-tune (E3-JSI/gliner-multi-pii-domains-v1).
    setImmediate(async () => {
        try {
            const configStore = require('./stores/configStore');
            const installedModel = await configStore.getConfig('pii_guard_model');
            if (installedModel === 'urchade/gliner_multi_pii-v1') {
                console.warn('[PiiGuard] Old model in config (urchade/gliner_multi_pii-v1). Reinstall the guard service from Admin → Guardrails for improved Dutch + medical recall (E3-JSI/gliner-multi-pii-domains-v1).');
            }
        } catch (_) { /* fail-quiet */ }
    });

    // License refresh scheduler — periodic ping to license.beeflow.nl for
    // monthly licenses. Yearly/lifetime licenses are validated by JWT exp
    // and skip this loop. Disable with LICENSE_REFRESH_DISABLED=true.
    try { require('./license/refresh').start(); } catch (e) {
        console.warn('[License Refresh] Failed to start scheduler:', e.message);
    }

    // Stripe configuration sanity check. If Stripe is enabled but the webhook
    // signing secret is missing, every incoming webhook will be rejected with
    // 400 — that's silent in production unless the admin actively watches
    // webhook delivery logs. Surface it loudly at boot.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        (async () => {
            try {
                const stripeService = require('./services/stripeService');
                const configStore = require('./stores/configStore');
                if (await stripeService.isEnabled()) {
                    const secret = await configStore.getSecret('stripe_webhook_secret');
                    if (!secret) {
                        console.error('[Stripe] WARNING: Stripe is enabled but stripe_webhook_secret is not configured — all incoming webhooks will be rejected with 400. Configure the signing secret in the Stripe admin UI.');
                    }
                }
            } catch (e) {
                console.warn('[Stripe] Startup config check failed:', e.message);
            }
        })();
    }

    // Trial-history backfill — idempotent one-shot that copies existing
    // organizations.trial_used_at / users.trial_used_at into the durable
    // trial_history table. After this runs once, the unique index makes
    // subsequent boots a no-op. Non-blocking so a slow query never holds
    // up boot.
    setImmediate(() => {
        require('./stores/userStore').backfillTrialHistory().catch(e =>
            console.warn('[Server] trial_history backfill error:', e.message));
    });

    // Dunning + trial-expiry schedulers. The dunning tick scans for orgs
    // that have been past_due longer than STRIPE_DUNNING_GRACE_DAYS and
    // flips them to suspended. The trial tick suspends trials whose
    // trial_end_date is in the past and that don't have payment_status='paid'.
    // Both are idempotent and re-run safely.
    try {
        const userStore = require('./stores/userStore');
        const DUNNING_INTERVAL_MS = parseInt(process.env.STRIPE_DUNNING_TICK_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
        const DUNNING_GRACE_DAYS = parseInt(process.env.STRIPE_DUNNING_GRACE_DAYS || '7', 10);
        const TRIAL_TICK_INTERVAL_MS = parseInt(process.env.TRIAL_EXPIRY_TICK_INTERVAL_MS || String(30 * 60 * 1000), 10);
        const runDunningTick = async () => {
            try {
                const r = await userStore.suspendPastDueSubscriptions(DUNNING_GRACE_DAYS);
                if (r.orgs || r.consumers) {
                    console.log(`[Dunning] suspended orgs=${r.orgs} consumers=${r.consumers} grace_days=${DUNNING_GRACE_DAYS}`);
                }
            } catch (e) { console.error('[Dunning] tick error:', e.message); }
        };
        const runTrialExpiryTick = async () => {
            try {
                const r = await userStore.expireOverdueTrials();
                if (r.orgs || r.consumers) {
                    console.log(`[TrialExpiry] suspended orgs=${r.orgs} consumers=${r.consumers}`);
                }
                // Also sweep `incomplete` subscriptions older than 14 days so
                // a missed Stripe `incomplete_expired` webhook doesn't leave
                // them stuck. Stripe's own grace window is 14 days.
                const stale = await userStore.cancelStaleIncompleteSubscriptions(14);
                if (stale.orgs || stale.consumers) {
                    console.log(`[IncompleteCleanup] cancelled orgs=${stale.orgs} consumers=${stale.consumers}`);
                }
            } catch (e) { console.error('[TrialExpiry] tick error:', e.message); }
        };
        setTimeout(runDunningTick, 60_000).unref();
        setInterval(runDunningTick, DUNNING_INTERVAL_MS).unref();
        setTimeout(runTrialExpiryTick, 45_000).unref();
        setInterval(runTrialExpiryTick, TRIAL_TICK_INTERVAL_MS).unref();
        console.log(`[Server] Dunning+TrialExpiry schedulers started (dunning=${DUNNING_INTERVAL_MS}ms grace=${DUNNING_GRACE_DAYS}d, trial=${TRIAL_TICK_INTERVAL_MS}ms)`);
    } catch (e) {
        console.warn('[Server] Failed to start dunning/trial schedulers:', e.message);
    }

    // Plan-cap drift audit. When a plan's `allowed_*` is narrowed *after*
    // orgs have opted in, the runtime keeps serving the feature because
    // `applyCap` only runs at toggle time. This daily sweep emits an
    // audit row for every drifting (org, feature) pair so compliance has
    // a record. Read-only by default; flip PLAN_CAP_AUTO_TRIM=true to
    // also re-intersect and persist the trimmed list.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const PLAN_CAP_DRIFT_INTERVAL_MS = parseInt(process.env.PLAN_CAP_DRIFT_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);
            const PLAN_CAP_AUTO_TRIM = process.env.PLAN_CAP_AUTO_TRIM === 'true';
            const runPlanCapDrift = async ({ isBoot = false } = {}) => {
                try {
                    const r = await require('./services/planEntitlements').auditPlanCapDrift({ trim: PLAN_CAP_AUTO_TRIM });
                    if (r.drifted > 0) {
                        console.log(`[PlanCapDrift] scanned=${r.scanned} drifted=${r.drifted} trimmed=${r.trimmed} auto_trim=${PLAN_CAP_AUTO_TRIM}${isBoot ? ' boot=1' : ''}`);
                        if (isBoot) {
                            // Surface a single audit marker so post-deploy drift
                            // is visible in compliance reports without grepping
                            // logs.
                            try {
                                const userStore = require('./stores/userStore');
                                await userStore.logAccessAudit(
                                    'plan_cap_drift_detected_at_boot',
                                    'system',
                                    'plan_cap_drift',
                                    'system',
                                    null,
                                    { scanned: r.scanned, drifted: r.drifted, trimmed: r.trimmed },
                                    null,
                                );
                            } catch (_) { /* audit best-effort */ }
                        }
                    }
                } catch (e) { console.error('[PlanCapDrift] tick error:', e.message); }
            };
            // Run once synchronously at boot so a deploy with a freshly
            // narrowed plan surfaces drift immediately rather than waiting
            // for the first scheduled tick. Awaited inside an IIFE so we
            // don't block module init.
            (async () => { try { await runPlanCapDrift({ isBoot: true }); } catch (_) {} })();
            setInterval(() => runPlanCapDrift({ isBoot: false }), PLAN_CAP_DRIFT_INTERVAL_MS).unref();
            console.log(`[Server] Plan-cap drift audit scheduled (interval=${PLAN_CAP_DRIFT_INTERVAL_MS}ms auto_trim=${PLAN_CAP_AUTO_TRIM})`);
        } catch (e) {
            console.warn('[Server] Failed to start plan-cap drift audit:', e.message);
        }
    }

    // Stripe per-seat quantity drift sync. The customer.subscription.updated
    // webhook normally echoes seat counts, but if an org adds/removes users
    // without a Stripe event firing (NC group sync, admin DELETE),
    // stripe_seat_quantity can drift below the local active-user count and
    // the next invoice underbills. The sweep walks every per-seat org and
    // pushes the current count to Stripe; idempotent (no-op when Stripe
    // already matches local).
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const SEAT_SYNC_INTERVAL_MS = parseInt(process.env.STRIPE_SEAT_SYNC_INTERVAL_MS || String(15 * 60 * 1000), 10);
            const runSeatSync = async () => {
                try {
                    const us = require('./stores/userStore');
                    const { syncSeatQuantityForOrg } = require('./services/stripeService');
                    const subs = await us.getAllOrgSubscriptions();
                    let synced = 0;
                    for (const sub of (subs || [])) {
                        if (!sub.organization_id || sub.status !== 'active') continue;
                        if (!sub.stripe_subscription_id) continue;
                        try {
                            await syncSeatQuantityForOrg(sub.organization_id);
                            synced++;
                        } catch (e) {
                            console.warn(`[SeatSync] org=${sub.organization_id} failed: ${e.message}`);
                        }
                    }
                    if (synced > 0) console.log(`[SeatSync] checked ${synced} active per-seat orgs`);
                } catch (e) { console.error('[SeatSync] tick error:', e.message); }
            };
            setTimeout(runSeatSync, 90_000).unref();
            setInterval(runSeatSync, SEAT_SYNC_INTERVAL_MS).unref();
            console.log(`[Server] Stripe seat-sync scheduler started (interval=${SEAT_SYNC_INTERVAL_MS}ms)`);
        } catch (e) {
            console.warn('[Server] Failed to start seat-sync scheduler:', e.message);
        }
    }

    // PAYG meter event drain — durable Stripe meter event delivery. The
    // hot path (usageStore.logUsage) enqueues into payg_meter_outbox; this
    // tick drains pending rows with backoff. Self-hosted installs have no
    // PAYG plan so the drain is a cheap empty scan there.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'self-hosted') {
        try {
            const PAYG_DRAIN_INTERVAL_MS = parseInt(process.env.PAYG_DRAIN_TICK_INTERVAL_MS || '30000', 10);
            const runPaygDrain = async () => {
                try {
                    const r = await require('./workers/paygDrain').drainOnce();
                    if (r.delivered || r.failed || r.hardFailed) {
                        console.log(`[PaygDrain] delivered=${r.delivered} failed=${r.failed} hard_failed=${r.hardFailed}`);
                    }
                } catch (e) { console.error('[PaygDrain] tick error:', e.message); }
            };
            setTimeout(runPaygDrain, 30_000).unref();
            setInterval(runPaygDrain, PAYG_DRAIN_INTERVAL_MS).unref();
            console.log(`[Server] PAYG meter drain scheduler started (interval=${PAYG_DRAIN_INTERVAL_MS}ms)`);
        } catch (e) {
            console.warn('[Server] Failed to start PAYG drain scheduler:', e.message);
        }
    }

    // Playwright test-run drain — claims test_run_jobs outbox rows and spawns
    // Playwright. Same outbox + backoff pattern as PAYG drain. Self-hosted
    // installs run it too — Playwright is local; nothing depends on cloud.
    try {
        const TEST_RUN_DRAIN_INTERVAL_MS = parseInt(process.env.PLAYWRIGHT_DRAIN_TICK_INTERVAL_MS || '15000', 10);
        const runTestDrain = async () => {
            try {
                const r = await require('./workers/testRunner').drainOnce();
                if (r?.processed) console.log(`[TestRunner] processed=${r.processed}`);
            } catch (e) { console.error('[TestRunner] tick error:', e.message); }
        };
        setTimeout(runTestDrain, 20_000).unref();
        setInterval(runTestDrain, TEST_RUN_DRAIN_INTERVAL_MS).unref();
        console.log(`[Server] Playwright test-run drain scheduler started (interval=${TEST_RUN_DRAIN_INTERVAL_MS}ms)`);
    } catch (e) {
        console.warn('[Server] Failed to start test-run drain scheduler:', e.message);
    }

    // Non-invasive self-check of every org Privacy Shield blob. Logs warnings
    // for legacy shapes, orphaned regex collections, and invalid custom terms
    // so operators can spot guardrail drift in the startup log.
    const { selfCheckOrgShields } = require('./core/orgShield');
    selfCheckOrgShields().catch(err => console.warn('[OrgShieldSelfCheck] Error:', err.message));

    // The previous in-process PII pre-warm has been removed — PII detection
    // now runs only through the optional PII Guard service container, which
    // owns its own model loading lifecycle.

    // Pre-warm the in-process Whisper-base CPU transcription model. Same
    // fail-open semantics; first upload doesn't pay the download tax.
    if (process.env.LOCAL_WHISPER_PREWARM !== 'false') {
        const { warmLocalWhisper } = require('./core/voice/localWhisper');
        warmLocalWhisper();
    }

    // Register and schedule AI Act + GDPR compliance checks (6-hour interval,
    // multi-tenant). Also start the Art-5(1)(e) memory retention enforcer.
    require('./compliance/checks');
    require('./compliance/scheduler').start();
    require('./jobs/memoryRetentionEnforcer').start();

    // Seed system agents into the database (explicit lifecycle call, not a require() side-effect)
    const { seedSystemAgents, SYSTEM_AGENT_IDS } = require('./stores/agent/systemAgents');
    seedSystemAgents()
        .then(async () => {
            console.log('[Server] System agents seeded');
            // Point the support AI responder at the seeded Bee Flow Support
            // singleton — keeps the existing `configStore.support_ai_agent_id`
            // contract working without admins having to paste a UUID.
            try {
                const configStore = require('./stores/configStore');
                const current = await configStore.getConfig('support_ai_agent_id');
                if (current !== SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT) {
                    await configStore.setConfig('support_ai_agent_id', SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT);
                    console.log('[Server] support_ai_agent_id pointed at Bee Flow Support singleton');
                }
            } catch (e) {
                console.warn('[Server] Could not sync support_ai_agent_id:', e.message);
            }
            // Sanity check — if the seed failed silently or someone DELETE'd
            // the row, every support thread will escalate. Surface this as a
            // warning so operators see it without having to inspect the DB.
            try {
                const agentStore = require('./stores/agentStore');
                const configStore = require('./stores/configStore');
                const { pool } = require('./db');
                const agent = await agentStore.getAgent(SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT);
                if (!agent) {
                    console.warn('[Support] WARN: Bee Flow Support agent missing after seed; AI auto-responder will escalate every thread until reseeded.');
                } else if (agent.model && agent.model.startsWith('tier:')) {
                    // Self-healing: if the configured tier has no modelId in this
                    // environment, every support thread would escalate with an
                    // unhelpful "model not found" error. Auto-fallback to a tier
                    // that IS configured. Picks the first tier with a non-empty
                    // modelId in the order: fast → standard → thinking → writer → pro.
                    const tierName = agent.model.slice(5);
                    const tiers = (await configStore.getConfig('chat_model_tiers')) || {};
                    const configured = (t) => tiers[t]?.modelId && String(tiers[t].modelId).trim().length > 0;
                    if (tierName !== 'auto' && !configured(tierName)) {
                        const fallback = ['fast', 'standard', 'thinking', 'writer', 'pro'].find(configured);
                        if (fallback) {
                            await pool.query(
                                `UPDATE agents SET model = $1, updated_at = now() WHERE id = $2`,
                                [`tier:${fallback}`, SYSTEM_AGENT_IDS.BEE_FLOW_SUPPORT]
                            );
                            console.warn(`[Support] Re-pointed Bee Flow Support from tier:${tierName} (no modelId configured) to tier:${fallback}.`);
                        } else {
                            console.warn(`[Support] WARN: tier:${tierName} has no modelId AND no other tier is configured. Configure at least one tier in Admin → AI Config → Model tiers, then update the support agent.`);
                        }
                    }
                }
            } catch (e) {
                console.warn('[Support] WARN: Bee Flow Support agent check failed:', e.message);
            }
        })
        .catch(err => console.error('[Server] System agents seed failed:', err.message));
    // Initialize MCP server connections (non-blocking)
    try {
        const mcpManager = require('./core/mcpManager');
        mcpManager.initialize().catch(err =>
            console.warn('[Server] MCP manager init error:', err.message)
        );
    } catch (err) {
        console.warn('[Server] MCP manager load failed:', err.message);
    }
    // Initialize AI Task background runner (non-blocking)
    try {
        require('./core/aiTaskRunner');
    } catch (err) {
        console.warn('[Server] AI Task runner load failed:', err.message);
    }
    // Initialize Automation Runner — gated per-org by the 'automations' beta feature
    try {
        const automationRunner = require('./core/automationRunner');
        automationRunner.start().catch(err =>
            console.warn('[Server] Automation runner start error:', err.message)
        );
    } catch (err) {
        console.warn('[Server] Automation runner load failed:', err.message);
    }
    // Ticket Assistant sync engine (beta — polling-based background sync)
    try {
        const { startTicketAssistantSync } = require('./services/ticketAssistantSyncEngine');
        startTicketAssistantSync();
    } catch (err) {
        console.warn('[Server] Ticket Assistant sync engine load failed:', err.message);
    }
    // Customer Support SLA watcher — every 15 minutes, ping staff about
    // awaiting_agent threads with no first-response after 60 minutes.
    try {
        const supportStore = require('./stores/supportStore');
        const supportRoute = require('./routes/support');
        const _seenSla = new Map(); // threadId → last-warned timestamp
        setInterval(async () => {
            try {
                const stale = await supportStore.findSlaAtRiskThreads({ olderThanMinutes: 60 });
                for (const t of stale) {
                    const last = _seenSla.get(t.id) || 0;
                    if (Date.now() - last < 60 * 60 * 1000) continue; // warn at most hourly
                    _seenSla.set(t.id, Date.now());
                    await supportRoute.notifyStaff({
                        title: `SLA at risk: ${t.subject}`,
                        message: `Awaiting agent for >1h — ${t.requester_email}`,
                        threadId: t.id,
                    });
                }
            } catch (e) {
                console.warn('[Server] Support SLA watcher tick error:', e.message);
            }
        }, 15 * 60 * 1000);
    } catch (err) {
        console.warn('[Server] Support SLA watcher load failed:', err.message);
    }
    // NC user/group sync backstop — covers gaps when real-time webhooks miss
    try {
        require('./jobs/ncSyncBackstop').start();
    } catch (err) {
        console.warn('[Server] NC sync backstop load failed:', err.message);
    }
    // Purge orphaned KB chunks (non-blocking, delayed to let DB pool warm up)
    setTimeout(() => {
        try {
            const { purgeOrphanedChunks } = require('./core/localKBIngest');
            purgeOrphanedChunks()
                .then(n => { if (n > 0) console.log(`[Server] Startup: purged ${n} orphaned KB chunks`); })
                .catch(err => console.warn('[Server] Orphan purge error:', err.message));
        } catch (_) { /* localKBIngest not available — skip */ }
    }, 5000);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async (signal) => {
    console.log(`[Server] ${signal} received, cleaning up...`);
    await disconnectRedis(); // ioredis client (caching)
    // node-redis v5: close() replaces deprecated quit()
    if (_sessionRedisClient) {
        try { await _sessionRedisClient.close(); } catch (_) { }
    }
    process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
