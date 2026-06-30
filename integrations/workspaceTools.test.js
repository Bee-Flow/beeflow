/**
 * Unit tests for the notebook writer tools' persistence checks (BFSF-208).
 *
 * Run: node integrations/workspaceTools.test.js
 *
 * Covers the silent-failure path where setWorkspace() returns false
 * (notebookStore.updateNotebook matches 0 rows, or neither conversation
 * table UPDATE matches a row): notebook_write / notebook_insert /
 * notebook_replace must return a structured { error } with NO _action and
 * NO content (so no workspace_update SSE fires and the LLM never receives
 * a success confirmation), and the unchanged success shape otherwise.
 *
 * No DB needed — we stub `../db` and `../stores/notebookStore` via
 * require.cache (same trick as ticketAssistantTools.test.js).
 */

const assert = require('assert');

// Mutable stub state, flipped per test case below.
const state = {
    // Conversation row returned by getOne (linked-notebook path by default).
    row: { workspace_content: 'old', workspace_notebook_id: 'nb1', user_id: 'u1' },
    // notebookStore.updateNotebook result (linked path).
    updateNotebookResult: false,
    // db.run rowCounts for the legacy path: [agent_conversations, direct_conversations]
    runRowCounts: [0, 0],
};

// Stub ../db (lazy-required inside executeWorkspaceTool).
const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        getOne: async (sql) => {
            // First lookup is agent_conversations; return the row there.
            if (sql.includes('agent_conversations')) return state.row;
            return null;
        },
        run: async () => {
            const rowCount = state.runRowCounts.shift() ?? 0;
            return { rowCount };
        },
    },
};

// Stub ../stores/notebookStore.
const notebookStorePath = require.resolve('../stores/notebookStore');
require.cache[notebookStorePath] = {
    id: notebookStorePath,
    filename: notebookStorePath,
    loaded: true,
    exports: {
        getNotebook: async () => ({ documentContent: 'old' }),
        updateNotebook: async () => state.updateNotebookResult,
    },
};

const { executeWorkspaceTool } = require('./workspaceTools');

const ctx = { conversationId: 'conv-1', userId: 'u1' };

function assertFailureShape(r, label) {
    assert.ok(r.error, `${label}: error is set`);
    assert.ok(/NOT persisted/.test(r.error), `${label}: error explains the write was not persisted`);
    assert.strictEqual(r._action, undefined, `${label}: no _action → no workspace_update SSE`);
    assert.strictEqual(r.content, undefined, `${label}: no content → no workspace_update SSE`);
    assert.strictEqual(r._nbWriteFailed, true, `${label}: rollback marker present`);
    assert.strictEqual(r._revertContent, 'old', `${label}: revert content is last persisted state`);
}

(async () => {
    // ── Linked-notebook path: updateNotebook → false (0 rows) ─────────
    state.updateNotebookResult = false;

    const w = await executeWorkspaceTool('notebook_write', { content: 'hello world' }, ctx);
    assertFailureShape(w, 'notebook_write/linked-fail');

    const i = await executeWorkspaceTool('notebook_insert', { content: 'appended bit', position: 'end' }, ctx);
    assertFailureShape(i, 'notebook_insert/linked-fail');

    const rp = await executeWorkspaceTool('notebook_replace', { find_text: 'old', replace_text: 'new' }, ctx);
    assertFailureShape(rp, 'notebook_replace/linked-fail');

    // ── Linked-notebook path: updateNotebook → true (success unchanged) ─
    state.updateNotebookResult = true;

    const ws = await executeWorkspaceTool('notebook_write', { content: 'hello world', title: 'Doc' }, ctx);
    assert.strictEqual(ws._action, 'workspace_update', 'write/success: _action');
    assert.strictEqual(ws.content, 'hello world', 'write/success: content present');
    assert.ok(ws.message.includes('2 words'), 'write/success: message has word count');
    assert.strictEqual(ws.error, undefined, 'write/success: no error');

    const is = await executeWorkspaceTool('notebook_insert', { content: 'appended bit', position: 'end' }, ctx);
    assert.strictEqual(is._action, 'workspace_update', 'insert/success: _action');
    assert.strictEqual(is.content, 'old\n\nappended bit', 'insert/success: content present');
    assert.ok(/\d+ words/.test(is.message), 'insert/success: message has word count');

    const rs = await executeWorkspaceTool('notebook_replace', { find_text: 'old', replace_text: 'new' }, ctx);
    assert.strictEqual(rs._action, 'workspace_update', 'replace/success: _action');
    assert.strictEqual(rs.content, 'new', 'replace/success: content present');
    assert.ok(/\d+ words/.test(rs.message), 'replace/success: message has word count');

    // ── Legacy path (no workspace_notebook_id): rowCount 1 succeeds ───
    state.row = { workspace_content: 'old', workspace_notebook_id: null, user_id: 'u1' };
    state.runRowCounts = [1];

    const lw = await executeWorkspaceTool('notebook_write', { content: 'hello world' }, ctx);
    assert.strictEqual(lw._action, 'workspace_update', 'write/legacy-success: _action');
    assert.strictEqual(lw.content, 'hello world', 'write/legacy-success: content present');

    // ── Legacy path: rowCount 0 on both tables → failure ──────────────
    state.runRowCounts = [0, 0];

    const lf = await executeWorkspaceTool('notebook_write', { content: 'hello world' }, ctx);
    assertFailureShape(lf, 'notebook_write/legacy-fail');

    console.log('workspaceTools.test.js — all checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
