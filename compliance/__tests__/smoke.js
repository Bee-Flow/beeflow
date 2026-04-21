/**
 * Smoke-test harness for compliance checks.
 *
 * Each check is exercised with a `pass` scenario and a `fail`/`warn` scenario
 * by monkey-patching the low-level stores (configStore, complianceStore, db)
 * before requiring the check module.
 *
 * Run:  node server/compliance/__tests__/smoke.js
 */

const path = require('path');

// ── Import the real low-level modules, then overwrite their functions ──
// All checks import these same singletons, so overwrites persist.
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'test-master-key-smoke-harness';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-smoke';

const configStore = require('../../stores/configStore');
const complianceStore = require('../../stores/complianceStore');
const db = require('../../db');

// In-memory fakes for the stores
const _state = {
    config: /** @type {Record<string, any>} */ ({}),
    settings: { breach_recipients: [], dpo_email: null, dpo_name: null, privacy_notice_url: null },
    dbRows: /** @type {{query: RegExp, rows: any[]}[]} */ ([]),
    dbOne: /** @type {{query: RegExp, row: any}[]} */ ([]),
};

configStore.getConfig = async (key) => _state.config[key] ?? null;
configStore.setConfig = async (key, val) => { _state.config[key] = val; };
configStore.getSecret = async () => null;

complianceStore.getSettings = async () => ({ ..._state.settings });

db.getAll = async (sql) => {
    for (const m of _state.dbRows) if (m.query.test(sql)) return m.rows;
    return [];
};
db.getOne = async (sql) => {
    for (const m of _state.dbOne) if (m.query.test(sql)) return m.row;
    return null;
};

// ── Load checks after stubs are in place ──
const checks = {
    encryptionAtRest: require('../checks/gdpr/art32-encryption-at-rest'),
    encryptionInTransit: require('../checks/gdpr/art32-encryption-in-transit'),
    dlp: require('../checks/gdpr/art32-dlp-enabled'),
    accessLogging: require('../checks/gdpr/art32-access-logging'),
    breachDetection: require('../checks/gdpr/art33-breach-detection'),
    dpo: require('../checks/gdpr/art37-dpo-appointed'),
    privacyNotice: require('../checks/gdpr/art12-privacy-notice'),
    externalTransfers: require('../checks/gdpr/art44-external-transfers'),
    aiDisclosure: require('../checks/aia/art50-ai-disclosure'),
    transparency: require('../checks/aia/art13-transparency'),
};

// ── Tiny test runner ──
let passed = 0, failed = 0;
async function t(name, fn) {
    try { await fn(); console.log('  ✅', name); passed++; }
    catch (e) { console.error('  ❌', name, '—', e.message); failed++; }
}
function assertStatus(actual, expected, msg) {
    if (actual.status !== expected) {
        throw new Error(`${msg}: expected status "${expected}", got "${actual.status}" (details: ${actual.details})`);
    }
}

function resetState() {
    _state.config = {};
    _state.settings = { breach_recipients: [], dpo_email: null, dpo_name: null, privacy_notice_url: null };
    _state.dbRows = [];
    _state.dbOne = [];
}

// ── Scenarios ──

(async () => {

    console.log('\n▶ GDPR Art. 32 — Encryption at rest');
    await t('pass when env vars are set', async () => {
        process.env.MASTER_ENCRYPTION_KEY = 'set';
        process.env.SESSION_SECRET = 'set';
        assertStatus(await checks.encryptionAtRest.evaluate(), 'pass', 'both set');
    });
    await t('fail when master key missing', async () => {
        delete process.env.MASTER_ENCRYPTION_KEY;
        assertStatus(await checks.encryptionAtRest.evaluate(), 'fail', 'missing master');
        process.env.MASTER_ENCRYPTION_KEY = 'restore';
    });

    console.log('\n▶ GDPR Art. 32 — Encryption in transit');
    await t('pass in production with TRUST_PROXY', async () => {
        process.env.NODE_ENV = 'production'; process.env.TRUST_PROXY = '1';
        assertStatus(await checks.encryptionInTransit.evaluate(), 'pass', 'prod+proxy');
    });
    await t('warn in development', async () => {
        process.env.NODE_ENV = 'development'; delete process.env.TRUST_PROXY;
        assertStatus(await checks.encryptionInTransit.evaluate(), 'warn', 'dev');
    });

    console.log('\n▶ GDPR Art. 32 — DLP enabled');
    await t('pass when org shield has all three layers', async () => {
        resetState();
        _state.config['org_privacy_shield_default'] = {
            enabled: true, collectionIds: ['x'],
            azurePiiEnabled: true, piiDetectionCategories: ['email'],
            moderationEnabled: true,
        };
        assertStatus(await checks.dlp.evaluate('default'), 'pass', 'shield full');
    });
    await t('pass using global ai-config fallback', async () => {
        resetState();
        _state.config['ai'] = {
            regexGuardrails: [{ id: 'a' }],
            piiDetectionCategories: ['email', 'iban'],
            moderationEnabled: true,
        };
        assertStatus(await checks.dlp.evaluate('acme'), 'pass', 'global fallback');
    });
    await t('fail when nothing configured', async () => {
        resetState();
        assertStatus(await checks.dlp.evaluate('acme'), 'fail', 'empty');
    });

    console.log('\n▶ GDPR Art. 32 — Access logging');
    await t('pass when recent events exist', async () => {
        resetState();
        _state.dbOne = [{ query: /guardrail_events/, row: { c: 42 } }];
        assertStatus(await checks.accessLogging.evaluate('default'), 'pass', 'events present');
    });
    await t('warn when no events in 7d', async () => {
        resetState();
        _state.dbOne = [{ query: /guardrail_events/, row: { c: 0 } }];
        assertStatus(await checks.accessLogging.evaluate('default'), 'warn', 'no events');
    });

    console.log('\n▶ GDPR Art. 33 — Breach detection');
    await t('pass with valid recipient', async () => {
        resetState();
        _state.settings.breach_recipients = ['dpo@example.com'];
        assertStatus(await checks.breachDetection.evaluate('x'), 'pass', 'one recipient');
    });
    await t('fail when no recipients', async () => {
        resetState();
        assertStatus(await checks.breachDetection.evaluate('x'), 'fail', 'empty');
    });
    await t('fail when recipients without @', async () => {
        resetState();
        _state.settings.breach_recipients = ['not-an-email'];
        assertStatus(await checks.breachDetection.evaluate('x'), 'fail', 'invalid emails');
    });

    console.log('\n▶ GDPR Art. 37 — DPO appointed');
    await t('pass with name and email', async () => {
        resetState();
        _state.settings.dpo_name = 'Jane Doe'; _state.settings.dpo_email = 'jane@example.com';
        assertStatus(await checks.dpo.evaluate('x'), 'pass', 'full dpo');
    });
    await t('fail without dpo', async () => {
        resetState();
        assertStatus(await checks.dpo.evaluate('x'), 'fail', 'empty dpo');
    });

    console.log('\n▶ GDPR Art. 12 — Privacy notice');
    await t('pass with https url', async () => {
        resetState();
        _state.settings.privacy_notice_url = 'https://example.com/privacy';
        assertStatus(await checks.privacyNotice.evaluate('x'), 'pass', 'url set');
    });
    await t('fail when empty', async () => {
        resetState();
        assertStatus(await checks.privacyNotice.evaluate('x'), 'fail', 'empty url');
    });

    console.log('\n▶ GDPR Art. 44 — External transfers');
    await t('pass when no providers configured', async () => {
        resetState();
        _state.config['ai'] = { providers: [] };
        assertStatus(await checks.externalTransfers.evaluate('x'), 'pass', 'no providers');
    });
    await t('pass with internal provider only (ollama)', async () => {
        resetState();
        _state.config['ai'] = { providers: [{ id: 'a', type: 'ollama', url: 'http://ollama:11434', apiKey: 'none' }] };
        assertStatus(await checks.externalTransfers.evaluate('x'), 'pass', 'internal only');
    });
    await t('warn with openai provider + api key', async () => {
        resetState();
        _state.config['ai'] = { providers: [{ id: 'a', type: 'openai', url: 'https://api.openai.com/v1', apiKey: 'sk-...' }] };
        assertStatus(await checks.externalTransfers.evaluate('x'), 'warn', 'openai live');
    });
    await t('warn when agent uses external-prefixed model', async () => {
        resetState();
        _state.config['ai'] = { providers: [] };
        _state.dbRows = [{
            query: /FROM agents WHERE is_published/,
            rows: [{ id: '1', name: 'A', model: 'openai/gpt-4o', organization_id: 'x' }],
        }];
        assertStatus(await checks.externalTransfers.evaluate('x'), 'warn', 'agent model openai/');
    });
    await t('pass when agent uses bare model name without provider prefix', async () => {
        resetState();
        _state.config['ai'] = { providers: [] };
        _state.dbRows = [{
            query: /FROM agents WHERE is_published/,
            rows: [{ id: '1', name: 'A', model: 'gpt-4o', organization_id: 'x' }],
        }];
        assertStatus(await checks.externalTransfers.evaluate('x'), 'pass', 'bare model');
    });

    console.log('\n▶ AIA Art. 50 — AI disclosure');
    await t('not_applicable when 0 agents', async () => {
        resetState();
        _state.dbRows = [{ query: /FROM agents/, rows: [] }];
        assertStatus(await checks.aiDisclosure.evaluate('x'), 'not_applicable', 'no agents');
    });
    await t('warn when agent says "helpful assistant" only', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [{ id: '1', name: 'Agent', system_prompt: 'You are a helpful assistant.', starter_prompts: '[]', config: '{}', organization_id: 'x' }],
        }];
        assertStatus(await checks.aiDisclosure.evaluate('x'), 'warn', 'bare assistant');
    });
    await t('pass when agent says "I am an AI assistant"', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [{ id: '1', name: 'Agent', system_prompt: 'I am an AI assistant that helps.', starter_prompts: '[]', config: '{}', organization_id: 'x' }],
        }];
        assertStatus(await checks.aiDisclosure.evaluate('x'), 'pass', 'explicit disclosure');
    });
    await t('pass when disclosure is inside starter_prompts JSON array', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [{
                id: '1', name: 'Agent',
                system_prompt: 'Short prompt.',
                starter_prompts: JSON.stringify(['Hi, I am an AI assistant']),
                config: '{}', organization_id: 'x',
            }],
        }];
        assertStatus(await checks.aiDisclosure.evaluate('x'), 'pass', 'starter_prompts JSON');
    });

    console.log('\n▶ AIA Art. 13 — Transparency / agent description');
    await t('not_applicable when 0 agents', async () => {
        resetState();
        _state.dbRows = [{ query: /FROM agents/, rows: [] }];
        assertStatus(await checks.transparency.evaluate('x'), 'not_applicable', 'no agents');
    });
    await t('pass with long description', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [{ id: '1', name: 'A', description: 'This agent helps with drafting proposals for clients.', organization_id: 'x' }],
        }];
        assertStatus(await checks.transparency.evaluate('x'), 'pass', 'long desc');
    });
    await t('fail with null description', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [{ id: '1', name: 'A', description: null, organization_id: 'x' }],
        }];
        assertStatus(await checks.transparency.evaluate('x'), 'fail', 'null desc');
    });
    await t('warn when mix of short and long', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [
                { id: '1', name: 'A', description: 'Too short', organization_id: 'x' },
                { id: '2', name: 'B', description: 'This is a sufficiently long description of what it does.', organization_id: 'x' },
            ],
        }];
        assertStatus(await checks.transparency.evaluate('x'), 'warn', 'mixed');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('Harness crashed:', e); process.exit(2); });
