/**
 * Unit tests for license/tiers.js
 *
 * Run: node license/tiers.test.js
 */

const assert = require('assert');
const t = require('./tiers');

// ── Hierarchy & validity ────────────────────────────────────────────────
assert.deepStrictEqual(t.TIER_HIERARCHY, ['community', 'pro', 'enterprise', 'full']);
assert.strictEqual(t.isValidTier('community'), true);
assert.strictEqual(t.isValidTier('pro'), true);
assert.strictEqual(t.isValidTier('enterprise'), true);
assert.strictEqual(t.isValidTier('full'), true);
assert.strictEqual(t.isValidTier('starter'), false);
assert.strictEqual(t.isValidTier(undefined), false);
assert.strictEqual(t.isValidTier(null), false);

// ── Rank ────────────────────────────────────────────────────────────────
assert.strictEqual(t.tierRank('community'), 0);
assert.strictEqual(t.tierRank('pro'), 1);
assert.strictEqual(t.tierRank('enterprise'), 2);
assert.strictEqual(t.tierRank('full'), 3);
assert.strictEqual(t.tierRank('bogus'), -1);

// ── tierAtLeast ─────────────────────────────────────────────────────────
assert.strictEqual(t.tierAtLeast('pro', 'community'), true);
assert.strictEqual(t.tierAtLeast('pro', 'pro'), true);
assert.strictEqual(t.tierAtLeast('pro', 'enterprise'), false);
assert.strictEqual(t.tierAtLeast('full', 'enterprise'), true);
assert.strictEqual(t.tierAtLeast('community', 'pro'), false);
assert.strictEqual(t.tierAtLeast('bogus', 'community'), false, 'unknown actual tier should not satisfy any requirement');
assert.strictEqual(t.tierAtLeast('community', 'bogus'), false, 'unknown required tier should be rejected');

// ── Feature inheritance ─────────────────────────────────────────────────
const community = t.getFeaturesForTier('community');
const pro = t.getFeaturesForTier('pro');
const enterprise = t.getFeaturesForTier('enterprise');
const full = t.getFeaturesForTier('full');

assert.ok(community.includes('chat_basic'));
assert.ok(community.includes('nextcloud_basic'));
assert.ok(!community.includes('automations'));

// pro inherits community
for (const f of community) assert.ok(pro.includes(f), `pro should inherit community feature ${f}`);
assert.ok(pro.includes('automations'));
assert.ok(pro.includes('multi_user'));
assert.ok(!pro.includes('guardrails_dlp'));

// enterprise inherits pro
for (const f of pro) assert.ok(enterprise.includes(f), `enterprise should inherit pro feature ${f}`);
assert.ok(enterprise.includes('guardrails_dlp'));
assert.ok(enterprise.includes('compliance_hub_gdpr'));
assert.ok(!enterprise.includes('white_label'));

// full inherits enterprise
for (const f of enterprise) assert.ok(full.includes(f), `full should inherit enterprise feature ${f}`);
assert.ok(full.includes('white_label'));
assert.ok(full.includes('beeflow_internal_features'));

// invalid tier → community fallback
assert.deepStrictEqual(t.getFeaturesForTier('bogus'), community);

// ── Limits ──────────────────────────────────────────────────────────────
const cl = t.getLimitsForTier('community');
assert.strictEqual(cl.max_users, 1);
assert.strictEqual(cl.max_agents, 2);
const el = t.getLimitsForTier('enterprise');
assert.strictEqual(el.max_users, -1, 'enterprise unlimited');
assert.strictEqual(el.max_agents, -1);
// returns a copy, not the live reference
const l1 = t.getLimitsForTier('pro');
l1.max_agents = 999;
assert.strictEqual(t.getLimitsForTier('pro').max_agents, 20, 'getLimitsForTier should return a fresh object');

// ── tierHasFeature ──────────────────────────────────────────────────────
assert.strictEqual(t.tierHasFeature('community', 'chat_basic'), true);
assert.strictEqual(t.tierHasFeature('community', 'automations'), false);
assert.strictEqual(t.tierHasFeature('pro', 'automations'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'automations'), true, 'enterprise inherits pro');
assert.strictEqual(t.tierHasFeature('full', 'white_label'), true);
assert.strictEqual(t.tierHasFeature('pro', 'white_label'), false);
assert.strictEqual(t.tierHasFeature('bogus', 'chat_basic'), true, 'invalid tier falls back to community');

console.log('✓ license/tiers.test.js — all assertions passed');
