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
const swarmsRouter = require('./routes/swarms');
const browserAgentsRouter = require('./routes/browserAgents');
const groupChatsRouter = require('./routes/groupChats');
const terminalAgentsRouter = require('./routes/terminalAgents');
const securityAgentsRouter = require('./routes/securityAgents');
const containerManager = require('./terminal/containerManager');
const securityContainerManager = require('./security/containerManager');

const app = express();
app.enable('trust proxy');
const PORT = process.env.SERVER_PORT || process.env.PORT || 3001;

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
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token']
}));

app.use(bodyParser.json({ limit: '20mb' }));

// ── Sessions ──────────────────────────────────────────────────────────────────────
const pgSession = require('connect-pg-simple')(session);
const { pool, getRedis, disconnectRedis } = require('./db');

// Sessions: Use PostgreSQL as primary store (persistent across deploys).
// Redis is ephemeral (no persistent volume) — sessions would be lost on container restart.
let sessionStore;
let _sessionRedisClient = null; // kept for graceful shutdown

// Primary: PostgreSQL (persistent via beeflow-pgdata volume)
sessionStore = new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true, pruneSessionInterval: 900 });
console.log('[Sessions] Using PostgreSQL session store (persistent across deploys)');

// Still connect Redis for caching (session tokens, etc.) but NOT for session storage
if (process.env.REDIS_URL) {
    try {
        const { createClient } = require('redis');
        _sessionRedisClient = createClient({ url: process.env.REDIS_URL });
        _sessionRedisClient.on('error', (err) => console.warn('[Sessions] Redis error:', err.message));
        _sessionRedisClient.connect().then(() => {
            console.log('[Sessions] Redis connected for caching');
        }).catch((err) => {
            console.warn('[Sessions] Redis connect failed:', err.message);
        });
    } catch (err) {
        console.warn('[Sessions] Failed to create Redis client:', err.message);
    }
}

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
        sameSite: process.env.COOKIE_SECURE === 'true' ? 'none' : 'lax',
        ...(process.env.COOKIE_DOMAIN && { domain: process.env.COOKIE_DOMAIN })
    }
}));



// ── Session token for embedded iframes (Redis-backed or in-memory fallback) ──
const _sessionTokenFallback = new Map(); // only used if Redis is unavailable

async function getSessionToken(token) {
    const r = getRedis();
    if (r) {
        const val = await r.get(`bf:stok:${token}`);
        return val ? JSON.parse(val) : null;
    }
    return _sessionTokenFallback.get(token) || null;
}

async function setSessionToken(token, data, ttlSeconds = 3600) {
    const r = getRedis();
    if (r) {
        await r.set(`bf:stok:${token}`, JSON.stringify(data), 'EX', ttlSeconds);
    } else {
        _sessionTokenFallback.set(token, data);
        setTimeout(() => _sessionTokenFallback.delete(token), ttlSeconds * 1000);
    }
}

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

    const crypto = require('crypto');
    const userStore = require('./stores/userStore');
    const token = crypto.randomBytes(32).toString('hex');
    const userId = req.session.user.id;
    const appPasswordData = userStore.getAppPassword(userId);

    await setSessionToken(token, {
        user: req.session.user,
        accessToken: req.session.accessToken,
        appPassword: appPasswordData
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
        demoEnabled: process.env.DEMO_MODE_ENABLED !== 'false'
    });
});

app.get('/api', (req, res) => {
    res.json({
        name: 'Bee Flow API',
        version: '1.0.0',
        endpoints: {
            'GET /api/health': 'Health check endpoint',
            'GET /components': 'List all available components',
            'POST /execute': 'Execute a workflow',
            'GET /agents': 'List all agents'
        }
    });
});

// ── Static files ──────────────────────────────────────────────────────────────
const agentHubDistPath = path.resolve(__dirname, '../agent-hub/dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(agentHubDistPath)) {
    app.use(express.static(agentHubDistPath));
    console.log('[Production] Serving static files from agent-hub:', agentHubDistPath);
}
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// ── RustFS Storage Init ───────────────────────────────────────────────────────
const storageStore = require('./stores/storageStore');
storageStore.init().then(ok => {
    if (ok) console.log('[Server] RustFS storage initialized');
    else console.warn('[Server] RustFS unavailable — using local disk fallback');
}).catch(err => console.warn('[Server] RustFS init error:', err.message));

// Serve APK download page + file
const apkPath = path.resolve(__dirname, '../beeflow-android/BeeFlow-debug.apk');
if (fs.existsSync(apkPath)) {
    app.get('/download/BeeFlow.apk', (req, res) => {
        res.download(apkPath, 'BeeFlow.apk');
    });
    app.get('/download', (req, res) => {
        const apkSize = (fs.statSync(apkPath).size / (1024 * 1024)).toFixed(1);
        res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download Bee Flow for Android</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(160deg,#fefce8 0%,#fff7ed 50%,#fef3c7 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border-radius:24px;box-shadow:0 20px 60px rgba(0,0,0,.08),0 1px 3px rgba(0,0,0,.04);max-width:440px;width:100%;padding:40px 32px;text-align:center}
  .logo{width:80px;height:80px;background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:20px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:40px;box-shadow:0 8px 24px rgba(245,158,11,.25)}
  h1{font-size:22px;font-weight:700;color:#1a1a1a;margin-bottom:6px}
  .subtitle{color:#666;font-size:14px;margin-bottom:28px}
  .download-btn{display:inline-flex;align-items:center;gap:10px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;font-size:16px;font-weight:600;padding:14px 32px;border-radius:14px;text-decoration:none;box-shadow:0 4px 16px rgba(245,158,11,.3);transition:transform .15s,box-shadow .15s}
  .download-btn:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(245,158,11,.4)}
  .download-btn svg{width:20px;height:20px}
  .size{color:#999;font-size:12px;margin-top:8px}
  .divider{height:1px;background:#eee;margin:28px 0}
  h2{font-size:15px;font-weight:600;color:#333;margin-bottom:16px;text-align:left}
  .steps{text-align:left;list-style:none;counter-reset:step}
  .steps li{position:relative;padding:0 0 16px 36px;font-size:13px;color:#555;line-height:1.5}
  .steps li:last-child{padding-bottom:0}
  .steps li::before{counter-increment:step;content:counter(step);position:absolute;left:0;top:0;width:24px;height:24px;background:#fef3c7;color:#b45309;font-size:12px;font-weight:700;border-radius:8px;display:flex;align-items:center;justify-content:center}
  .steps li strong{color:#333}
  .note{background:#fefce8;border:1px solid #fde68a;border-radius:12px;padding:12px 16px;margin-top:24px;font-size:12px;color:#92400e;text-align:left;line-height:1.5}
  .back{display:inline-block;margin-top:24px;color:#999;font-size:13px;text-decoration:none}
  .back:hover{color:#666}
</style>
</head><body>
<div class="card">
  <div class="logo">&#x1f41d;</div>
  <h1>Bee Flow for Android</h1>
  <p class="subtitle">Get the native app for a faster, smoother experience</p>
  <a href="/download/BeeFlow.apk" class="download-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    Download APK
  </a>
  <p class="size">${apkSize} MB &bull; Android 7.0+</p>
  <div class="divider"></div>
  <h2>Installation Instructions</h2>
  <ol class="steps">
    <li>Tap <strong>Download APK</strong> above</li>
    <li>When prompted, allow your browser to <strong>install unknown apps</strong><br><span style="color:#999">(Settings → Apps → Browser → Install unknown apps)</span></li>
    <li>Open the downloaded file and tap <strong>Install</strong></li>
    <li>If Google Play Protect warns you, tap <strong>"Install anyway"</strong> — the app is safe</li>
    <li>Open Bee Flow and <strong>sign in</strong> with your account</li>
  </ol>
  <div class="note">
    &#x1f512; <strong>Why the warning?</strong> Since this app isn't on the Play Store, Android shows a security prompt. This is normal for direct APK installs.
  </div>
  <a href="/" class="back">&larr; Back to Bee Flow</a>
</div>
</body></html>`);
    });
    console.log('[Server] APK download page at /download');
}

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
app.use('/swarms', swarmsRouter);
app.use('/browser-agents', browserAgentsRouter);
app.use('/group-chats', groupChatsRouter);
app.use('/terminal-agents', terminalAgentsRouter);
app.use('/security-agents', securityAgentsRouter);
app.use('/versions', require('./routes/versions'));
app.use('/api/usage', require('./routes/usage'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/org-privacy-shield', require('./routes/orgPrivacyShield'));
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
app.use('/api/documents', require('./routes/documents'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/monitoring', require('./routes/monitoring'));
app.use('/api/integrations/gdrive', require('./routes/integrations/googleDrive'));
app.use('/api/integrations/gmail', require('./routes/integrations/gmail'));
app.use('/api/integrations/calendar', require('./routes/integrations/calendar'));
app.use('/api/integrations/contacts', require('./routes/integrations/contacts'));
app.use('/api/integrations/keep', require('./routes/integrations/keep'));
app.use('/api/storage', require('./routes/storageProxy'));
app.use('/api/integrations/sheets', require('./routes/integrations/sheets'));
app.use('/api/integrations/linkedin', require('./routes/integrations/linkedin'));
app.use('/api/integrations/whatsapp', require('./routes/integrations/whatsapp'));
app.use('/api/integrations/github', require('./routes/integrations/github'));
app.use('/api/integrations/outlook', require('./routes/integrations/outlook'));
app.use('/api/integrations/onedrive', require('./routes/integrations/oneDrive'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/transcriptions', require('./routes/transcriptions'));
app.use('/api/meet-bot', require('./routes/meetBot'));
app.use('/', require('./routes/knowledge'));
app.use('/api/kb', require('./routes/knowledgeBases'));

// ── SPA fallback (production) ─────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
    const indexPath = path.join(agentHubDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        app.use((req, res) => res.sendFile(indexPath));
    }
}

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);

    try {
        containerManager.ensureDockerImage();
        containerManager.startCleanupTimer();
        console.log('[Server] Container manager initialized');
    } catch (err) {
        console.warn('[Server] Container manager init failed:', err.message);
    }

    try {
        securityContainerManager.ensureDockerImage();
        securityContainerManager.startCleanupTimer();
        console.log('[Server] Security container manager initialized');
    } catch (err) {
        console.warn('[Server] Security container manager init failed:', err.message);
    }

    // Initialize MCP server connections (non-blocking)
    try {
        const mcpManager = require('./core/mcpManager');
        mcpManager.initialize().catch(err =>
            console.warn('[Server] MCP manager init error:', err.message)
        );
    } catch (err) {
        console.warn('[Server] MCP manager load failed:', err.message);
    }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async (signal) => {
    console.log(`[Server] ${signal} received, cleaning up...`);
    containerManager.shutdownAll();
    securityContainerManager.shutdownAll();
    await disconnectRedis(); // ioredis client (caching)
    // node-redis v5: close() replaces deprecated quit()
    if (_sessionRedisClient) {
        try { await _sessionRedisClient.close(); } catch (_) { }
    }
    process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
