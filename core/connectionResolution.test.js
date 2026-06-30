/**
 * Unit tests for connectionResolution — the gated per-tool delegation chokepoint.
 * Run: node core/connectionResolution.test.js
 */

const assert = require('assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

// Mock the store so we don't touch a DB; resolveIntegration (real) is pure data.
let mockResolveResult = { mode: 'byo_required', available: false };
const storePath = require.resolve('../stores/integrationConnectionStore');
const m = new Module(storePath);
m.exports = { resolveConnectionForRun: async () => mockResolveResult };
m.loaded = true;
require.cache[storePath] = m;

const cr = require('./connectionResolution');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

async function run() {
    console.log('connectionResolution');

    await test('providerForTool maps tool families to providers', async () => {
        assert.strictEqual(cr.providerForTool('github_create_issue'), 'github');
        assert.strictEqual(cr.providerForTool('youtrack_create_issue'), 'youtrack');
        assert.strictEqual(cr.providerForTool('fireflies_list_transcripts'), 'fireflies');
        assert.strictEqual(cr.providerForTool('gmail_send_email'), 'google');     // OAuth family alias
        assert.strictEqual(cr.providerForTool('outlook_send'), 'microsoft');      // OAuth family alias
        assert.strictEqual(cr.providerForTool('onedrive_list'), 'microsoft');
    });

    await test('providerForTool returns null for non-integration tools', async () => {
        assert.strictEqual(cr.providerForTool('memory_save'), null);
        assert.strictEqual(cr.providerForTool(''), null);
    });

    await test('flag OFF → resolveEffectiveIdentity is inert (null, no DB)', async () => {
        delete process.env.INTEGRATION_CONNECTION_LENDING_ENABLED;
        mockResolveResult = { mode: 'delegated', effectiveUserId: 'owner1', effectiveOrgId: 'orgA', connectionId: 'c1', grantId: 'g1' };
        const r = await cr.resolveEffectiveIdentity({ toolName: 'github_create_issue', runningUserId: 'u2', ownerUserId: 'owner1' });
        assert.strictEqual(r, null);
    });

    await test('flag ON + delegated grant → returns effective owner identity', async () => {
        process.env.INTEGRATION_CONNECTION_LENDING_ENABLED = '1';
        mockResolveResult = { mode: 'delegated', effectiveUserId: 'owner1', effectiveOrgId: 'orgA', connectionId: 'c1', connectionLabel: 'Work', grantId: 'g1' };
        const r = await cr.resolveEffectiveIdentity({ toolName: 'github_create_issue', runningUserId: 'u2', runningUserOrgId: 'orgA', ownerUserId: 'owner1', resourceType: 'agent', resourceId: 'a1' });
        assert.strictEqual(r.integrationUserId, 'owner1');
        assert.strictEqual(r.integrationOrgId, 'orgA');
        assert.strictEqual(r.connectionId, 'c1');
        assert.strictEqual(r.grantId, 'g1');
        assert.strictEqual(r.provider, 'github');
    });

    await test('flag ON + own/byo → null (no override, stays BYO)', async () => {
        process.env.INTEGRATION_CONNECTION_LENDING_ENABLED = '1';
        mockResolveResult = { mode: 'own', effectiveUserId: 'u2' };
        let r = await cr.resolveEffectiveIdentity({ toolName: 'github_create_issue', runningUserId: 'u2', ownerUserId: 'owner1' });
        assert.strictEqual(r, null);
        mockResolveResult = { mode: 'byo_required', available: false };
        r = await cr.resolveEffectiveIdentity({ toolName: 'github_create_issue', runningUserId: 'u2', ownerUserId: 'owner1' });
        assert.strictEqual(r, null);
    });

    await test('never overrides an explicit acting identity (Support inbox)', async () => {
        process.env.INTEGRATION_CONNECTION_LENDING_ENABLED = '1';
        mockResolveResult = { mode: 'delegated', effectiveUserId: 'owner1', effectiveOrgId: 'orgA', connectionId: 'c1', grantId: 'g1' };
        const r = await cr.resolveEffectiveIdentity({ toolName: 'github_create_issue', runningUserId: 'u2', ownerUserId: 'owner1', alreadyActingAs: 'operator9' });
        assert.strictEqual(r, null);
    });

    await test('running on your own resource never borrows from yourself', async () => {
        process.env.INTEGRATION_CONNECTION_LENDING_ENABLED = '1';
        mockResolveResult = { mode: 'delegated', effectiveUserId: 'u2' };
        const r = await cr.resolveEffectiveIdentity({ toolName: 'github_create_issue', runningUserId: 'u2', ownerUserId: 'u2' });
        assert.strictEqual(r, null);
    });

    delete process.env.INTEGRATION_CONNECTION_LENDING_ENABLED;
    console.log(`\nconnectionResolution: ${passed} passed\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
