/**
 * Unit tests for end-of-run notification routing:
 *   - resolveNotificationPolicy normalizes channels (bell always on)
 *   - dispatchRunNotification fans out to the bell and/or real email
 *
 * Heavy deps are pre-mocked via the require cache before the runner is
 * required (same approach as automationRunner.collectioncap.test.js).
 *
 * Run: node --test core/automationRunner.notifications.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Mutable test knobs the lazy email/user mocks read at call time.
let emailConfigured = true;
let userEmail = 'owner@example.com';
let bellCalls = [];
let emailSends = [];

mock('../stores/automationStore', {
    createRun: async (o) => ({ id: 'run', ...o }),
    updateRun: async () => true,
    markRunning: async () => {},
    recordRunStep: async () => {},
    updateAutomation: async () => true,
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    getRun: async (id) => ({ id, cancelRequested: false }),
    requestCancelRun: async () => null,
    getAutomation: async () => null,
});
mock('../stores/configStore', { getConfig: async () => null });
mock('../stores/notificationStore', {
    createNotification: async (o) => { bellCalls.push(o); return { id: 'n1' }; },
});
mock('../stores/userStore', {
    getUser: async () => (userEmail ? { email: userEmail } : {}),
    getOrganization: async () => null,
});
mock('../utils/emailService', {
    getServiceEmailConfig: async () => ({ configured: emailConfigured, address: 'svc@x', displayName: '' }),
    sendServiceEmail: async (args) => { emailSends.push(args); return { success: true }; },
});
mock('../db', { pool: { query: async () => ({ rows: [] }) } });
mock('./aiAgent', { getProviderForModel: async () => null });
mock('./providers', { getAdapter: () => ({}) });
mock('./routineAuth', { buildUserAuth: async () => null });
mock('../auth/audience', { resolveUserGroups: async () => [] });
mock('../automation/codeSandbox', { run: async () => ({}) });

const { resolveNotificationPolicy, dispatchRunNotification } = require('./automationRunner');

function reset() {
    bellCalls = [];
    emailSends = [];
    emailConfigured = true;
    userEmail = 'owner@example.com';
}

const AUTO = { id: 'a1', userId: 'u1', title: 'Weekly digest' };

test('resolveNotificationPolicy returns normalized channels (bell always)', () => {
    const p = resolveNotificationPolicy({}, 'onError');
    assert.strictEqual(p.enabled, true);
    assert.strictEqual(p.level, 'urgent');
    assert.deepStrictEqual(p.channels, ['inapp']);
});

test('resolveNotificationPolicy honors stored channels + drops bogus ones', () => {
    const automation = { definition: { notificationSettings: { onSuccess: { enabled: true, channels: ['email', 'slack'] } } } };
    const p = resolveNotificationPolicy(automation, 'onSuccess');
    assert.strictEqual(p.enabled, true);
    assert.deepStrictEqual(p.channels, ['inapp', 'email']);
});

test('resolveNotificationPolicy clamps an invalid level to the baseline', () => {
    const automation = { definition: { notificationSettings: { onError: { level: 'nonsense' } } } };
    const p = resolveNotificationPolicy(automation, 'onError');
    assert.strictEqual(p.level, 'urgent');
});

test('disabled policy delivers nothing', async () => {
    reset();
    await dispatchRunNotification(AUTO, { enabled: false, level: 'urgent', channels: ['inapp', 'email'] }, { title: 'T', message: 'M' });
    assert.strictEqual(bellCalls.length, 0);
    assert.strictEqual(emailSends.length, 0);
});

test('inapp-only policy rings the bell, sends no email', async () => {
    reset();
    await dispatchRunNotification(AUTO, { enabled: true, level: 'urgent', channels: ['inapp'] }, { title: 'Failed', message: 'boom' });
    assert.strictEqual(bellCalls.length, 1);
    assert.strictEqual(bellCalls[0].userId, 'u1');
    assert.strictEqual(bellCalls[0].category, 'urgent');
    assert.strictEqual(bellCalls[0].title, 'Failed');
    assert.strictEqual(emailSends.length, 0);
});

test('email channel sends to the owner when service email is configured', async () => {
    reset();
    await dispatchRunNotification(AUTO, { enabled: true, level: 'urgent', channels: ['inapp', 'email'] }, { title: 'Failed', message: 'boom' });
    assert.strictEqual(bellCalls.length, 1);
    assert.strictEqual(emailSends.length, 1);
    assert.strictEqual(emailSends[0].to, 'owner@example.com');
    assert.strictEqual(emailSends[0].subject, 'Failed');
    assert.ok(emailSends[0].text.includes('boom'));
});

test('email channel no-ops when service email is not connected', async () => {
    reset();
    emailConfigured = false;
    await dispatchRunNotification(AUTO, { enabled: true, level: 'urgent', channels: ['inapp', 'email'] }, { title: 'Failed', message: 'boom' });
    assert.strictEqual(bellCalls.length, 1);
    assert.strictEqual(emailSends.length, 0);
});

test('email channel no-ops when the owner has no address', async () => {
    reset();
    userEmail = '';
    await dispatchRunNotification(AUTO, { enabled: true, level: 'urgent', channels: ['inapp', 'email'] }, { title: 'Failed', message: 'boom' });
    assert.strictEqual(bellCalls.length, 1);
    assert.strictEqual(emailSends.length, 0);
});
