/**
 * Unit — auto-provisioned Nextcloud org display names.
 *
 * Run: node server/auth/orgNaming.test.js
 */

const assert = require('assert');
const { buildAutoOrgName, ncHostFromUrl } = require('./orgNaming');

// Generic default name gets qualified with the instance host.
assert.strictEqual(buildAutoOrgName('Nextcloud', 'https://nc.e380.net'), 'Nextcloud (nc.e380.net)');
// Missing/blank theming name falls back to "Nextcloud" then qualifies.
assert.strictEqual(buildAutoOrgName(null, 'https://nc.e380.net/'), 'Nextcloud (nc.e380.net)');
assert.strictEqual(buildAutoOrgName('   ', 'https://nc.e380.net'), 'Nextcloud (nc.e380.net)');
// Custom-themed instances keep their name + host.
assert.strictEqual(buildAutoOrgName('Acme Cloud', 'https://cloud.acme.com'), 'Acme Cloud (cloud.acme.com)');
// No double-qualify when the name already carries the host.
assert.strictEqual(buildAutoOrgName('nc.e380.net', 'https://nc.e380.net'), 'nc.e380.net');
// Unparseable / missing URL leaves the name untouched (no "(null)" suffix).
assert.strictEqual(buildAutoOrgName('Nextcloud', ''), 'Nextcloud');
assert.strictEqual(buildAutoOrgName('Nextcloud', 'not a url'), 'Nextcloud');

// ncHostFromUrl extracts host (incl. port) or null.
assert.strictEqual(ncHostFromUrl('https://nc.e380.net/foo'), 'nc.e380.net');
assert.strictEqual(ncHostFromUrl('http://host:3001'), 'host:3001');
assert.strictEqual(ncHostFromUrl('garbage'), null);

console.log('orgNaming.test.js: all assertions passed');
