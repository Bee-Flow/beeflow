/**
 * Require-resolution guard for the automationStore split (§WS5 #3).
 *
 * automationStore.js was split into stores/automationStore/*.js — one dir
 * deeper. Top-level requires were fixed by the split, but INLINE/lazy
 * `require('../x')` calls inside functions had to become `require('../../x')`.
 * A bad require PATH only throws when that function runs, so unit tests that
 * don't hit the path (and `node --check`/no-undef) miss it — exactly how
 * `steps.js -> ../automation/stepContract` shipped broken and silently
 * emptied the builder catalog's reusable Steps. This resolves every relative
 * require in the split dir so a wrong path fails here, not in production.
 *
 * Run: node --test stores/automationStore.requires.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('every relative require() in stores/automationStore/ resolves', () => {
    const dir = path.join(__dirname, 'automationStore');
    const re = /require\((["'])(\.[^"']+)\1\)/g;
    const unresolved = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
        const abs = path.join(dir, name);
        const src = fs.readFileSync(abs, 'utf8');
        let m;
        while ((m = re.exec(src))) {
            try { require.resolve(path.resolve(dir, m[2])); }
            catch { unresolved.push(`${name} -> ${m[2]}`); }
        }
    }
    assert.deepStrictEqual(unresolved, [], `unresolved relative requires:\n${unresolved.join('\n')}`);
});
