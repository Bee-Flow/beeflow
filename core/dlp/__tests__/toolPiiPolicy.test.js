/**
 * Unit tests for the per-tool-class PII block policy helpers in orgShield.js:
 *   - classifyToolClass(toolName)            external | internal
 *   - isBlockedForTool(name, cats, policy)   refuse decision
 *   - synthesizeToolPiiPolicy(shield)        read-time shape + legacy absorb
 *
 * Hermetic: stub the configStore module in require.cache so requiring
 * orgShield never pulls in the DB layer. integrationToolMap (the real
 * external-vs-internal classifier) loads for real — it is pure data.
 *
 * Run: node server/core/dlp/__tests__/toolPiiPolicy.test.js
 */

const assert = require('assert');
const path = require('path');

// ── Stub configStore (top-level require in orgShield) ──────────────────
const cfgPath = path.resolve(__dirname, '../../../stores/configStore.js');
require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: { async getConfig() { return null; }, async setConfig() { return true; }, async getAllConfig() { return {}; } },
};

const { classifyToolClass, isBlockedForTool, synthesizeToolPiiPolicy } = require('../../orgShield');

let passed = 0;
function check(label, cond) {
    assert.ok(cond, label);
    passed++;
    console.log(`  ✓ ${label}`);
}

console.log('classifyToolClass:');
check('gmail_send → external', classifyToolClass('gmail_send') === 'external');
check('ms_calendar_create → external', classifyToolClass('ms_calendar_create') === 'external');
check('drive_list → external', classifyToolClass('drive_list') === 'external');
check('agent_search → external (web-search override)', classifyToolClass('agent_search') === 'external');
check('web_search → external', classifyToolClass('web_search') === 'external');
check('n8n_execute → external', classifyToolClass('n8n_execute') === 'external');
check('notebook_read → internal', classifyToolClass('notebook_read') === 'internal');
check('set_reminder → internal', classifyToolClass('set_reminder') === 'internal');
check('workspace_write → internal', classifyToolClass('workspace_write') === 'internal');
check('regex_generate → internal', classifyToolClass('regex_generate') === 'internal');
check('kb_search → internal (isLocal)', classifyToolClass('kb_search') === 'internal');
check('unknown_tool → internal', classifyToolClass('some_unknown_tool') === 'internal');
check('empty name → internal', classifyToolClass('') === 'internal');

console.log('isBlockedForTool:');
const extEmail = { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } };
{
    const r = isBlockedForTool('gmail_send', ['Email', 'Person'], extEmail);
    check('external tool + blocked category → blocked', r.blocked === true);
    check('  reports only the matched category', JSON.stringify(r.blockedCategories) === JSON.stringify(['Email']));
    check('  reports toolClass=external', r.toolClass === 'external');
}
check('external tool, category not in list → not blocked', isBlockedForTool('gmail_send', ['Person'], extEmail).blocked === false);
check('internal tool not covered by external policy → not blocked', isBlockedForTool('notebook_read', ['Email'], extEmail).blocked === false);
check('empty detected categories → not blocked', isBlockedForTool('gmail_send', [], extEmail).blocked === false);
check('null policy → not blocked', isBlockedForTool('gmail_send', ['Email'], null).blocked === false);
{
    const intPol = { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } };
    check('internal tool + internal block list → blocked', isBlockedForTool('notebook_read', ['Email'], intPol).blocked === true);
    check('external tool not covered by internal-only policy → not blocked', isBlockedForTool('gmail_send', ['Email'], intPol).blocked === false);
}

console.log('synthesizeToolPiiPolicy:');
const empty = { external: { blockCategories: [] }, internal: { blockCategories: [] } };
check('no field + no legacy → empty shape', JSON.stringify(synthesizeToolPiiPolicy({})) === JSON.stringify(empty));
check('null shield → empty shape', JSON.stringify(synthesizeToolPiiPolicy(null)) === JSON.stringify(empty));
{
    const r = synthesizeToolPiiPolicy({ toolPiiPolicy: { external: { blockCategories: ['Email', 123, 'Person'] }, internal: { blockCategories: ['Phone'] } } });
    check('explicit policy normalized (non-strings dropped)', JSON.stringify(r.external.blockCategories) === JSON.stringify(['Email', 'Person']));
    check('  internal preserved', JSON.stringify(r.internal.blockCategories) === JSON.stringify(['Phone']));
}
{
    const r = synthesizeToolPiiPolicy({ webSearchGuardEnabled: true, webSearchGuardPiiCategories: ['Email'] });
    check('legacy absorb when guard enabled → external seeded', JSON.stringify(r.external.blockCategories) === JSON.stringify(['Email']));
    check('  internal stays empty', JSON.stringify(r.internal.blockCategories) === JSON.stringify([]));
}
{
    const r = synthesizeToolPiiPolicy({ webSearchGuardEnabled: true, webSearchGuardPiiCategories: [], piiDetectionCategories: ['Person'] });
    check('legacy absorb falls back to piiDetectionCategories', JSON.stringify(r.external.blockCategories) === JSON.stringify(['Person']));
}
{
    // MF-3 regression: monitor-only org (categories set, guard DISABLED) must NOT become a blocking org.
    const r = synthesizeToolPiiPolicy({ webSearchGuardEnabled: false, webSearchGuardPiiCategories: ['Email'] });
    check('monitor-only org (guard disabled) → NOT absorbed (empty)', JSON.stringify(r) === JSON.stringify(empty));
}
{
    const r = synthesizeToolPiiPolicy({ toolPiiPolicy: { external: 'nope' } });
    check('malformed external coerces to empty', JSON.stringify(r.external.blockCategories) === JSON.stringify([]));
}

console.log(`\nAll ${passed} assertions passed.`);
