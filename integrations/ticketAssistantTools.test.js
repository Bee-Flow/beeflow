/**
 * Unit tests for the deterministic Ticket Assistant tool branches.
 *
 * Run: node integrations/ticketAssistantTools.test.js
 *
 * We can't exercise the AI-backed branches (classify / summarise) without
 * a live model + DB, so this file covers the pure-function paths:
 *   - clean_email
 *   - redact_pii
 *   - process_ticket with runClassify/runSummarise OFF (deterministic
 *     pre-AI stages only)
 *
 * No DB needed — we stub `automationStore` like the existing triggerBus
 * tests so requiring the module doesn't trigger initDB().
 */

const assert = require('assert');

// Stub automationStore (same trick as triggerBus.test.js).
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
    },
};

// Stub userStore so executors that look up org membership don't hit the DB.
const userStorePath = require.resolve('../stores/userStore');
require.cache[userStorePath] = {
    id: userStorePath,
    filename: userStorePath,
    loaded: true,
    exports: {
        getUser: async (uid) => ({ id: uid, organizationId: 'org-1', role: 'user' }),
    },
};

const { executeTicketAssistantTool, isTicketAssistantTool } = require('./ticketAssistantTools');

// ── isTicketAssistantTool ──────────────────────────────────────────────
assert.strictEqual(isTicketAssistantTool('ticket_assistant_clean_email'), true);
assert.strictEqual(isTicketAssistantTool('ticket_assistant_unknown_tool'), true, 'prefix match — executor returns error for unknown name');
assert.strictEqual(isTicketAssistantTool('gmail_search'), false);
assert.strictEqual(isTicketAssistantTool(null), false);

// ── ticket_assistant_clean_email ──────────────────────────────────────
(async () => {
    const noisyHtml = `
<html><body>
<p>Hi team,</p>
<p>Please reset my password.</p>
<div>--<br>Best,<br>Alice</div>
<blockquote>On Mon, someone wrote: previous reply text</blockquote>
</body></html>
    `;
    const r = await executeTicketAssistantTool('ticket_assistant_clean_email', { text: noisyHtml }, 'user-1', null);
    assert.ok(typeof r.cleanedText === 'string', 'cleanedText is a string');
    assert.ok(r.cleanedText.length > 0, 'cleaned text not empty');
    assert.ok(!r.cleanedText.includes('<p>'), 'HTML tags stripped');
    assert.ok(r.cleanedLength <= r.originalLength, 'cleaned length not larger than input');

    // Empty input should produce empty output, not throw.
    const e = await executeTicketAssistantTool('ticket_assistant_clean_email', { text: '' }, 'user-1', null);
    assert.strictEqual(typeof e.cleanedText, 'string');
})();

// ── ticket_assistant_redact_pii ───────────────────────────────────────
(async () => {
    const text = 'Contact alice@example.com or call 06-12345678 about IP 192.168.1.1';
    const r = await executeTicketAssistantTool('ticket_assistant_redact_pii', { text }, 'user-1', null);
    assert.ok(typeof r.redactedText === 'string');
    assert.ok(!r.redactedText.includes('alice@example.com'), 'email redacted');
    assert.ok(typeof r.counts === 'object', 'counts returned');
    // Disable email redaction → email survives.
    const r2 = await executeTicketAssistantTool('ticket_assistant_redact_pii', { text, disable: ['email'] }, 'user-1', null);
    assert.ok(r2.redactedText.includes('alice@example.com'), 'email kept when disabled');
})();

// ── ticket_assistant_process_ticket (deterministic only) ──────────────
(async () => {
    const text = 'Hello\n--\nFrom: Bob <bob@example.com>\nMy phone is 06-11223344.';
    const r = await executeTicketAssistantTool('ticket_assistant_process_ticket', {
        text,
        runClean: true,
        runRedact: true,
        runSummarise: false,
        runClassify: false,
    }, 'user-1', null);
    assert.ok(typeof r.cleaned === 'string', 'cleaned stage ran');
    assert.ok(typeof r.redacted === 'string', 'redact stage ran');
    assert.ok(typeof r.piiCounts === 'object', 'piiCounts present');
    assert.ok(!r.redacted.includes('bob@example.com'), 'email redacted in pipeline');
    // No AI stages were requested.
    assert.strictEqual(r.article, undefined);
    assert.strictEqual(r.category, undefined);

    // Skip clean and redact too — should pass-through.
    const noStages = await executeTicketAssistantTool('ticket_assistant_process_ticket', {
        text: 'plain text',
        runClean: false,
        runRedact: false,
        runSummarise: false,
        runClassify: false,
    }, 'user-1', null);
    assert.strictEqual(noStages.cleaned, undefined);
    assert.strictEqual(noStages.redacted, undefined);

    // Missing text → graceful error.
    const empty = await executeTicketAssistantTool('ticket_assistant_process_ticket', {}, 'user-1', null);
    assert.ok(empty.error, 'error returned for missing text');
})();

// ── unknown tool name ─────────────────────────────────────────────────
(async () => {
    const r = await executeTicketAssistantTool('ticket_assistant_does_not_exist', {}, 'user-1', null);
    assert.ok(r.error && /Unknown/i.test(r.error), 'unknown tool returns error envelope');
})();

// ── final marker ──────────────────────────────────────────────────────
(async () => {
    // Yield long enough for any earlier IIFEs to flush their assertions.
    await new Promise(r => setImmediate(r));
    console.log('ticketAssistantTools.test.js — all checks passed');
})();
