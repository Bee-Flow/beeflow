const test = require('node:test');
const assert = require('node:assert');

const tiers = require('./tiers');
const betaFeatures = require('./../core/betaFeatures');

test('lead_studio is gated to Enterprise+ and denied to the community floor', () => {
    assert.strictEqual(tiers.tierHasFeature('enterprise', 'lead_studio'), true);
    assert.strictEqual(tiers.tierHasFeature('full', 'lead_studio'), true);
    assert.strictEqual(tiers.tierHasFeature('community', 'lead_studio'), false);
    // 'pro' is a legacy alias for 'enterprise' (LEGACY_TIER_ALIAS) → also granted.
    assert.strictEqual(tiers.tierHasFeature('pro', 'lead_studio'), true);
});

test('lead_studio beta entry is registered and compound-gated on the license feature', () => {
    const list = typeof betaFeatures.listBetaFeatures === 'function'
        ? betaFeatures.listBetaFeatures()
        : betaFeatures.BETA_FEATURES;
    const entry = list.find(f => f.id === 'lead_studio');
    assert.ok(entry, 'lead_studio beta feature should be registered');
    assert.strictEqual(entry.licenseFeature, 'lead_studio');
});
