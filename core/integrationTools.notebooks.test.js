/**
 * Unit tests for the BFSF-207 notebook tool gates.
 *
 * Run: SESSION_SECRET=test-session-secret-at-least-32-chars-long node core/integrationTools.notebooks.test.js
 *
 * DB-free: follows the monkeypatch style of core/entitlements.test.js — the
 * lazy data sources (entitlements resolver, configStore, userStore,
 * auth/permissions, betaFeatures, workspaceTools executor) are patched on the
 * cached module objects so we test the gating, not the DB. Modules whose
 * functions are destructured at load time (hasPermission, userHasBetaFeature,
 * executeWorkspaceTool) are patched BEFORE requiring the modules under test.
 */

const assert = require('assert');

// ── Patch destructure-at-load deps BEFORE requiring the modules under test ──
const permissions = require('../auth/permissions');
let mockHasPermission = async () => true;
permissions.hasPermission = (...a) => mockHasPermission(...a);

const betaFeatures = require('./betaFeatures');
betaFeatures.userHasBetaFeature = async () => false;

const workspaceTools = require('../integrations/workspaceTools');
let workspaceExecCalls = 0;
workspaceTools.executeWorkspaceTool = async () => { workspaceExecCalls++; return { success: true }; };

// ── Patch lazy-required data sources (looked up per call) ──────────────────
const configStore = require('../stores/configStore');
configStore.getConfig = async () => null;   // feature_notebooks_enabled null ⇒ enabled (!== false)
configStore.getSecret = async () => null;

const userStore = require('../stores/userStore');
userStore.getUser = async () => ({ id: 'u1', organizationId: 'o1', groups: [], role: 'user' });
userStore.getOrganization = async () => ({ enabledIntegrations: null });
userStore.getAllGroups = async () => [];
userStore.getAppPassword = async () => null;

try {
    const mcpManager = require('./mcpManager');
    mcpManager.getAllToolsAsOpenAI = async () => [];
} catch (_) { /* appendMcpTools fails closed on its own */ }

const ent = require('./entitlements');
const { getIntegrationTools } = require('./integrationTools');
const { executeTool } = require('./toolDispatcher');

// Crafted resolver snapshot — real snapshotHas falls back to the arrayified
// effective buckets when `_sets` is absent, so plain arrays are enough.
function snap({ core = [], integration = [], degraded = false } = {}) {
    return {
        degraded,
        tier: 'enterprise',
        ceiling: { core, integration, beta: [] },
        effective: { core, integration, beta: [] },
    };
}

const session = { user: { id: 'u1', role: 'user' } };
const toolNames = (r) => r.tools.map(t => t.function.name);

const run = async () => {
    // (a) entitled user (snapshot grants 'notebooks' + use_notebooks RBAC) → tools present
    ent.resolveEntitlements = async () => snap({ core: ['notebooks'] });
    mockHasPermission = async () => true;
    let res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false });
    assert.ok(toolNames(res).includes('notebook_read'), 'entitled: notebook_read present');
    assert.ok(toolNames(res).includes('notebook_write'), 'entitled: notebook_write present');
    console.log('✓ entitled user gets notebook tools');

    // (b) non-entitled (snapshot without 'notebooks' in effective.core) → absent
    ent.resolveEntitlements = async () => snap({ core: [] });
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false });
    assert.ok(!toolNames(res).some(n => n.startsWith('notebook_')), 'non-entitled: no notebook tools');
    console.log('✓ non-entitled user gets no notebook tools');

    // (b2) entitled capability but missing use_notebooks RBAC → absent
    ent.resolveEntitlements = async () => snap({ core: ['notebooks'] });
    mockHasPermission = async (userId, perm) => perm !== 'use_notebooks';
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false });
    assert.ok(!toolNames(res).some(n => n.startsWith('notebook_')), 'no use_notebooks RBAC: no notebook tools');
    mockHasPermission = async () => true;
    console.log('✓ missing use_notebooks permission withholds notebook tools');

    // (c) degraded snapshot → absent (fail closed)
    ent.resolveEntitlements = async () => snap({ core: ['notebooks'], degraded: true });
    res = await getIntegrationTools({ userId: 'u1', session, isAdmin: false });
    assert.ok(!toolNames(res).some(n => n.startsWith('notebook_')), 'degraded snapshot: no notebook tools');
    console.log('✓ degraded snapshot fails closed');

    // (d) dispatcher backstop: non-entitled execution → graceful refusal, no write
    ent.hasCapability = async () => false;
    workspaceExecCalls = 0;
    let out = await executeTool('notebook_write', { content: 'x' }, { userId: 'u1', session, conversationId: 'c1' });
    assert.ok(out && typeof out.error === 'string' && out.error.includes('notebook is not available'),
        `backstop refusal returned (got ${JSON.stringify(out)})`);
    assert.strictEqual(workspaceExecCalls, 0, 'backstop: executeWorkspaceTool never called');
    console.log('✓ dispatcher backstop refuses non-entitled execution');

    // (d2) dispatcher backstop: entitled execution still passes through
    ent.hasCapability = async () => true;
    out = await executeTool('notebook_write', { content: 'x' }, { userId: 'u1', session, conversationId: 'c1' });
    assert.strictEqual(out && out.success, true, 'entitled dispatch reaches the executor');
    assert.strictEqual(workspaceExecCalls, 1, 'entitled dispatch called executeWorkspaceTool once');
    console.log('✓ dispatcher backstop passes entitled execution through');

    console.log('\nALL NOTEBOOK GATE TESTS PASSED');
};

run().then(() => process.exit(0)).catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
