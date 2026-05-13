/**
 * Unit tests for the visual-builder catalog enrichments.
 *
 * Run: node automation/integrationCatalog.test.js
 *
 * Covers:
 *   1. resolveIntegration() returns the integration id the catalog
 *      endpoint stamps onto each action so the frontend palette can
 *      render the right brand logo.
 *   2. The cycle-detection algorithm used by the editable canvas to
 *      reject drag-created edges that would close a loop. We re-implement
 *      it here (the frontend version lives in DiagramPane.jsx and is
 *      kept identical) so the invariant is testable without a React
 *      test runner.
 */

const assert = require('assert');
const { resolveIntegration } = require('../core/integrationToolMap');

// ── 1. Tool-name → integration id parity ────────────────────────────────
{
    const cases = [
        ['gmail_send_email',         'gmail'],
        ['gmail_list_messages',      'gmail'],
        ['calendar_create_event',    'google_calendar'],
        ['drive_list_files',         'google_drive'],
        ['docs_create',              'google_docs'],
        ['nextcloud_deck_create_card', 'nextcloud_deck'],
        ['nextcloud_calendar_create_event', 'nextcloud_calendar'],
        ['nextcloud_list_files',     'nextcloud'],
        ['ms_calendar_get_events',   'ms_calendar'],
        ['outlook_send',             'outlook'],
        ['onedrive_upload',          'onedrive'],
        ['github_open_pr',           'github'],
        ['linkedin_post',            'linkedin'],
        ['youtrack_create_issue',    'youtrack'],
        ['n8n_workflow_run',         'n8n'],
        ['fireflies_get_transcript', 'fireflies'],
        ['signrequest_create',       'signrequest'],
        ['gamma_create_presentation','gamma'],
        ['web_search',               'web_search'],
        ['kb_search',                'kb_search'],
    ];
    for (const [tool, expected] of cases) {
        const r = resolveIntegration(tool);
        assert.ok(r, `resolveIntegration("${tool}") returned null`);
        assert.strictEqual(r.integration, expected, `${tool} → expected ${expected}, got ${r.integration}`);
    }
}

// Internal tools must NOT resolve to an integration so the palette does
// not show them in the integration group.
{
    const internalTools = ['regex_test', 'notebook_doc_write', 'workspace_get', 'set_reminder'];
    for (const tool of internalTools) {
        const r = resolveIntegration(tool);
        assert.strictEqual(r, null, `${tool} should be internal (no integration), got ${JSON.stringify(r)}`);
    }
}

// ── 2. Cycle detection (mirrors DiagramPane.createsCycle) ───────────────
function createsCycle(def, from, to) {
    const adj = new Map();
    for (const e of (def.edges || [])) {
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from).push(e.to);
    }
    const stack = [to];
    const seen = new Set();
    while (stack.length) {
        const cur = stack.pop();
        if (cur === from) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of (adj.get(cur) || [])) stack.push(next);
    }
    return false;
}

// Simple linear chain: trg → a → b
const chain = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'a', type: 'notification', title: 'a' },
        { id: 'b', type: 'notification', title: 'b' },
    ],
    edges: [
        { from: 'trg', to: 'a' },
        { from: 'a', to: 'b' },
    ],
};

// b → trg would close a cycle.
assert.strictEqual(createsCycle(chain, 'b', 'trg'), true, 'b → trg closes a cycle');
// b → a would also close a cycle.
assert.strictEqual(createsCycle(chain, 'b', 'a'), true, 'b → a closes a cycle');
// a → b already exists; adding it again does not introduce a *new* cycle
// (the cycle check itself just spots loops). The DiagramPane onConnect
// path dedups by checking equality before invoking createsCycle.
assert.strictEqual(createsCycle(chain, 'trg', 'b'), false, 'trg → b is a forward edge, not a cycle');
// trg → trg is a self-loop; the onConnect guard rejects self-loops earlier
// but createsCycle handles it correctly when from === to (target is in
// the seen set immediately, then equality wins on next pop).
assert.strictEqual(createsCycle({ trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] }, 'trg', 'trg'), true, 'self-loop counted as cycle');

console.log('integrationCatalog.test.js — all checks passed');
