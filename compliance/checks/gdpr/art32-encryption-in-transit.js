/**
 * GDPR Art. 32 — Encryption in transit (TLS).
 * Best-effort: if NODE_ENV=production and TRUST_PROXY is set (reverse-proxy
 * terminating TLS) we assume HTTPS. Otherwise warn.
 */

module.exports = {
    id: 'GDPR-Art32-encryption-in-transit',
    regulation: 'GDPR',
    article: '32',
    severity: 'high',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art32_eit.title',
    descriptionKey: 'compliance.checks.gdpr_art32_eit.desc',
    remediationKey: 'compliance.checks.gdpr_art32_eit.fix',
    async evaluate() {
        const isProd = process.env.NODE_ENV === 'production';
        const trustProxy = !!process.env.TRUST_PROXY;
        const tlsTerminator = process.env.TLS_TERMINATOR || null;
        let status = 'pass';
        let details = 'TLS termination detected at reverse proxy.';
        if (!isProd) {
            status = 'warn';
            details = 'NODE_ENV is not "production" — assumed to be a dev/test deployment. Ensure the production stack terminates TLS.';
        } else if (!trustProxy && !tlsTerminator) {
            status = 'warn';
            details = 'Cannot confirm TLS termination. Set TRUST_PROXY=1 or TLS_TERMINATOR=<name> so audits can attest to HTTPS.';
        }
        return {
            status,
            evidence: { NODE_ENV: process.env.NODE_ENV || 'unset', TRUST_PROXY: trustProxy, TLS_TERMINATOR: tlsTerminator },
            details,
        };
    },
};
