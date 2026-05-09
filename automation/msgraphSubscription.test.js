/**
 * Unit tests for the MS Graph subscription provisioning + revocation
 * helpers in triggerBus.js.
 *
 * Run: node automation/msgraphSubscription.test.js
 *
 * No DB required. Stubs `automationStore` (so triggerBus loads) and patches
 * global.fetch so we can assert the exact request that gets sent to Graph.
 */

const assert = require('assert');

// Stub automationStore before triggerBus loads. Only the methods triggerBus
// touches at module load / from the helpers under test need stubs.
const storePath = require.resolve('../stores/automationStore');
require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
        getSubscriptionsForProvider: async () => [],
        updateSubscription: async () => null,
        getPollingSubscriptions: async () => [],
        getExpiringSubscriptions: async () => [],
        incrementSubscriptionFailures: async () => ({ consecutiveFailures: 0, errorNotifiedAt: null }),
        resetSubscriptionFailures: async () => null,
        getAutomation: async () => null,
    },
};

// Stable env so clientState HMAC is deterministic across runs.
process.env.MSGRAPH_CLIENT_STATE_SECRET = 'test-secret-fixture';
delete process.env.PUBLIC_BASE_URL;
delete process.env.SERVER_PUBLIC_URL;

const triggerBus = require('./triggerBus');

const SAMPLE_SESSION = { accessToken: 'test-bearer', refreshToken: 'rt' };

(async () => {
    // ── buildClientState is pure HMAC; same inputs ⇒ same output ─────────
    const stateA = triggerBus.buildClientState('user-1', 'automation-1');
    const stateB = triggerBus.buildClientState('user-1', 'automation-1');
    const stateC = triggerBus.buildClientState('user-2', 'automation-1');
    assert.strictEqual(typeof stateA, 'string');
    assert.strictEqual(stateA.length, 64, 'HMAC-SHA256 hex digest is 64 chars');
    assert.strictEqual(stateA, stateB, 'deterministic for same inputs');
    assert.notStrictEqual(stateA, stateC, 'differs across users');

    // ── provisionSubscription returns null when PUBLIC_BASE_URL missing ──
    {
        const result = await triggerBus.provisionSubscription(
            { id: 's1', provider: 'msgraph', userId: 'u1', automationId: 'a1', eventType: 'mail.new' },
            SAMPLE_SESSION,
        );
        assert.strictEqual(result, null, 'no public URL → null (caller falls back to polling)');
    }

    // ── provisionSubscription returns null for unsupported eventType ─────
    {
        process.env.PUBLIC_BASE_URL = 'https://test.example.com';
        const result = await triggerBus.provisionSubscription(
            { id: 's1', provider: 'msgraph', userId: 'u1', automationId: 'a1', eventType: 'something.unknown' },
            SAMPLE_SESSION,
        );
        assert.strictEqual(result, null, 'unmapped eventType → null');
        delete process.env.PUBLIC_BASE_URL;
    }

    // ── provisionSubscription POSTs the right body and returns externalRef ──
    {
        process.env.PUBLIC_BASE_URL = 'https://test.example.com/'; // trailing slash to verify trim
        let captured = null;
        const originalFetch = global.fetch;
        global.fetch = async (url, opts) => {
            captured = { url, opts };
            return {
                ok: true,
                status: 201,
                json: async () => ({
                    id: 'graph-sub-id-xyz',
                    expirationDateTime: '2099-01-01T00:00:00.000Z',
                }),
            };
        };

        try {
            const result = await triggerBus.provisionSubscription(
                { id: 's1', provider: 'msgraph', userId: 'u1', automationId: 'a1', eventType: 'mail.new' },
                SAMPLE_SESSION,
            );
            assert.ok(result, 'returns shape on success');
            assert.strictEqual(result.externalRef, 'graph-sub-id-xyz');
            assert.strictEqual(result.expiresAt, '2099-01-01T00:00:00.000Z');
            assert.strictEqual(typeof result.clientState, 'string');
            assert.strictEqual(result.clientState.length, 64);

            assert.strictEqual(captured.url, 'https://graph.microsoft.com/v1.0/subscriptions');
            assert.strictEqual(captured.opts.method, 'POST');
            assert.strictEqual(captured.opts.headers.Authorization, 'Bearer test-bearer');
            const body = JSON.parse(captured.opts.body);
            assert.strictEqual(body.changeType, 'created');
            assert.strictEqual(body.resource, "me/mailFolders('Inbox')/messages");
            assert.strictEqual(
                body.notificationUrl,
                'https://test.example.com/api/automation/events/msgraph',
                'trims trailing slash before appending path',
            );
            assert.ok(body.expirationDateTime, 'sets expirationDateTime');
            assert.strictEqual(
                body.clientState,
                triggerBus.buildClientState('u1', 'a1'),
                'request body uses our HMAC clientState',
            );
        } finally {
            global.fetch = originalFetch;
            delete process.env.PUBLIC_BASE_URL;
        }
    }

    // ── provisionSubscription handles HTTP failure gracefully ────────────
    {
        process.env.PUBLIC_BASE_URL = 'https://test.example.com';
        const originalFetch = global.fetch;
        global.fetch = async () => ({
            ok: false,
            status: 401,
            text: async () => '{"error":"unauthorized"}',
        });
        try {
            const result = await triggerBus.provisionSubscription(
                { id: 's1', provider: 'msgraph', userId: 'u1', automationId: 'a1', eventType: 'mail.new' },
                SAMPLE_SESSION,
            );
            assert.strictEqual(result, null, 'HTTP 401 → null (caller logs)');
        } finally {
            global.fetch = originalFetch;
            delete process.env.PUBLIC_BASE_URL;
        }
    }

    // ── revokeSubscription DELETEs the right URL ─────────────────────────
    {
        let captured = null;
        const originalFetch = global.fetch;
        global.fetch = async (url, opts) => {
            captured = { url, opts };
            return { ok: true, status: 204 };
        };
        try {
            const ok = await triggerBus.revokeSubscription(
                { id: 's1', provider: 'msgraph', externalRef: 'graph-sub-id-xyz' },
                SAMPLE_SESSION,
            );
            assert.strictEqual(ok, true);
            assert.strictEqual(captured.url, 'https://graph.microsoft.com/v1.0/subscriptions/graph-sub-id-xyz');
            assert.strictEqual(captured.opts.method, 'DELETE');
        } finally {
            global.fetch = originalFetch;
        }
    }

    // ── revokeSubscription treats 404 as success (already gone) ──────────
    {
        const originalFetch = global.fetch;
        global.fetch = async () => ({ ok: false, status: 404 });
        try {
            const ok = await triggerBus.revokeSubscription(
                { id: 's1', provider: 'msgraph', externalRef: 'gone' },
                SAMPLE_SESSION,
            );
            assert.strictEqual(ok, true, '404 is treated as already-gone');
        } finally {
            global.fetch = originalFetch;
        }
    }

    // ── revokeSubscription is a no-op when externalRef missing ───────────
    {
        let called = false;
        const originalFetch = global.fetch;
        global.fetch = async () => { called = true; return { ok: true }; };
        try {
            const ok = await triggerBus.revokeSubscription(
                { id: 's1', provider: 'msgraph', externalRef: null },
                SAMPLE_SESSION,
            );
            assert.strictEqual(ok, false);
            assert.strictEqual(called, false, 'no fetch when nothing to revoke');
        } finally {
            global.fetch = originalFetch;
        }
    }

    console.log('msgraphSubscription.test.js — all checks passed');
})().catch(err => {
    console.error('[msgraphSubscription.test] failed:', err);
    process.exit(1);
});
