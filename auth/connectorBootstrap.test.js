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
