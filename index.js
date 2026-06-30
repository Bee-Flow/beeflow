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

// Disable Express's automatic ETag on responses. The NC AppAPI PHP/Apache hop
// can otherwise revalidate a dynamic JSON GET with If-None-Match and replay a
// stale 304 body even though we send Cache-Control: no-store — which made the
// chat-history sidebar and other lists show stale data until a hard refresh
// (BFSF-209). no-store + no ETag means the proxy can't serve a cached body.
app.disable('etag');

// Dynamic, per-user API responses must never be cached by the browser or any
// intermediary. In the Nextcloud connector path (browser → NC AppAPI proxy →
// connector → here) these JSON GETs carried no Cache-Control, so the browser
// heuristically cached them and replayed a stale role / group / member list
// until the cache was cleared — one account saw a change while another did not.
// Mark them non-cacheable. Image-ish endpoints (icons, branding) are excluded
// so they keep their own long-lived caching.
app.use((req, res, next) => {
    if ((req.path.startsWith('/auth/') || req.path.startsWith('/api/')
            || req.path.startsWith('/ai/') || req.path.startsWith('/agents/'))
        && !req.path.startsWith('/api/icons')
        && !req.path.startsWith('/api/branding')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
    }
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

// ── Request-timing instrumentation ─────────────────────────────────────────────
// Records per-route latency into httpMetrics (exposed at /api/admin/metrics).
// Route labels are normalized to a TEMPLATE (id-like segments → :id) so
// cardinality stays bounded regardless of how many conversations/agents exist.
// Long-lived SSE streams are skipped — their duration is the stream length, not
// request-handling latency, and would swamp the histogram.
const httpMetrics = require('./core/httpMetrics');
function _normalizeRoute(req) {
    let full = (req.baseUrl || '') + ((req.route && req.route.path && typeof req.route.path === 'string') ? req.route.path : '');
    if (!full) full = req.path || '';
    const norm = full.split('/').filter(Boolean).map(seg => {
        if (/^\d+$/.test(seg)) return ':id';
        if (/^[0-9a-fA-F-]{8,}$/.test(seg)) return ':id';
        if (seg.length > 24) return ':id';
        return seg;
    }).join('/');
    return '/' + norm;
}
app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        try {
            const ct = res.getHeader('Content-Type');
            if (typeof ct === 'string' && ct.includes('text/event-stream')) return;
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            httpMetrics.recordHttp({ method: req.method, route: _normalizeRoute(req), status: res.statusCode, ms });
        } catch (_) { /* never break the response */ }
    });
    next();
});

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

// ── Well-known discovery docs ─────────────────────────────────────────────────
// Microsoft Azure AD publisher-domain verification (cloud-only). Mounted before
// the static/SPA layers so the catch-all doesn't swallow the .well-known path.
app.use('/.well-known', require('./routes/wellKnown'));

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

// ── Legal-document overrides cache ────────────────────────────────────────────
// Load admin overrides (content / version / requiresConsent / optional consents)
// into the in-memory cache the synchronous consent registry reads from.
require('./legal/legalStore').refresh()
    .then(() => console.log('[Server] Legal overrides loaded'))
    .catch(err => console.warn('[Server] Legal overrides init error:', err.message));


// ── Mount routes ──────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
// MFA (TOTP) management — mounted after authRouter so /auth/mfa/* paths the
// auth router doesn't define (setup/enable/disable/regenerate/status) fall
// through to here. Login-time verification (/auth/mfa/verify-login) lives in
// the auth router itself.
app.use('/auth/mfa', require('./auth/mfaRoutes'));
// Component Designer is enterprise-tier — same `requireFeature` middleware
// the other gated routers use at L353+; inlined here because the
// destructure that exposes it as `requireLicenseFeature` lives further
// down (same pattern as /api/compliance on L304).
app.use('/components', (req, res, next) => require('./core/entitlements').requireCapability('component_designer')(req, res, next), componentsRouter);
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
    return require('./core/entitlements').requireCapability('advanced_usage_monitoring')(req, res, next);
};
app.use('/api/usage', _advUsagePrefixGate, require('./routes/usage'));
// /api/terminations and /api/feedback back the Terminations + Feedback
// usage tabs — same advanced-monitoring gate, applied at the mount.
const _advUsageGate = (req, res, next) => require('./core/entitlements').requireCapability('advanced_usage_monitoring')(req, res, next);
app.use('/api/terminations', _advUsageGate, require('./routes/terminations'));
app.use('/api/feedback', _advUsageGate, require('./routes/feedback'));
app.use('/api/client-errors', require('./routes/clientErrors'));
app.use('/api/web-vitals', require('./routes/webVitals'));
app.use('/api/csp-report', require('./routes/cspReport'));
app.use('/api/org-privacy-shield', require('./routes/orgPrivacyShield'));
app.use('/api/org-azure-config', require('./routes/orgAzureConfig'));
app.use('/api/house-styles', require('./routes/houseStyles'));
// Compliance Hub — Enterprise-tier feature.
app.use('/api/compliance', (req, res, next) => require('./core/entitlements').requireCapability('compliance_hub_gdpr')(req, res, next), require('./routes/compliance'));
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
// Operational metrics (route latency, slow-query / cache hit-miss counters).
// Admin-gated — this is operational data, not public. `?format=prometheus`
// returns the text exposition format; default is JSON.
const { requireAdmin: _requireAdminForMetrics } = require('./auth/permissions');
app.get('/api/admin/metrics', _requireAdminForMetrics, (req, res) => {
    const { getPoolStats } = require('./db');
    if (req.query.format === 'prometheus') {
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        return res.send(httpMetrics.renderTextFormat());
    }
    res.json({ ...httpMetrics.snapshot(), pool: getPoolStats() });
});
app.use('/api/admin/guard', require('./routes/guardInstall'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/license', require('./routes/license'));
app.use('/api/admin/licenses', require('./routes/adminLicense'));
const { requireFeature: requireLicenseFeature, requireTier: requireLicenseTier } = require('./license/middleware');
// Unified entitlement gate — folds tier + plan-grant + beta opt-in + org/group
// grant into one decision (compound betas enforce license AND beta). Replaces
// the requireLicenseFeature(+requireBetaFeature) pairs below where the route is a
// compound beta or a user-facing core capability. Routes whose gate is a
// community-licensed GA feature (automations/ai-tasks) or license-only
// (talk-notes-settings) keep requireLicenseFeature to avoid over-gating.
const { requireCapability } = require('./core/entitlements');
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
app.use('/api/projects', requireCapability('projects'), projectFeatureGate, require('./routes/projects'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/ai-tasks', require('./routes/aiTasks'));
app.use('/api/automation/builder', requireLicenseFeature('automations'), require('./routes/ai/automationBuilder'));
app.use('/api/automation', requireLicenseFeature('automations'), require('./routes/automation'));
app.use('/api/step', requireLicenseFeature('automations'), require('./routes/step'));
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
app.use('/api/integrations/connections', require('./routes/integrations/connections'));
// AI Integration Builder — org-admin API for org-scoped custom integrations.
// Double gate at mount: the 'ai_integration_builder' beta capability AND the
// dark-ship kill switch (feature_custom_integrations_enabled, fail-closed 404).
const { customIntegrationsFeatureGate } = require('./core/customIntegrations/featureFlag');
app.use('/api/organizations/:orgId/custom-integrations',
    requireCapability('ai_integration_builder'),
    customIntegrationsFeatureGate,
    require('./routes/orgIntegrations/builder'));
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
app.use('/api/notebooks', requireCapability('notebooks'), notebookFeatureGate, require('./routes/notebooks'));
app.use('/api/notebooks', requireCapability('notebooks'), notebookFeatureGate, require('./routes/notebookExport'));
// Legal Studio (Dutch legal matters) — a matter is a notebook of type
// 'legal_matter', so it shares the notebooks licence + feature gate. The
// per-org dutch_legal_sources beta gate lives inside the router.
app.use('/api/legal-matters', requireCapability('notebooks'), notebookFeatureGate, require('./routes/legalMatters'));
// Webpages — compound beta (license 'webpages' AND the webpages beta). The
// unified gate enforces both via the resolver's effective.beta set and honours
// per-group grants.
app.use('/api/webpages', requireCapability('webpages'), require('./routes/webpages'));
app.use('/api/webpages', requireCapability('webpages'), require('./routes/webpageExport'));
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
// Public certificate verification — unauthenticated `/verify/:token` for a
// LinkedIn-shareable Bee Flow AI certificate. Token-gated (only certs the owner
// opted public are resolvable), per-IP rate limited, strict CSP, og:image. Mounted
// before the SPA catch-all so the SPA doesn't swallow it.
app.use('/verify', require('./routes/verifyCertificate'));
// Meeting Notes — compound beta (license 'meeting_notes' AND the beta).
app.use('/api/transcriptions', requireCapability('meeting_notes'), require('./routes/transcriptions'));
// Nextcloud Talk → Meeting Notes settings (org + user toggles). License-only
// (no beta gate) — kept on requireLicenseFeature so it isn't over-gated.
app.use('/api/talk-notes-settings', requireLicenseFeature('meeting_notes'), require('./routes/talkNotesSettings'));
app.use('/api/skills', requireCapability('skills'), require('./routes/skills'));
// ITIL Ticket Assistant (formerly Email Knowledge Base). Both mount paths point
// to the same router while the `email_knowledge_base` beta-flag alias is live;
// remove the `/api/email-kb` alias and the alias entry in betaFeatures.js in
// the release after this one lands.
const ticketAssistantRouter = require('./routes/ticketAssistant');
app.use('/api/ticket-assistant', requireCapability('itil_ticket_assistant'), ticketAssistantRouter);
app.use('/api/email-kb',        requireCapability('itil_ticket_assistant'), ticketAssistantRouter);

// Customer Support — Bee Flow's own AI-first support inbox. Mounted publicly
// (no license/beta gate) because the POST /threads endpoint accepts anonymous
// submissions from the marketing site; staff-only endpoints enforce
// admin_support inside the router.
app.use('/api/support', require('./routes/support'));

// Tests Studio — Playwright generation + runs. Beta-gated + enterprise feature.
app.use('/api/tests', requireCapability('playwright_tests'), require('./routes/tests'));
app.use('/api/security', requireCapability('security_scan'), require('./routes/securityScans'));
// Support Studio — tenant customer-support inbox (Studio → Support). Compound
// beta; the org-level support_inbox permission is additionally enforced inside.
app.use('/api/support-inbox', requireCapability('support_inbox'), require('./routes/supportInbox'));
// Lead Studio — AI lead generation + enrichment (Studio → Lead Studio). Compound
// beta; the org-level lead_studio permission is additionally enforced inside.
app.use('/api/lead-studio', requireCapability('lead_studio'), require('./routes/leadStudio'));

app.use('/', require('./routes/knowledge'));
app.use('/api/kb', require('./routes/knowledgeBases'));
app.use('/api/search', require('./routes/search'));
app.use('/api/languages', require('./routes/admin/languageRoutes'));
app.use('/api/legal', require('./routes/admin/legalRoutes'));
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
    if (process.env.INSECURE_CONNECTOR_TRUST === '1') {
        console.error('[SECURITY] INSECURE_CONNECTOR_TRUST=1 was set in the environment but the insecure connector bypass has been retired (Phase 2). Remove the variable. Refusing to boot.');
        process.exit(1);
    }

    // Run first-boot setup from INIT_* env vars (set by install wizard)
    const { runBootInit } = require('./boot-init');
    runBootInit().catch(err => console.error('[boot-init] Fatal:', err));

    // Learning-certificate HMAC secret: bootstrap a configStore-persisted secret
    // for installs that never set LEARNING_CERT_SECRET, so certificate serials
    // and public verify links survive restarts instead of silently breaking.
    const { ensureDurableSecret } = require('./auth/certificateToken');
    ensureDurableSecret().catch(err => console.error('[CertificateToken] bootstrap failed:', err.message));

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
        // Local-dev / ops escape hatch: set SKIP_SYSTEM_KB_SEED=true to skip the
        // (CPU-bound, multi-minute) Dutch legal sources seed and its weekly
        // refresh. Has no effect in production unless the var is set there.
        // The Dutch legal corpus is Bee-Flow-managed hosted content; only the
        // cloud deployment maintains it. Self-hosted (and the retired
        // 'private-cloud' value) must not run the boot seed or weekly refresh
        // against external sources. Mirrors the DEPLOYMENT_MODE convention in
        // core/limits.js. The SKIP_SYSTEM_KB_SEED hatch still works everywhere.
        const isCloud = (process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud';
        if (process.env.SKIP_SYSTEM_KB_SEED === 'true' || !isCloud) {
            console.log('[dutchLawIngest] skipping boot seed + weekly refresh (non-cloud deployment or SKIP_SYSTEM_KB_SEED).');
        } else {
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
        }
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

    // NC org-name backfill — idempotent one-shot that renames connector-
    // provisioned orgs still on the generic "Nextcloud" default to
    // "Nextcloud (<host>)" so they're distinguishable in the admin list.
    // After a row is renamed it no longer matches, so re-runs are no-ops.
    setImmediate(() => {
        require('./stores/userStore').backfillAutoProvisionedNcOrgNames().catch(e =>
            console.warn('[Server] nc org-name backfill error:', e.message));
    });

    // MCP-as-integration migration — idempotent one-shot that folds the dormant
    // subscription_plans.allowed_mcp_servers into allowed_integrations and moves
    // legacy mcp:<id> org grants from org_granted_capabilities into
    // org_enabled_integrations. Re-runs are no-ops once both are cleared.
    setImmediate(() => {
        require('./migrations/mcp-as-integration-2026-06').up().catch(e =>
            console.warn('[Server] mcp-as-integration migration error:', e.message));
    });

    // Dutch translations for the signup wizard, MFA, password reset and the
    // Security settings section. Idempotent — only fills keys with no NL value.
    setImmediate(() => {
        require('./migrations/add-nl-signup-mfa-reset-auth-translations').up().catch(e =>
            console.warn('[Server] add-nl-signup-mfa-reset-auth-translations migration error:', e.message));
    });

    // Dutch label for the relabelled login email field (BFSF-235/236/237/238).
    // Idempotent — only fills keys with no NL value.
    setImmediate(() => {
        require('./migrations/add-nl-login-email-relabel').up().catch(e =>
            console.warn('[Server] add-nl-login-email-relabel migration error:', e.message));
    });

    // Repair org founders left at 'pending'/'waitlist' so they stop hitting the
    // "Awaiting Approval" gate on every login. Idempotent — 0 rows once fixed.
    setImmediate(() => {
        require('./migrations/fix-org-admin-approval-status').up().catch(e =>
            console.warn('[Server] fix-org-admin-approval-status migration error:', e.message));
    });

    // Ensure exactly one default org plan exists (BFSF-226) so new cloud orgs
    // land on the capped Free plan instead of plan-less "unlimited". Existing
    // no-plan orgs are only reported (census), never auto-assigned. Idempotent.
    setImmediate(() => {
        require('./migrations/default-org-plan-2026-06').up().catch(e =>
            console.warn('[Server] default-org-plan migration error:', e.message));
    });

    // Backfill the unified support_audit_log from legacy support_thread_events so
    // the new Support → Audit view shows historical events on existing installs.
    // Idempotent (rows keyed by source id, inserted only WHERE NOT EXISTS).
    setImmediate(() => {
        require('./migrations/support-audit-log-backfill-2026-06').up().catch(e =>
            console.warn('[Server] support-audit-log-backfill migration error:', e.message));
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

    // Playwright test-run drain — claims test_run_jobs outbox rows and runs
    // them in isolated containers. Same outbox + backoff pattern as PAYG drain.
    // When a dedicated test-runner worker is deployed, set
    // PLAYWRIGHT_DRAIN_IN_API=false so the API stops draining and the worker is
    // the single claimer (keeps headless-browser work out of the API process
    // and the concurrency caps unambiguous). A periodic reaper removes any
    // orphaned runner containers regardless of who drains.
    try {
        const drainInApi = process.env.PLAYWRIGHT_DRAIN_IN_API !== 'false';
        const TEST_RUN_DRAIN_INTERVAL_MS = parseInt(process.env.PLAYWRIGHT_DRAIN_TICK_INTERVAL_MS || '15000', 10);
        const REAP_INTERVAL_MS = parseInt(process.env.PLAYWRIGHT_REAP_INTERVAL_MS || '120000', 10);
        const testRunner = require('./workers/testRunner');

        if (drainInApi) {
            const runTestDrain = async () => {
                try {
                    const r = await testRunner.drainOnce();
                    if (r?.processed) console.log(`[TestRunner] processed=${r.processed}`);
                } catch (e) { console.error('[TestRunner] tick error:', e.message); }
            };
            setTimeout(runTestDrain, 20_000).unref();
            setInterval(runTestDrain, TEST_RUN_DRAIN_INTERVAL_MS).unref();
            // Reap orphaned runner containers (crashed-worker leftovers) on boot
            // and periodically.
            testRunner.reapRunners().catch(() => {});
            setInterval(() => testRunner.reapRunners().catch(() => {}), REAP_INTERVAL_MS).unref();
            console.log(`[Server] Playwright test-run drain scheduler started (interval=${TEST_RUN_DRAIN_INTERVAL_MS}ms)`);
        } else {
            console.log('[Server] Playwright test-run drain disabled in API (PLAYWRIGHT_DRAIN_IN_API=false) — dedicated worker owns it');
        }
    } catch (e) {
        console.warn('[Server] Failed to start test-run drain scheduler:', e.message);
    }

    // Optionally pre-warm the shared browser singleton so the first PDF export /
    // thumbnail / SPA ingest doesn't pay the container cold-start. Off by default
    // (idle deployments shouldn't hold a browser container open).
    if (process.env.BROWSER_WARMUP === 'true') {
        try {
            require('./services/pwtRunner')
                .ensureBrowserSingleton({ onLine: (l) => console.log(`[browser] ${l}`) })
                .then(
                    () => console.log('[Server] Shared browser singleton warmed'),
                    (e) => console.warn('[Server] Browser warmup failed:', e.message),
                );
        } catch (e) {
            console.warn('[Server] Browser warmup error:', e.message);
        }
    }

    // Security-scan drain — claims security_scan_jobs outbox rows and runs the
    // selected scanner engines (OWASP ZAP / Nuclei / testssl.sh) in isolated
    // containers. Same outbox + backoff + reaper pattern as the test-run drain.
    // Set SECURITY_DRAIN_IN_API=false when a dedicated scan-runner worker owns it.
    try {
        const scanDrainInApi = process.env.SECURITY_DRAIN_IN_API !== 'false';
        const SCAN_DRAIN_INTERVAL_MS = parseInt(process.env.SECURITY_DRAIN_TICK_INTERVAL_MS || '15000', 10);
        const SCAN_REAP_INTERVAL_MS = parseInt(process.env.SECURITY_REAP_INTERVAL_MS || '120000', 10);
        const scanRunner = require('./workers/scanRunner');

        if (scanDrainInApi) {
            const runScanDrain = async () => {
                try {
                    const r = await scanRunner.drainOnce();
                    if (r?.processed) console.log(`[ScanRunner] processed=${r.processed}`);
                } catch (e) { console.error('[ScanRunner] tick error:', e.message); }
            };
            setTimeout(runScanDrain, 22_000).unref();
            setInterval(runScanDrain, SCAN_DRAIN_INTERVAL_MS).unref();
            scanRunner.reapRunners().catch(() => {});
            setInterval(() => scanRunner.reapRunners().catch(() => {}), SCAN_REAP_INTERVAL_MS).unref();
            console.log(`[Server] Security-scan drain scheduler started (interval=${SCAN_DRAIN_INTERVAL_MS}ms)`);
        } else {
            console.log('[Server] Security-scan drain disabled in API (SECURITY_DRAIN_IN_API=false) — dedicated worker owns it');
        }
    } catch (e) {
        console.warn('[Server] Failed to start security-scan drain scheduler:', e.message);
    }

    // Lead Studio drain — claims lead_generation_jobs outbox rows and runs each
    // campaign's AI discovery/enrichment/compaction pipeline (HTTP/LLM work, no
    // containers). Same outbox + backoff pattern as the scan drain. Set
    // LEAD_STUDIO_DRAIN_IN_API=false when a dedicated worker owns draining.
    try {
        const leadDrainInApi = process.env.LEAD_STUDIO_DRAIN_IN_API !== 'false';
        const LEAD_DRAIN_INTERVAL_MS = parseInt(process.env.LEAD_STUDIO_DRAIN_TICK_INTERVAL_MS || '15000', 10);
        if (leadDrainInApi) {
            const leadWorker = require('./workers/leadGenerationWorker');
            const runLeadDrain = async () => {
                try {
                    const r = await leadWorker.drainOnce();
                    if (r?.processed) console.log(`[LeadGenWorker] processed=${r.processed}`);
                } catch (e) { console.error('[LeadGenWorker] tick error:', e.message); }
            };
            setTimeout(runLeadDrain, 23_000).unref();
            setInterval(runLeadDrain, LEAD_DRAIN_INTERVAL_MS).unref();
            console.log(`[Server] Lead Studio drain scheduler started (interval=${LEAD_DRAIN_INTERVAL_MS}ms)`);
        } else {
            console.log('[Server] Lead Studio drain disabled in API (LEAD_STUDIO_DRAIN_IN_API=false) — dedicated worker owns it');
        }
    } catch (e) {
        console.warn('[Server] Failed to start Lead Studio drain scheduler:', e.message);
    }

    // Lead Studio retention purge — AVG: delete lead PII past each campaign's
    // retention window (campaign shells are kept). Daily tick + a first run a
    // minute after boot.
    try {
        const LEAD_PURGE_INTERVAL_MS = parseInt(process.env.LEAD_STUDIO_PURGE_INTERVAL_MS || '86400000', 10);
        const leadStudioStore = require('./stores/leadStudioStore');
        const runLeadPurge = () => leadStudioStore.purgeExpiredLeads().catch(err => console.warn('[LeadStudio] purge error:', err.message));
        setTimeout(runLeadPurge, 60_000).unref();
        setInterval(runLeadPurge, LEAD_PURGE_INTERVAL_MS).unref();
        console.log(`[Server] Lead Studio retention purge scheduler started (interval=${LEAD_PURGE_INTERVAL_MS}ms)`);
    } catch (e) {
        console.warn('[Server] Failed to start Lead Studio purge scheduler:', e.message);
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
    // Support Studio inbox sync — polls connected tenant mailboxes and turns
    // inbound email into support tickets. Set SUPPORT_INBOX_SYNC_IN_API=false
    // when a dedicated worker owns it.
    try {
        if (process.env.SUPPORT_INBOX_SYNC_IN_API !== 'false') {
            require('./services/supportInboxSyncEngine').startSupportInboxSync();
        }
    } catch (err) {
        console.warn('[Server] Support inbox sync engine load failed:', err.message);
    }
    // Support Studio historical-scan drain — runs on-demand "how fast did we
    // answer in the past?" scans queued from the Insights view. Aggregate-only,
    // off the sync tick. Set SUPPORT_SCAN_IN_API=false when a worker owns it.
    try {
        if (process.env.SUPPORT_SCAN_IN_API !== 'false') {
            require('./services/supportInboxScanEngine').startSupportInboxScan();
        }
    } catch (err) {
        console.warn('[Server] Support inbox scan engine load failed:', err.message);
    }
    // Customer Support SLA enforcer — policy-driven first-response/resolution
    // breach detection on a 60s tick (replaces the old 15-min at-risk warner).
    try {
        require('./services/supportSlaEnforcer').start();
    } catch (err) {
        console.warn('[Server] Support SLA enforcer load failed:', err.message);
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
