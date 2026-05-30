/**
 * Unit — community is the free default for a self-hosted install.
 *
 * Guards the contract: a self-hosted Bee Flow with NO licence runs at the
 * community tier (no activation required), community is the lowest tier and a
 * usable floor, and the server-wide licence governs orgs in self-hosted mode.
 *
 * DB-free: only asserts exported constants/predicates. Run:
 *   node server/license/communityDefault.test.js
 */

const assert = require('assert');

const prevMode = process.env.DEPLOYMENT_MODE;
process.env.DEPLOYMENT_MODE = 'self-hosted';

const license = require('./index');
const tiers = require('./tiers');

// Community is the documented floor constant.
assert.strictEqual(license.COMMUNITY_FALLBACK, 'community', 'COMMUNITY_FALLBACK must be community');

// Self-hosted: a server-wide licence governs every org (so one key lifts the
// whole install — and with no key, every org sits at the community floor).
assert.strictEqual(license.serverLicenseGovernsOrgs(), true, 'self-hosted must let the server licence govern orgs');

// Community is the lowest tier in the hierarchy — nothing below it to fall to.
assert.strictEqual(tiers.TIER_HIERARCHY[0], 'community', 'community must be the lowest tier');

// Community is a usable floor: core chat + KB + Nextcloud are available without a licence.
for (const feature of ['chat_basic', 'kb_unlimited', 'nextcloud_basic', 'multi_user']) {
    assert.ok(tiers.TIER_FEATURES.community.includes(feature), `community must include ${feature}`);
}

if (prevMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = prevMode;

console.log('communityDefault.test.js: all assertions passed');
