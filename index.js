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
app.enable('trust proxy');
const PORT = process.env.SERVER_PORT || process.env.PORT || 3001;

// ── Security headers (helmet) ─────────────────────────────────────────────────
const helmet = require('helmet');
app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    contentSecurityPolicy: false,        // Handled by Nginx
    crossOriginEmbedderPolicy: false,    // Can break embedded content
    crossOriginResourcePolicy: { policy: 'same-site' },  // Allow cross-subdomain resource loading (server.dev → dev.beeflow.ai)
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
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || 'https://dev.beeflow.ai,https://server.dev.beeflow.ai,http://localhost:5173')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        // Allow requests with no origin
        if (!origin) return cb(null, true);
        // Allow Chrome extensions (PAT-authenticated, no cookies)
        if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
            return cb(null, true);
        }
        const normalizedOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        const isAllowed = ALLOWED_ORIGINS.some(o => (o.endsWith('/') ? o.slice(0, -1) : o) === normalizedOrigin);
        if (isAllowed) {
            return cb(null, true);
        }

        console.warn(`[CORS] Rejected origin: ${origin}. Allowed:`, ALLOWED_ORIGINS);
        // Return the origin anyway for dev mode flexibility or just 'true' to reflect:
        cb(null, origin);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token']
}));

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
        _sessionRedisClient = createClient({ url: process.env.REDIS_URL });
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
    secret: process.env.SESSION_SECRET || 'beeflow-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.COOKIE_SECURE === 'true',
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: process.env.COOKIE_SAMESITE || 'lax',
        ...(process.env.COOKIE_DOMAIN && { domain: process.env.COOKIE_DOMAIN })
    }
}));

// Personal Access Token auth — runs after session, populates session if Bearer token is valid
app.use(require('./auth/patAuth'));



// ── Session-token bridge (popup→iframe handoff for embedded mode) ──
// Helpers live in utils/sessionToken so OAuth callback can mint pickup tokens.
const { getSessionToken, setSessionToken, generateToken } = require('./utils/sessionToken');

app.use(async (req, res, next) => {
    const sessionToken = req.headers['x-session-token'];
    if (sessionToken) {
        const data = await getSessionToken(sessionToken);
        if (data) Object.assign(req.session, data);
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
        demoEnabled: process.env.DEMO_MODE_ENABLED !== 'false',
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
app.use('/components', componentsRouter);
app.use('/ai', aiRouter);
app.use('/workflow-ai', (req, res) => res.status(404).json({ error: 'Workflow AI removed' }));
app.use('/', executeRouter);
app.use('/agents/memory', memoryRouter);   // Must be before /agents
app.use('/agents', agentsRouter);
app.use('/reports', reportsRouter);
app.use('/apps', appsRouter);

app.use('/versions', require('./routes/versions'));
app.use('/api/usage', require('./routes/usage'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/client-errors', require('./routes/clientErrors'));
app.use('/api/org-privacy-shield', require('./routes/orgPrivacyShield'));
app.use('/api/org-azure-config', require('./routes/orgAzureConfig'));
app.use('/api/compliance', require('./routes/compliance'));
app.use('/api/chat/dlp-decision', require('./routes/dlpDecision'));
app.get('/api/guard/health', async (req, res) => {
    try {
        const guardUrl = process.env.GUARD_SERVICE_URL || 'http://guard-service:8100';
        const apiKey = process.env.SERVICES_API_KEY;
        const resp = await fetch(`${guardUrl}/health`, {
            headers: apiKey ? { 'X-API-Key': apiKey } : {},
            signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) return res.json(await resp.json());
        res.json({ status: 'unavailable' });
    } catch { res.json({ status: 'unavailable' }); }
});
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/stripe', require('./routes/stripe'));
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
app.use('/api/projects', projectFeatureGate, require('./routes/projects'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/ai-tasks', require('./routes/aiTasks'));
app.use('/api/integrations/gdrive', require('./routes/integrations/googleDrive'));
app.use('/api/integrations/gmail', require('./routes/integrations/gmail'));
app.use('/api/integrations/calendar', require('./routes/integrations/calendar'));
app.use('/api/integrations/contacts', require('./routes/integrations/contacts'));
app.use('/api/integrations/keep', require('./routes/integrations/keep'));
app.use('/api/storage', require('./routes/storageProxy'));
app.use('/api/integrations/linkedin', require('./routes/integrations/linkedin'));
app.use('/api/integrations/whatsapp', require('./routes/integrations/whatsapp'));
app.use('/api/integrations/github', require('./routes/integrations/github'));
app.use('/api/integrations/github-sync', require('./routes/integrations/githubSync'));
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
app.use('/api/notebooks', notebookFeatureGate, require('./routes/notebooks'));
app.use('/api/notebooks', notebookFeatureGate, require('./routes/notebookExport'));
// Webpages — gated per-organization via the beta-feature registry.
const { requireBetaFeature: requireWebpagesBeta } = require('./core/betaFeatures');
app.use('/api/webpages', requireWebpagesBeta('webpages'), require('./routes/webpages'));
app.use('/api/webpages', requireWebpagesBeta('webpages'), require('./routes/webpageExport'));
// Meeting Notes beta feature gate
const { requireBetaFeature } = require('./core/betaFeatures');
app.use('/api/transcriptions', requireBetaFeature('meeting_notes'), require('./routes/transcriptions'));
app.use('/api/meet-bot', requireBetaFeature('meeting_notes'), require('./routes/meetBot'));
app.use('/api/skills', requireBetaFeature('skills'), require('./routes/skills'));
// ITIL Ticket Assistant (formerly Email Knowledge Base). Both mount paths point
// to the same router while the `email_knowledge_base` beta-flag alias is live;
// remove the `/api/email-kb` alias and the alias entry in betaFeatures.js in
// the release after this one lands.
const ticketAssistantRouter = require('./routes/ticketAssistant');
app.use('/api/ticket-assistant', requireBetaFeature('itil_ticket_assistant'), ticketAssistantRouter);
app.use('/api/email-kb',        requireBetaFeature('itil_ticket_assistant'), ticketAssistantRouter);
app.use('/api/browser-agent', require('./routes/browserAgent'));
app.use('/api/pat', require('./routes/personalAccessTokens'));

app.use('/', require('./routes/knowledge'));
app.use('/api/kb', require('./routes/knowledgeBases'));
app.use('/api/languages', require('./routes/admin/languageRoutes'));
app.use('/api/icons', require('./routes/icons'));

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

    // Non-invasive self-check of every org Privacy Shield blob. Logs warnings
    // for legacy shapes, orphaned regex collections, and invalid custom terms
    // so operators can spot guardrail drift in the startup log.
    const { selfCheckOrgShields } = require('./core/orgShield');
    selfCheckOrgShields().catch(err => console.warn('[OrgShieldSelfCheck] Error:', err.message));

    // Register and schedule AI Act + GDPR compliance checks (6-hour interval).
    require('./compliance/checks');
    require('./compliance/scheduler').start();

    // Seed system agents into the database (explicit lifecycle call, not a require() side-effect)
    const { seedSystemAgents } = require('./stores/agent/systemAgents');
    seedSystemAgents()
        .then(() => console.log('[Server] System agents seeded'))
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
    // Ticket Assistant sync engine (beta — polling-based background sync)
    try {
        const { startTicketAssistantSync } = require('./services/ticketAssistantSyncEngine');
        startTicketAssistantSync();
    } catch (err) {
        console.warn('[Server] Ticket Assistant sync engine load failed:', err.message);
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
