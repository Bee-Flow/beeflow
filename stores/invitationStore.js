/**
 * Invitation Store — PostgreSQL-backed invitation token management
 * 
 * Manages email invitations for organisations. Tokens expire after 7 days.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS invitations (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            organization_id TEXT NOT NULL,
            invited_by TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            token TEXT NOT NULL UNIQUE,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
        )
    `);
    initialized = true;
}

initDB().catch(err => console.error('[InvitationStore] Init error:', err.message));

/**
 * Create a new invitation.
 * @param {{ email: string, organizationId: string, invitedBy: string, role?: string }} data
 * @returns {Promise<{ id: string, token: string, expiresAt: string } | null>}
 */
async function createInvitation({ email, organizationId, invitedBy, role }) {
    await initDB();
    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    // Revoke any existing pending invitations for the same email + org
    await run(
        `UPDATE invitations SET status = 'revoked' WHERE LOWER(email) = LOWER($1) AND organization_id = $2 AND status = 'pending'`,
        [email, organizationId]
    );

    try {
        await run(
            `INSERT INTO invitations (id, email, organization_id, invited_by, role, token, status, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
            [id, email.toLowerCase(), organizationId, invitedBy, role || 'user', token, expiresAt]
        );
        return { id, token, expiresAt };
    } catch (e) {
        console.error('[InvitationStore] createInvitation error:', e.message);
        return null;
    }
}

/**
 * Get a valid invitation by token (must be pending and not expired).
 */
async function getInvitationByToken(token) {
    await initDB();
    const row = await getOne(
        `SELECT * FROM invitations WHERE token = $1 AND status = 'pending' AND expires_at > NOW()`,
        [token]
    );
    return row || null;
}

/**
 * Mark an invitation as accepted.
 */
async function markAccepted(token) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE invitations SET status = 'accepted' WHERE token = $1 AND status = 'pending'`,
        [token]
    );
    return rowCount > 0;
}

/**
 * Get all invitations for an organisation (most recent first).
 */
async function getInvitationsForOrg(organizationId) {
    await initDB();
    return getAll(
        `SELECT id, email, role, status, invited_by, created_at, expires_at
         FROM invitations
         WHERE organization_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [organizationId]
    );
}

/**
 * Get an invitation row by primary id. Used by the audit-trail snapshot
 * on DELETE — the revoke path needs to record the original grant terms
 * before mutating the row.
 */
async function getInvitationById(invitationId) {
    await initDB();
    return await getOne('SELECT * FROM invitations WHERE id = $1', [invitationId]);
}

/**
 * Delete (revoke) an invitation by ID.
 */
async function deleteInvitation(invitationId) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND status = 'pending'`,
        [invitationId]
    );
    return rowCount > 0;
}

module.exports = {
    createInvitation,
    getInvitationByToken,
    getInvitationById,
    markAccepted,
    getInvitationsForOrg,
    deleteInvitation,
};
