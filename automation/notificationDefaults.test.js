/**
 * Unit tests for automation/notificationDefaults — channel normalization
 * and the defaults contract the runner + UI both depend on.
 *
 * Run: node --test automation/notificationDefaults.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { NOTIFICATION_DEFAULTS, VALID_LEVELS, VALID_CHANNELS, normalizeChannels } = require('./notificationDefaults');

test('defaults carry an inapp channel on every event', () => {
    for (const event of ['onSuccess', 'onError', 'onApproval']) {
        assert.ok(NOTIFICATION_DEFAULTS[event], `missing default for ${event}`);
        assert.deepStrictEqual([...NOTIFICATION_DEFAULTS[event].channels], ['inapp']);
        assert.ok(VALID_LEVELS.includes(NOTIFICATION_DEFAULTS[event].level));
    }
});

test('valid channels are inapp + email only (no slack/push backend yet)', () => {
    assert.deepStrictEqual([...VALID_CHANNELS], ['inapp', 'email']);
});

test('normalizeChannels always includes the bell', () => {
    assert.deepStrictEqual(normalizeChannels([]), ['inapp']);
    assert.deepStrictEqual(normalizeChannels(['email']), ['inapp', 'email']);
    assert.deepStrictEqual(normalizeChannels(undefined), ['inapp']);
    assert.deepStrictEqual(normalizeChannels(null), ['inapp']);
});

test('normalizeChannels drops unknown channels and de-dupes', () => {
    assert.deepStrictEqual(normalizeChannels(['slack', 'push', 'email']), ['inapp', 'email']);
    assert.deepStrictEqual(normalizeChannels(['inapp', 'inapp', 'email', 'email']), ['inapp', 'email']);
});
