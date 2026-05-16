/**
 * Unit tests for license/tiers.js
 *
 * Run: node license/tiers.test.js
 */

const assert = require('assert');
const t = require('./tiers');

// ── Hierarchy & validity ────────────────────────────────────────────────
assert.deepStrictEqual(t.TIER_HIERARCHY, ['community', 'enterprise', 'full']);
assert.strictEqual(t.isValidTier('community'), true);
assert.strictEqual(t.isValidTier('enterprise'), true);
assert.strictEqual(t.isValidTier('full'), true);
assert.strictEqual(t.isValidTier('pro'), true, 'legacy pro tier must still be accepted as input');
assert.strictEqual(t.isValidTier('starter'), false);
assert.strictEqual(t.isValidTier(undefined), false);
assert.strictEqual(t.isValidTier(null), false);

// ── Legacy tier normalisation ───────────────────────────────────────────
assert.strictEqual(t.normalizeTier('pro'), 'enterprise', 'legacy pro must map to enterprise');
assert.strictEqual(t.normalizeTier('community'), 'community');
assert.strictEqual(t.normalizeTier('enterprise'), 'enterprise');
assert.strictEqual(t.normalizeTier('full'), 'full');
assert.strictEqual(t.normalizeTier('bogus'), 'bogus', 'unknown tiers pass through unchanged');

// ── Rank ────────────────────────────────────────────────────────────────
assert.strictEqual(t.tierRank('community'), 0);
assert.strictEqual(t.tierRank('enterprise'), 1);
assert.strictEqual(t.tierRank('full'), 2);
assert.strictEqual(t.tierRank('pro'), 1, 'legacy pro ranks as enterprise');
assert.strictEqual(t.tierRank('bogus'), -1);

// ── tierAtLeast ─────────────────────────────────────────────────────────
assert.strictEqual(t.tierAtLeast('enterprise', 'community'), true);
assert.strictEqual(t.tierAtLeast('enterprise', 'enterprise'), true);
assert.strictEqual(t.tierAtLeast('community', 'enterprise'), false);
assert.strictEqual(t.tierAtLeast('full', 'enterprise'), true);
assert.strictEqual(t.tierAtLeast('pro', 'enterprise'), true, 'legacy pro satisfies enterprise');
assert.strictEqual(t.tierAtLeast('pro', 'community'), true);
assert.strictEqual(t.tierAtLeast('bogus', 'community'), false, 'unknown actual tier should not satisfy any requirement');
assert.strictEqual(t.tierAtLeast('community', 'bogus'), false, 'unknown required tier should be rejected');

// ── Feature inheritance ─────────────────────────────────────────────────
const community = t.getFeaturesForTier('community');
const enterprise = t.getFeaturesForTier('enterprise');
const full = t.getFeaturesForTier('full');

// Community is now the everything-the-product-does tier.
assert.ok(community.includes('chat_basic'));
assert.ok(community.includes('nextcloud_basic'));
assert.ok(community.includes('automations'), 'community must include automations');
assert.ok(community.includes('multi_user'), 'community must include multi_user');
assert.ok(community.includes('voice_chat'), 'community must include voice_chat');
assert.ok(community.includes('skills'), 'community must include skills');
assert.ok(community.includes('meeting_notes'), 'community must include meeting_notes');
assert.ok(community.includes('kb_unlimited'), 'community must include kb_unlimited');
assert.ok(!community.includes('guardrails_dlp'), 'community must NOT include enterprise features');
assert.ok(!community.includes('sso_saml'));
assert.ok(!community.includes('white_label'));

// Enterprise inherits community + adds compliance/admin.
for (const f of community) assert.ok(enterprise.includes(f), `enterprise should inherit community feature ${f}`);
assert.ok(enterprise.includes('guardrails_dlp'));
assert.ok(enterprise.includes('compliance_hub_gdpr'));
assert.ok(enterprise.includes('sso_saml'));
assert.ok(enterprise.includes('audit_log_export'));
assert.ok(!enterprise.includes('white_label'), 'enterprise must NOT include resale features');

// Full inherits enterprise + adds resale/branding.
for (const f of enterprise) assert.ok(full.includes(f), `full should inherit enterprise feature ${f}`);
assert.ok(full.includes('white_label'));
assert.ok(full.includes('beeflow_internal_features'));
assert.ok(full.includes('license_issuance'));

// Legacy pro resolves to enterprise's feature set.
const legacyPro = t.getFeaturesForTier('pro');
assert.deepStrictEqual(legacyPro.sort(), enterprise.slice().sort(), 'legacy pro must expose the enterprise feature set');

// Invalid tier → community fallback
assert.deepStrictEqual(t.getFeaturesForTier('bogus'), community);

// ── Limits ──────────────────────────────────────────────────────────────
// Community is uncapped — same shape as enterprise / full.
const cl = t.getLimitsForTier('community');
assert.strictEqual(cl.max_users, -1, 'community is uncapped on users');
assert.strictEqual(cl.max_agents, -1);
assert.strictEqual(cl.max_messages_per_month, -1);
assert.strictEqual(cl.max_kb_sources, -1);

const el = t.getLimitsForTier('enterprise');
assert.strictEqual(el.max_users, -1, 'enterprise unlimited');
assert.strictEqual(el.max_agents, -1);

const fl = t.getLimitsForTier('full');
assert.strictEqual(fl.max_users, -1);

// Legacy pro returns enterprise limits.
const pl = t.getLimitsForTier('pro');
assert.strictEqual(pl.max_users, -1, 'legacy pro limits resolve to enterprise');

// Returns a copy, not the live reference.
const l1 = t.getLimitsForTier('community');
l1.max_agents = 999;
assert.strictEqual(t.getLimitsForTier('community').max_agents, -1, 'getLimitsForTier should return a fresh object');

// ── tierHasFeature ──────────────────────────────────────────────────────
assert.strictEqual(t.tierHasFeature('community', 'chat_basic'), true);
assert.strictEqual(t.tierHasFeature('community', 'automations'), true, 'automations is now community');
assert.strictEqual(t.tierHasFeature('community', 'sso_saml'), false);
assert.strictEqual(t.tierHasFeature('enterprise', 'automations'), true, 'enterprise inherits community');
assert.strictEqual(t.tierHasFeature('enterprise', 'sso_saml'), true);
assert.strictEqual(t.tierHasFeature('full', 'white_label'), true);
assert.strictEqual(t.tierHasFeature('enterprise', 'white_label'), false);
assert.strictEqual(t.tierHasFeature('pro', 'sso_saml'), true, 'legacy pro inherits enterprise features');
assert.strictEqual(t.tierHasFeature('bogus', 'chat_basic'), true, 'invalid tier falls back to community');

console.log('✓ license/tiers.test.js — all assertions passed');
