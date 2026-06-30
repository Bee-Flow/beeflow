/**
 * Route-table equivalence smoke for routes/automation.js (§WS5 #4).
 *
 * routes/automation.js is split into contiguous sub-routers (automation/*.js)
 * mounted in original order. Express is first-match, so the ONE invariant that
 * must hold is: the flattened (method, path) sequence — including where the auth
 * middleware sits — is byte-for-byte identical to the pre-split single router.
 * This test mocks every dependency (no DB/network/timers), loads the router,
 * walks router.stack recursively (into mounted sub-routers), and asserts the
 * ordered table equals the frozen baseline. A reorder, a dropped route, or a
 * sub-router mounted out of order fails here.
 *
 * Run: node --test routes/automation.routetable.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const SERVER = path.resolve(__dirname, '..');

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}
const noopMw = () => (req, res, next) => next();

// Mock every module routes/automation.js (and its sub-routers) require, so a
// bare require never hits the DB / network / background timers.
mock(path.join(SERVER, 'stores/automationStore'), {});
mock(path.join(SERVER, 'stores/configStore'), {});
mock(path.join(SERVER, 'automation/cron'), {});
mock(path.join(SERVER, 'automation/validate'), { validateDefinition: () => ({ valid: true }) });
mock(path.join(SERVER, 'automation/summarise'), {});
mock(path.join(SERVER, 'automation/deliverableEvents'), {});
mock(path.join(SERVER, 'automation/toolRegistry'), {});
mock(path.join(SERVER, 'automation/sideEffectMap'), {});
mock(path.join(SERVER, 'automation/outputSchemas'), {});
mock(path.join(SERVER, 'automation/triggerBus'), {});
mock(path.join(SERVER, 'core/integrationToolMap'), {});
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => noopMw() });
mock(path.join(SERVER, 'automation/portability'), {});
mock(path.join(SERVER, 'core/betaFeatures'), { requireBetaFeature: () => noopMw() });
mock(path.join(SERVER, 'auth'), { requireActiveOrgForMutations: () => noopMw() });

function flatten(stack, out) {
    for (const layer of stack) {
        if (layer.route) {
            const methods = Object.keys(layer.route.methods)
                .filter(m => layer.route.methods[m])
                .map(m => m.toUpperCase())
                .sort()
                .join(',');
            out.push(`${methods} ${layer.route.path}`);
        } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
            flatten(layer.handle.stack, out);
        } else {
            out.push(`USE:${layer.handle && layer.handle.name ? layer.handle.name : 'anonymous'}`);
        }
    }
    return out;
}

// Frozen baseline captured from the pre-split single router. The two `USE:anonymous`
// entries are requireBetaFeature('automations') + requireActiveOrgForMutations().
const EXPECTED = [
    'POST /webhook/:slug',
    'POST /events/gmail',
    'POST /events/nextcloud',
    'POST /events/msgraph',
    'POST /events/github',
    'USE:requireAuth',
    'USE:anonymous',
    'USE:anonymous',
    'GET /catalog',
    'GET /catalog/sample/:tool',
    'GET /',
    'POST /',
    'GET /templates',
    'GET /templates/:id',
    'POST /import',
    'GET /:id',
    'GET /:id/export',
    'PUT /:id',
    'DELETE /:id',
    'POST /:id/activate',
    'POST /:id/deactivate',
    'POST /:id/run',
    'POST /:id/diagnose-trigger',
    'POST /:id/dry-run',
    'POST /:id/steps/:stepId/run',
    'GET /_runs/active',
    'POST /_schedule/preview',
    'GET /:id/runs',
    'GET /_runs/recent',
    'GET /_runs/facets',
    'GET /_runs/stream',
    'GET /:id/versions',
    'GET /:id/versions/:versionId/diff/:otherVersionId',
    'GET /:id/versions/:versionId',
    'POST /:id/versions/:versionId/restore',
    'POST /:id/webhook',
    'GET /:id/webhooks',
    'POST /:id/webhook/:slug/rotate',
    'DELETE /:id/webhook/:slug',
    'GET /runs/:id',
    'GET /runs/:id/steps',
    'POST /:id/runs/:runId/retry',
    'POST /runs/:runId/approve-step',
    'POST /runs/:runId/cancel',
    'POST /runs/:id/approve',
    'POST /:id/agent-invoke',
    'POST /:id/webhook/:slug/test',
];

test('automation router loads and exposes the exact baseline route table in order', () => {
    const router = require(path.join(SERVER, 'routes/automation'));
    assert.ok(typeof router === 'function', 'router export should be an express router (function)');
    const table = flatten(router.stack, []);
    assert.deepStrictEqual(table, EXPECTED);
});

test('every relative require() across the facade + sub-routers resolves (catches the one-dir-deeper path break)', () => {
    // node --check / no-undef / the route-table walk all miss a wrong require()
    // PATH inside a handler body (it only throws when the handler runs). The
    // §WS5 #4 split moved files one dir deeper, so inline `require('../x')` had
    // to become `require('../../x')`. Resolve every relative specifier from its
    // file's real directory so a bad path fails here, not in production.
    const fs = require('fs');
    const files = [
        'routes/automation.js',
        'routes/automation/events.js',
        'routes/automation/catalog.js',
        'routes/automation/crud.js',
        'routes/automation/runs.js',
        'routes/automation/versions.js',
        'routes/automation/webhooksAndRunOps.js',
    ];
    const re = /require\((["'])(\.[^"']+)\1\)/g;
    const unresolved = [];
    for (const rel of files) {
        const abs = path.join(SERVER, rel);
        const dir = path.dirname(abs);
        const src = fs.readFileSync(abs, 'utf8');
        let m;
        while ((m = re.exec(src))) {
            try { require.resolve(path.resolve(dir, m[2])); }
            catch { unresolved.push(`${rel} -> ${m[2]}`); }
        }
    }
    assert.deepStrictEqual(unresolved, [], `unresolved relative requires:\n${unresolved.join('\n')}`);
});

test('public event routes precede the auth middleware (events stay unauthenticated)', () => {
    const router = require(path.join(SERVER, 'routes/automation'));
    const table = flatten(router.stack, []);
    const authIdx = table.indexOf('USE:requireAuth');
    const lastEventIdx = table.lastIndexOf('POST /events/github');
    const firstAuthedIdx = table.indexOf('GET /catalog');
    assert.ok(authIdx > lastEventIdx, 'requireAuth must come after all /events/* routes');
    assert.ok(firstAuthedIdx > authIdx, 'authed routes (/catalog) must come after requireAuth');
});
