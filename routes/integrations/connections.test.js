/**
 * API tests for routes/integrations/connections.js — focuses on wiring + the
 * security-critical org-isolation on the share endpoint. The store / userStore
 * / permissions modules are mocked; a real express app is exercised over http.
 *
 * Run: node routes/integrations/connections.test.js
 */

const assert = require('assert');
const Module = require('module');
const express = require('express');

process.env.NODE_ENV = 'test';

// ── Mocks injected before the route loads ───────────────────────────
function mock(id, exports) {
    const p = require.resolve(id);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const SENTINEL = '__default_org__';
const resolveOrgId = (o) => (o && String(o).trim()) || SENTINEL;

const state = {
    connections: {},   // id -> shaped connection
    users: {},         // id -> { organizationId }
    groups: [],        // [{ id, organizationId }]
    grants: [],
    lastShare: null,
    resolveResult: { mode: 'byo_required', available: false },
};

mock('../../auth/permissions', {
    requireActiveOrgForMutations: () => (req, res, next) => next(),
});
mock('../../stores/userStore', {
    getUser: async (id) => state.users[id] || null,
    getAllGroups: async () => state.groups,
});
mock('../../stores/integrationConnectionStore', {
    resolveOrgId,
    listConnectionsForUser: async (uid) => Object.values(state.connections).filter(c => c.ownerUserId === uid),
    getConnection: async (id) => state.connections[id] || null,
    createConnection: async (args) => {
        const id = `c-${Object.keys(state.connections).length + 1}`;
        const conn = { id, ownerUserId: args.ownerUserId, orgId: resolveOrgId(args.orgId), provider: args.provider, label: args.label, kind: args.kind, isDefault: true };
        state.connections[id] = conn;
        return conn;
    },
    shareConnection: async (args) => { state.lastShare = args; const g = { id: `g-${state.grants.length + 1}`, ...args }; state.grants.push(g); return g; },
    listGrants: async (f = {}) => state.grants.filter(g => (!f.connectionId || g.connectionId === f.connectionId)),
    revokeGrant: async () => true,
    deleteConnection: async (id) => { delete state.connections[id]; return true; },
    renameConnection: async () => true,
    setDefault: async () => true,
    updateConnectionSecret: async () => true,
    resolveConnectionForRun: async ({ provider }) => ({ ...state.resolveResult, provider, connectionLabel: state.resolveResult.connectionLabel }),
});

const router = require('./connections');

// ── Test app: inject a session from the x-user header ───────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    const uid = req.headers['x-user'];
    const role = req.headers['x-role'];
    req.session = uid ? { user: { id: uid, role: role || 'user' } } : {};
    next();
});
app.use('/api/integrations/connections', router);

let server, base;
async function http(method, path, { user, role, body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-user'] = user;
    if (role) headers['x-role'] = role;
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch (_) {}
    return { status: res.status, json };
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

async function run() {
    console.log('connections API');
    await new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });

    // Seed: owner u1 in orgA; teammate u2 in orgA; outsider u3 in orgB
    state.users = { u1: { organizationId: 'orgA' }, u2: { organizationId: 'orgA' }, u3: { organizationId: 'orgB' } };

    await test('401 without a session', async () => {
        const r = await http('GET', '/api/integrations/connections');
        assert.strictEqual(r.status, 401);
    });

    await test('POST / creates a connection scoped to the caller org', async () => {
        const r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'slack', label: 'Work', kind: 'api_key', secret: { api_key: 'xoxb-1' } } });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.json.connection.ownerUserId, 'u1');
        assert.strictEqual(r.json.connection.orgId, 'orgA');
    });

    await test('POST / rejects an invalid provider', async () => {
        const r = await http('POST', '/api/integrations/connections', { user: 'u1', body: { provider: 'bad provider!!' } });
        assert.strictEqual(r.status, 400);
    });

    await test('share to a SAME-org user → 201', async () => {
        const r = await http('POST', '/api/integrations/connections/c-1/grants', { user: 'u1', body: { granteeType: 'user', granteeId: 'u2' } });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(state.lastShare.granteeId, 'u2');
    });

    await test('share to a CROSS-org user → 403 (hard isolation)', async () => {
        const r = await http('POST', '/api/integrations/connections/c-1/grants', { user: 'u1', body: { granteeType: 'user', granteeId: 'u3' } });
        assert.strictEqual(r.status, 403);
        assert.match(r.json.error, /Cross-org/);
    });

    await test('share a connection you do NOT own → 403 Forbidden', async () => {
        const r = await http('POST', '/api/integrations/connections/c-1/grants', { user: 'u2', body: { granteeType: 'user', granteeId: 'u1' } });
        assert.strictEqual(r.status, 403);
        assert.match(r.json.error, /Forbidden/);
    });

    await test('share with resourceType but no resourceId → 400', async () => {
        const r = await http('POST', '/api/integrations/connections/c-1/grants', { user: 'u1', body: { granteeType: 'user', granteeId: 'u2', resourceType: 'agent' } });
        assert.strictEqual(r.status, 400);
    });

    await test('GET /required reports byo-missing vs lent per provider', async () => {
        state.resolveResult = { mode: 'byo_required', available: false };
        let r = await http('GET', '/api/integrations/connections/required?providers=slack,github', { user: 'u2' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.requiresConnection.length, 2);
        state.resolveResult = { mode: 'delegated', available: true, connectionLabel: 'Owner Slack' };
        r = await http('GET', '/api/integrations/connections/required?providers=slack', { user: 'u2' });
        assert.strictEqual(r.json.lent.length, 1);
        assert.strictEqual(r.json.lent[0].connectionLabel, 'Owner Slack');
    });

    await test('DELETE /:id blocked while shared, allowed with ?force=1', async () => {
        state.grants = [{ id: 'g-x', connectionId: 'c-1' }];
        let r = await http('DELETE', '/api/integrations/connections/c-1', { user: 'u1' });
        assert.strictEqual(r.status, 409);
        r = await http('DELETE', '/api/integrations/connections/c-1?force=1', { user: 'u1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.deleted, true);
    });

    console.log(`\nconnections API: ${passed} passed\n`);
    server.close();
}

run().catch(err => { console.error(err); if (server) server.close(); process.exit(1); });
