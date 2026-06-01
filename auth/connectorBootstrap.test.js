/**
 * Unit tests for the connector-bootstrap hardening helpers — the provisioning
 * policy resolver and the stable instance-id fallback. Pure logic, no DB / no
 * fetch (the full handler is integration territory).
 *
 * Run: node --test server/auth/connectorBootstrap.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { helpers } = require('./connectorBootstrap');

test('defaultProvisioningMode: official Cloud hosts default to open', () => {
    const prev = process.env.SERVER_PUBLIC_HOST;
    process.env.SERVER_PUBLIC_HOST = 'server.beeflow.nl';
    assert.equal(helpers.defaultProvisioningMode(), 'open');
    process.env.SERVER_PUBLIC_HOST = 'server.dev.beeflow.nl';
    assert.equal(helpers.defaultProvisioningMode(), 'open');
    // case-insensitive
    process.env.SERVER_PUBLIC_HOST = 'Server.BeeFlow.NL';
    assert.equal(helpers.defaultProvisioningMode(), 'open');
    if (prev === undefined) delete process.env.SERVER_PUBLIC_HOST; else process.env.SERVER_PUBLIC_HOST = prev;
});

test('defaultProvisioningMode: self-host / unset fails closed to pairing_only', () => {
    const prev = process.env.SERVER_PUBLIC_HOST;
    process.env.SERVER_PUBLIC_HOST = 'ai.acme.example';
    assert.equal(helpers.defaultProvisioningMode(), 'pairing_only');
    delete process.env.SERVER_PUBLIC_HOST;
    assert.equal(helpers.defaultProvisioningMode(), 'pairing_only');
    if (prev !== undefined) process.env.SERVER_PUBLIC_HOST = prev;
});

test('stableInstanceIdFallback: host-keyed and version-independent', () => {
    assert.equal(helpers.stableInstanceIdFallback('https://nc.example.com/', 'Acme'), 'nc-host:nc.example.com');
    // host includes the port; path is ignored
    assert.equal(helpers.stableInstanceIdFallback('https://nc.example.com:8443/foo', 'Acme'), 'nc-host:nc.example.com:8443');
});

test('stableInstanceIdFallback: malformed URL falls back to theming name', () => {
    assert.equal(helpers.stableInstanceIdFallback('not a url', 'Acme'), 'nc:Acme');
    assert.equal(helpers.stableInstanceIdFallback('', null), 'nc:nextcloud');
});

test('PROVISIONING_MODES is the closed set the admin route also enforces', () => {
    assert.deepEqual(helpers.PROVISIONING_MODES, ['open', 'pairing_only']);
});

// _selectSecondaryAdmins — which extra NC admins get provisioned besides the
// primary (the rest of the `admin` group, so any admin can onboard).
const sel = helpers._selectSecondaryAdmins;

test('selectSecondaryAdmins: drops the primary, keeps the rest (lower-cased email)', () => {
    const admins = [
        { uid: 'alice', email: 'Alice@EX.com', displayName: 'Alice' },
        { uid: 'bob', email: 'bob@ex.com', displayName: 'Bob' },
    ];
    assert.deepEqual(sel(admins, 'alice'), [{ uid: 'bob', email: 'bob@ex.com', displayName: 'Bob' }]);
});

test('selectSecondaryAdmins: drops email-less and blank-uid entries, dedups by uid', () => {
    const admins = [
        { uid: 'bob', email: 'bob@ex.com' },
        { uid: 'carol', email: '' },          // no email → dropped
        { uid: '', email: 'x@ex.com' },        // no uid → dropped
        { uid: 'bob', email: 'dupe@ex.com' },  // duplicate uid → dropped
    ];
    assert.deepEqual(sel(admins, 'alice'), [{ uid: 'bob', email: 'bob@ex.com', displayName: 'bob' }]);
});

test('selectSecondaryAdmins: missing/empty list → []', () => {
    assert.deepEqual(sel(undefined, 'alice'), []);
    assert.deepEqual(sel([], 'alice'), []);
    assert.deepEqual(sel(null, 'alice'), []);
});

test('selectSecondaryAdmins: displayName falls back to uid', () => {
    assert.deepEqual(sel([{ uid: 'bob', email: 'bob@ex.com' }], 'alice'),
        [{ uid: 'bob', email: 'bob@ex.com', displayName: 'bob' }]);
});
