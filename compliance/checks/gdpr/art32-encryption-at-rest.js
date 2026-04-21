/**
 * GDPR Art. 32 — Encryption at rest.
 * MASTER_ENCRYPTION_KEY governs config-store secret encryption and
 * envelope encryption for conversations.
 */

module.exports = {
    id: 'GDPR-Art32-encryption-at-rest',
    regulation: 'GDPR',
    article: '32',
    severity: 'critical',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art32_ear.title',
    descriptionKey: 'compliance.checks.gdpr_art32_ear.desc',
    remediationKey: 'compliance.checks.gdpr_art32_ear.fix',
    remediationLink: null,
    async evaluate() {
        const hasMaster = !!process.env.MASTER_ENCRYPTION_KEY;
        const hasSession = !!process.env.SESSION_SECRET;
        const status = hasMaster && hasSession ? 'pass' : 'fail';
        return {
            status,
            evidence: {
                MASTER_ENCRYPTION_KEY: hasMaster ? 'set' : 'missing',
                SESSION_SECRET: hasSession ? 'set' : 'missing',
                envelope_encryption: 'AES-256-GCM (messageEncryption)',
            },
            details: hasMaster
                ? 'Envelope-encryption key is configured; messages stored encrypted at rest.'
                : 'MASTER_ENCRYPTION_KEY environment variable is not set — configuration secrets and message bodies are not encrypted.',
        };
    },
};
