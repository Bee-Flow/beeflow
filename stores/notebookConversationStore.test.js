/**
 * Unit tests for notebookConversationStore — encrypted persistence round-trip
 * for in-notebook / legal-dossier chat. A fake `db` module is injected into
 * require.cache so the store's `require('../db')` picks up an in-memory table.
 * No real database needed.
 *
 * Run: node --test server/stores/notebookConversationStore.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ── In-memory fake of server/db.js ─────────────────────────────────────
// Models a single notebook_conversations table keyed by id, with the
// UNIQUE(notebook_id, user_id) constraint honoured by getOrCreate's
// ON CONFLICT DO NOTHING.
const rows = new Map(); // id -> row

function _findByNbUser(notebookId, userId) {
    for (const r of rows.values()) {
        if (r.notebook_id === notebookId && r.user_id === userId) return r;
    }
    return null;
}

const mockDb = {
    exec: async () => {},
    run: async (sql, params) => {
        if (/INSERT INTO notebook_conversations/i.test(sql)) {
            const [id, notebookId, userId] = params;
            if (_findByNbUser(notebookId, userId)) return { rowCount: 0 }; // ON CONFLICT DO NOTHING
            rows.set(id, { id, notebook_id: notebookId, user_id: userId, messages_json: '[]' });
            return { rowCount: 1 };
        }
        if (/UPDATE notebook_conversations SET messages_json/i.test(sql)) {
            const [stored, id] = params;
            const r = rows.get(id);
            if (!r) return { rowCount: 0 };
            r.messages_json = stored;
            return { rowCount: 1 };
        }
        if (/DELETE FROM notebook_conversations/i.test(sql)) {
            if (/user_id = \$2/i.test(sql)) {
                const [notebookId, userId] = params;
                const r = _findByNbUser(notebookId, userId);
                if (r) rows.delete(r.id);
            } else {
                const [notebookId] = params;
                for (const [id, r] of [...rows]) if (r.notebook_id === notebookId) rows.delete(id);
            }
            return { rowCount: 1 };
        }
        return { rowCount: 0 };
    },
    getOne: async (sql, params) => {
        if (/SELECT \* FROM notebook_conversations/i.test(sql)) {
            const [notebookId, userId] = params;
            return _findByNbUser(notebookId, userId);
        }
        return null;
    },
    getAll: async () => [],
};

const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const store = require('./notebookConversationStore');

// A 32-byte base64 DEK so v2 envelope encryption actually engages.
const DEK = Buffer.alloc(32, 7).toString('base64');

test('append then read returns the same messages (plaintext path, no key)', async () => {
    rows.clear();
    await store.appendMessages('nb1', 'u1', null, [
        { role: 'user', content: 'hallo' },
        { role: 'assistant', content: 'hoi' },
    ]);
    const got = await store.getMessages('nb1', 'u1', null);
    assert.deepStrictEqual(got.map(m => [m.role, m.content]), [['user', 'hallo'], ['assistant', 'hoi']]);
});

test('blob is encrypted at rest when a DEK is present, and round-trips', async () => {
    rows.clear();
    await store.appendMessages('nb2', 'u2', DEK, [{ role: 'user', content: 'BSN 123456782' }]);
    const raw = _findByNbUser('nb2', 'u2').messages_json;
    assert.ok(/_encrypted/.test(raw), 'stored blob should be an encryption envelope');
    assert.ok(!raw.includes('123456782'), 'plaintext PII must not appear in the stored blob');
    const got = await store.getMessages('nb2', 'u2', DEK);
    assert.strictEqual(got[0].content, 'BSN 123456782');
});

test('append accumulates turns across calls', async () => {
    rows.clear();
    await store.appendMessages('nb3', 'u3', DEK, [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
    await store.appendMessages('nb3', 'u3', DEK, [{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }]);
    const got = await store.getMessages('nb3', 'u3', DEK);
    assert.deepStrictEqual(got.map(m => m.content), ['q1', 'a1', 'q2', 'a2']);
});

test('one row per (notebook,user) — concurrent first-writes do not duplicate', async () => {
    rows.clear();
    await Promise.all([
        store.appendMessages('nb4', 'u4', DEK, [{ role: 'user', content: 'x' }]),
        store.appendMessages('nb4', 'u4', DEK, [{ role: 'user', content: 'y' }]),
    ]);
    const matching = [...rows.values()].filter(r => r.notebook_id === 'nb4' && r.user_id === 'u4');
    assert.strictEqual(matching.length, 1);
});

test('deleteForNotebook clears the conversation', async () => {
    rows.clear();
    await store.appendMessages('nb5', 'u5', DEK, [{ role: 'user', content: 'z' }]);
    await store.deleteForNotebook('nb5', 'u5');
    const got = await store.getMessages('nb5', 'u5', DEK);
    assert.deepStrictEqual(got, []);
});

test('isolation: another user cannot read this user’s conversation', async () => {
    rows.clear();
    await store.appendMessages('nb6', 'u6', DEK, [{ role: 'user', content: 'secret' }]);
    const other = await store.getMessages('nb6', 'someone-else', DEK);
    assert.deepStrictEqual(other, []);
});
