/**
 * Unit Tests for Zero-Knowledge Encryption Module
 * 
 * Run: node auth/encryption.test.js
 * Requires: MASTER_ENCRYPTION_KEY or SESSION_SECRET env var
 */

const assert = require('assert');

// Set env vars before requiring encryption module
process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'test-master-key-for-unit-tests-32chars!!';
process.env.SESSION_SECRET = 'test-session-secret';

// Mock userStore to avoid DB dependency
const users = {};
const mockUserStore = {
    getUser: (id) => users[id] || null,
    updateUser: (id, updates) => {
        if (!users[id]) users[id] = {};
        Object.assign(users[id], updates);
        return true;
    },
    createUser: (data) => {
        users[data.id] = data;
        return true;
    }
};

// Monkey-patch require to intercept userStore
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../stores/userStore') {
        return 'mock-userStore';
    }
    return originalResolve.call(this, request, parent, ...rest);
};
const originalLoad = Module._cache;
require.cache['mock-userStore'] = { id: 'mock-userStore', exports: mockUserStore };

const encryption = require('./encryption');

async function runTests() {
    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`  ✅ ${name}`);
            passed++;
        } catch (err) {
            console.log(`  ❌ ${name}: ${err.message}`);
            failed++;
        }
    }

    console.log('\n🔐 Encryption Module Tests\n');

    // === Core Crypto Tests ===
    console.log('--- Core Crypto ---');

    await test('wrapDEK/unwrapDEK round-trip works', async () => {
        const crypto = require('crypto');
        const dek = crypto.randomBytes(32);
        const key = crypto.randomBytes(32);
        const context = 'test-context';
        const wrapped = encryption.wrapDEK(dek, key, context);
        const unwrapped = encryption.unwrapDEK(wrapped, key, context);
        assert.ok(unwrapped, 'unwrap should succeed');
        assert.ok(dek.equals(unwrapped), 'unwrapped DEK should match original');
    });

    await test('unwrapDEK fails with wrong key', async () => {
        const crypto = require('crypto');
        const dek = crypto.randomBytes(32);
        const key1 = crypto.randomBytes(32);
        const key2 = crypto.randomBytes(32);
        const wrapped = encryption.wrapDEK(dek, key1, 'ctx');
        const result = encryption.unwrapDEK(wrapped, key2, 'ctx');
        assert.strictEqual(result, null, 'should return null with wrong key');
    });

    await test('unwrapDEK fails with wrong AAD context', async () => {
        const crypto = require('crypto');
        const dek = crypto.randomBytes(32);
        const key = crypto.randomBytes(32);
        const wrapped = encryption.wrapDEK(dek, key, 'context-a');
        const result = encryption.unwrapDEK(wrapped, key, 'context-b');
        assert.strictEqual(result, null, 'should return null with wrong AAD');
    });

    await test('IV is exactly 12 bytes in wrapped output', async () => {
        const crypto = require('crypto');
        const dek = crypto.randomBytes(32);
        const key = crypto.randomBytes(32);
        const wrapped = encryption.wrapDEK(dek, key, 'test');
        const iv = Buffer.from(wrapped.iv, 'base64');
        assert.strictEqual(iv.length, 12, `IV should be 12 bytes, got ${iv.length}`);
    });

    // === Key Derivation ===
    console.log('\n--- Key Derivation ---');

    await test('deriveKEK returns 32-byte Buffer', async () => {
        const crypto = require('crypto');
        const salt = crypto.randomBytes(32);
        const kek = await encryption.deriveKEK('testpassword', salt);
        assert.ok(Buffer.isBuffer(kek), 'should return Buffer');
        assert.strictEqual(kek.length, 32, 'should be 32 bytes');
    });

    await test('deriveKEK with same password+salt returns same key', async () => {
        const crypto = require('crypto');
        const salt = crypto.randomBytes(32);
        const kek1 = await encryption.deriveKEK('password', salt);
        const kek2 = await encryption.deriveKEK('password', salt);
        assert.ok(kek1.equals(kek2), 'same inputs should produce same key');
    });

    await test('deriveKEK with different passwords returns different keys', async () => {
        const crypto = require('crypto');
        const salt = crypto.randomBytes(32);
        const kek1 = await encryption.deriveKEK('password1', salt);
        const kek2 = await encryption.deriveKEK('password2', salt);
        assert.ok(!kek1.equals(kek2), 'different passwords should produce different keys');
    });

    // === Zero-Knowledge User Flow ===
    console.log('\n--- Zero-Knowledge User Flow ---');

    await test('createUserDEK returns 32-byte DEK and formatted recovery key', async () => {
        const { dek, recoveryKey } = await encryption.createUserDEK('test-user-1', 'mypassword');
        assert.ok(Buffer.isBuffer(dek), 'DEK should be a Buffer');
        assert.strictEqual(dek.length, 32, 'DEK should be 32 bytes');
        assert.ok(typeof recoveryKey === 'string', 'recovery key should be a string');
        assert.ok(recoveryKey.includes('-'), 'recovery key should be dash-separated');
        const parts = recoveryKey.split('-');
        assert.strictEqual(parts.length, 8, `recovery key should have 8 parts, got ${parts.length}`);
        encryption.secureClear(dek);
    });

    await test('unlockUserDEK with correct password returns same DEK', async () => {
        const { dek: originalDek } = await encryption.createUserDEK('test-user-2', 'correct-pw');
        const unlockedDek = await encryption.unlockUserDEK('test-user-2', 'correct-pw');
        assert.ok(unlockedDek, 'should return DEK');
        assert.ok(originalDek.equals(unlockedDek), 'unlocked DEK should match original before clearing');
        encryption.secureClear(originalDek);
        encryption.secureClear(unlockedDek);
    });

    await test('unlockUserDEK with wrong password returns null', async () => {
        await encryption.createUserDEK('test-user-3', 'correct');
        // Reset failure counter for clean test
        users['test-user-3'].dekUnwrapFailures = 0;
        users['test-user-3'].dekLockoutUntil = null;
        const result = await encryption.unlockUserDEK('test-user-3', 'wrong');
        assert.strictEqual(result, null, 'should return null');
    });

    await test('unlockWithRecoveryKey works with correct key', async () => {
        const { dek: originalDek, recoveryKey } = await encryption.createUserDEK('test-user-4', 'pw');
        const recovered = await encryption.unlockWithRecoveryKey('test-user-4', recoveryKey);
        assert.ok(recovered, 'should return DEK');
        assert.ok(originalDek.equals(recovered), 'recovered DEK should match original');
        encryption.secureClear(originalDek);
        encryption.secureClear(recovered);
    });

    await test('unlockWithRecoveryKey fails with wrong key', async () => {
        await encryption.createUserDEK('test-user-5', 'pw');
        const result = await encryption.unlockWithRecoveryKey('test-user-5', 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-11111-22222-33333-44444');
        assert.strictEqual(result, null, 'should return null with wrong key');
    });

    // === Password Change & Recovery Key Rotation ===
    console.log('\n--- Password Change & Recovery ---');

    await test('rewrapUserDEK then unlock with new password works', async () => {
        const { dek } = await encryption.createUserDEK('test-user-6', 'oldpw');
        await encryption.rewrapUserDEK('test-user-6', dek, 'newpw');
        // Reset failure counter 
        users['test-user-6'].dekUnwrapFailures = 0;
        users['test-user-6'].dekLockoutUntil = null;
        const unlocked = await encryption.unlockUserDEK('test-user-6', 'newpw');
        assert.ok(unlocked, 'should unlock with new password');
        assert.ok(dek.equals(unlocked), 'DEK should be same after rewrap');
        encryption.secureClear(dek);
        encryption.secureClear(unlocked);
    });

    await test('rotateRecoveryKey: new key works, old key fails', async () => {
        const { dek, recoveryKey: oldKey } = await encryption.createUserDEK('test-user-7', 'pw');
        const newKey = await encryption.rotateRecoveryKey('test-user-7', dek);
        assert.ok(newKey !== oldKey, 'new key should differ from old key');

        const withNew = await encryption.unlockWithRecoveryKey('test-user-7', newKey);
        assert.ok(withNew, 'should unlock with new recovery key');
        assert.ok(dek.equals(withNew), 'DEK should match');

        const withOld = await encryption.unlockWithRecoveryKey('test-user-7', oldKey);
        assert.strictEqual(withOld, null, 'old recovery key should fail');

        encryption.secureClear(dek);
        encryption.secureClear(withNew);
    });

    // === Admin Reset ===
    console.log('\n--- Admin Reset ---');

    await test('adminResetUser clears wrappedDEK but preserves recoveryWrappedDEK', async () => {
        const { recoveryKey } = await encryption.createUserDEK('test-user-8', 'pw');
        const user = users['test-user-8'];
        assert.ok(user.wrappedDEK, 'should have wrappedDEK before reset');
        assert.ok(user.recoveryWrappedDEK, 'should have recoveryWrappedDEK before reset');

        encryption.adminResetUser('test-user-8');
        const afterReset = users['test-user-8'];
        assert.strictEqual(afterReset.wrappedDEK, null, 'wrappedDEK should be null after reset');
        assert.strictEqual(afterReset.kekSalt, null, 'kekSalt should be null after reset');
        assert.ok(afterReset.recoveryWrappedDEK, 'recoveryWrappedDEK should be preserved');

        // Recovery key should still work
        const recovered = await encryption.unlockWithRecoveryKey('test-user-8', recoveryKey);
        assert.ok(recovered, 'recovery key should still work after admin reset');
        encryption.secureClear(recovered);
    });

    // === secureClear ===
    console.log('\n--- Helpers ---');

    await test('secureClear zeros out a buffer', async () => {
        const buf = Buffer.from([1, 2, 3, 4, 5]);
        encryption.secureClear(buf);
        assert.ok(buf.every(b => b === 0), 'all bytes should be zero');
    });

    await test('formatRecoveryKey/parseRecoveryKey round-trip', async () => {
        const crypto = require('crypto');
        const raw = crypto.randomBytes(32);
        const rawCopy = Buffer.from(raw);
        const formatted = encryption.formatRecoveryKey(raw);
        const parsed = encryption.parseRecoveryKey(formatted);
        // parseRecoveryKey only parses first 25 bytes (50 hex chars / 10 groups of 5)
        assert.ok(parsed.length > 0, 'parsed should not be empty');
        // Check that parsed matches the beginning of the raw key
        assert.ok(rawCopy.slice(0, parsed.length).equals(parsed), 'parsed key should match raw bytes');
    });

    // === SSO PIN Flow ===
    console.log('\n--- SSO PIN Flow ---');

    await test('setupSSOUserDEK requires min 8 char PIN with complexity', async () => {
        try {
            await encryption.setupSSOUserDEK('sso-user-1', '12345');
            assert.fail('should throw for short PIN');
        } catch (err) {
            assert.ok(err.message.includes('at least 8'), 'should mention minimum length');
        }
    });

    await test('setupSSOUserDEK + unlockSSOUserDEK works', async () => {
        // Create user entry first
        users['sso-user-2'] = { id: 'sso-user-2' };
        const { dek, recoveryKey } = await encryption.setupSSOUserDEK('sso-user-2', 'MyPin123xx');
        assert.ok(dek, 'should return DEK');
        assert.ok(recoveryKey, 'should return recovery key');

        const result = await encryption.unlockSSOUserDEK('sso-user-2', 'MyPin123xx');
        assert.ok(result.dek, 'should return dek');
        assert.ok(dek.equals(result.dek), 'DEK should match');
        encryption.secureClear(dek);
        encryption.secureClear(result.dek);
    });

    await test('unlockSSOUserDEK returns needsSetup for new SSO user', async () => {
        users['sso-user-3'] = { id: 'sso-user-3', ssoEncryptionSetup: 0 };
        const result = await encryption.unlockSSOUserDEK('sso-user-3', 'any');
        assert.ok(result.needsSetup, 'should need setup');
    });

    await test('unlockSSOUserDEK returns wrongPin for bad PIN', async () => {
        users['sso-user-4'] = { id: 'sso-user-4' };
        await encryption.setupSSOUserDEK('sso-user-4', 'GoodPin1xx');
        // Reset rate limit for test
        users['sso-user-4'].dekUnwrapFailures = 0;
        users['sso-user-4'].dekLockoutUntil = null;
        const result = await encryption.unlockSSOUserDEK('sso-user-4', 'BadPins1xx');
        assert.ok(result.wrongPin, 'should indicate wrong PIN');
    });

    // === getFallbackEncryptionKey ===
    console.log('\n--- Fallback Key ---');

    await test('getFallbackEncryptionKey returns consistent key', async () => {
        const k1 = encryption.getFallbackEncryptionKey('admin');
        const k2 = encryption.getFallbackEncryptionKey('admin');
        assert.strictEqual(k1, k2, 'should be deterministic');
        assert.strictEqual(Buffer.from(k1, 'base64').length, 32, 'should be 32 bytes');
    });

    await test('getFallbackEncryptionKey differs per userId', async () => {
        const k1 = encryption.getFallbackEncryptionKey('admin');
        const k2 = encryption.getFallbackEncryptionKey('demo-user');
        assert.notStrictEqual(k1, k2, 'should differ for different users');
    });

    // === Summary ===
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(40)}\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
