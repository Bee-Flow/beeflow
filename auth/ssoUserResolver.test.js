/**
 * Unit tests for ssoUserResolver.
 *
 * Run: node server/auth/ssoUserResolver.test.js
 *
 * Verifies the matching rules that fix the Azure AD duplicate-user bug:
 *   - an existing user synced from Azure (id = email slug, azureUserId = GUID)
 *     must be matched by Azure OID, not duplicated
 *   - an email-only match must backfill azureUserId
 *   - a first-time SSO user with no prior record must be reported as "none"
 *   - deriveLocalUserId must mirror the directory sync's id derivation
 */

const assert = require('assert');
const {
    isAzureOid,
    deriveLocalUserId,
    resolveExistingSSOUser,
    resolveOrgByEmailDomain,
} = require('./ssoUserResolver');

function makeMockStore(users) {
    const db = new Map(users.map(u => [u.id, { ...u }]));
    return {
        _db: db,
        async getUserByAzureId(azureUserId) {
            for (const u of db.values()) {
                if (u.azureUserId === azureUserId) return { ...u };
            }
            return null;
        },
        async getUserByEmail(email) {
            const lc = String(email || '').toLowerCase();
            for (const u of db.values()) {
                if (String(u.email || '').toLowerCase() === lc) return { ...u };
            }
            return null;
        },
        async getUser(id) {
            return db.has(id) ? { ...db.get(id) } : null;
        },
        async updateUser(id, updates) {
            if (!db.has(id)) return false;
            db.set(id, { ...db.get(id), ...updates });
            return true;
        },
    };
}

async function run() {
    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`  ✅ ${name}`);
            passed++;
        } catch (err) {
            console.log(`  ❌ ${name}: ${err.message}`);
            if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
            failed++;
        }
    }

    console.log('\n🔐 SSO User Resolver Tests\n');

    // ── isAzureOid ──────────────────────────────────────────
    await test('isAzureOid accepts canonical GUID', () => {
        assert.strictEqual(isAzureOid('550e8400-e29b-41d4-a716-446655440000'), true);
    });
    await test('isAzureOid rejects email slug', () => {
        assert.strictEqual(isAzureOid('john.doe'), false);
    });
    await test('isAzureOid rejects non-string', () => {
        assert.strictEqual(isAzureOid(null), false);
        assert.strictEqual(isAzureOid(undefined), false);
        assert.strictEqual(isAzureOid(12345), false);
    });

    // ── deriveLocalUserId ───────────────────────────────────
    await test('deriveLocalUserId uses email slug when email is present', () => {
        assert.strictEqual(deriveLocalUserId('John.Doe@Example.com', 'guid'), 'john.doe');
    });
    await test('deriveLocalUserId strips illegal chars from email slug', () => {
        assert.strictEqual(deriveLocalUserId('weird+tag@example.com', 'g'), 'weirdtag');
    });
    await test('deriveLocalUserId falls back to azure-<prefix> without email', () => {
        const guid = '550e8400-e29b-41d4-a716-446655440000';
        assert.strictEqual(deriveLocalUserId(null, guid), 'azure-550e8400');
    });

    // ── resolveExistingSSOUser ──────────────────────────────
    await test('matches by Azure OID even when local id is the email slug', async () => {
        const store = makeMockStore([
            { id: 'john.doe', email: 'john.doe@example.com', azureUserId: 'OID-1', organizationId: 'acme' },
        ]);
        const { user, branch } = await resolveExistingSSOUser(
            { azureUserId: 'OID-1', email: 'john.doe@example.com', localId: 'OID-1' },
            store,
        );
        assert.ok(user, 'should find user');
        assert.strictEqual(user.id, 'john.doe', 'canonical id preserved');
        assert.strictEqual(branch, 'azureId');
    });

    await test('matches by email when azureUserId not yet set, backfills it', async () => {
        const store = makeMockStore([
            { id: 'jane.doe', email: 'Jane.Doe@example.com', azureUserId: null, organizationId: 'acme' },
        ]);
        const { user, branch } = await resolveExistingSSOUser(
            { azureUserId: 'OID-2', email: 'jane.doe@example.com', localId: 'OID-2' },
            store,
        );
        assert.strictEqual(branch, 'email');
        assert.strictEqual(user.id, 'jane.doe');
        // Backfill side-effect — the stored row should now carry the OID.
        const refreshed = await store.getUser('jane.doe');
        assert.strictEqual(refreshed.azureUserId, 'OID-2', 'azureUserId should be backfilled');
    });

    await test('does not try legacy-id lookup for Microsoft users (avoids re-creating the bug)', async () => {
        // Simulate a buggy duplicate left over from before the fix: its id is
        // an Azure OID. A fresh Microsoft login with the same OID must match
        // via azureUserId, NOT via getUser(oid) — and the canonical synced
        // user (by OID) should win.
        const store = makeMockStore([
            { id: 'john.doe', email: 'john.doe@example.com', azureUserId: 'OID-3', organizationId: 'acme' },
            { id: 'OID-3',    email: 'john.doe@example.com', azureUserId: null,    organizationId: '' },
        ]);
        const { user, branch } = await resolveExistingSSOUser(
            { azureUserId: 'OID-3', email: 'john.doe@example.com', localId: 'OID-3' },
            store,
        );
        assert.strictEqual(branch, 'azureId');
        assert.strictEqual(user.id, 'john.doe', 'must pick the canonical synced user, not the orphan');
    });

    await test('returns branch=none for a truly new user', async () => {
        const store = makeMockStore([]);
        const { user, branch } = await resolveExistingSSOUser(
            { azureUserId: 'OID-NEW', email: 'new@example.com', localId: 'new' },
            store,
        );
        assert.strictEqual(user, null);
        assert.strictEqual(branch, 'none');
    });

    await test('legacy-id fallback still works for non-Azure providers', async () => {
        const store = makeMockStore([
            { id: 'nextcloud-123', email: '', azureUserId: null, organizationId: '' },
        ]);
        const { user, branch } = await resolveExistingSSOUser(
            { azureUserId: null, email: '', localId: 'nextcloud-123' },
            store,
        );
        assert.strictEqual(branch, 'legacyId');
        assert.strictEqual(user.id, 'nextcloud-123');
    });

    // ── resolveOrgByEmailDomain ─────────────────────────────
    await test('resolveOrgByEmailDomain matches via allowedDomains', () => {
        const orgs = [
            { id: 'acme', email: 'info@acme.com', allowedDomains: ['acme.com', 'acme.io'] },
            { id: 'other', email: 'x@other.com', allowedDomains: [] },
        ];
        const match = resolveOrgByEmailDomain('someone@acme.io', orgs);
        assert.strictEqual(match.id, 'acme');
    });

    await test('resolveOrgByEmailDomain falls back to org.email domain when allowedDomains empty', () => {
        const orgs = [{ id: 'acme', email: 'info@acme.com', allowedDomains: [] }];
        const match = resolveOrgByEmailDomain('someone@acme.com', orgs);
        assert.strictEqual(match.id, 'acme');
    });

    await test('resolveOrgByEmailDomain returns null when nothing matches', () => {
        const orgs = [{ id: 'acme', email: 'info@acme.com', allowedDomains: [] }];
        assert.strictEqual(resolveOrgByEmailDomain('someone@other.com', orgs), null);
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error('Test runner crashed:', err);
    process.exit(1);
});
