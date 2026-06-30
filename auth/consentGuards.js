/**
 * Consent Guards
 *
 * The server-side trust boundary for legal-document acceptance. The registry
 * (server/legal/documentRegistry.js) is the single source of truth for which
 * documents must be accepted at which version; these helpers NEVER trust the
 * client's claimed list — they re-derive the required documents and only accept
 * an explicit affirmative acceptance covering every required document at the
 * current version.
 *
 *   validateConsent  — gate: is the submitted consent valid for this account type?
 *   recordConsent    — write one append-only ledger row per accepted document.
 *   needsReconsent   — has a required document been bumped since the user accepted?
 *   recordWaiver     — record a consumer right-of-withdrawal waiver at checkout.
 *
 * The NC connector JIT path does not pass through these guards — connector users
 * are covered by their organisation's acceptance (handled separately).
 */

const documentRegistry = require('../legal/documentRegistry');
const { clientIp } = require('./signupGuards');
const userStore = require('../stores/userStore');

/**
 * Best-effort ORIGINATING client IP for the consent evidence ledger.
 *
 * Unlike `clientIp` (which uses express `req.ip` — pinned by `trust proxy` so it
 * can't be spoofed, the right choice for geo-blocking), the legal ledger wants
 * the actual visitor's address, not the last internal proxy hop. Behind the
 * cluster ingress + the agent-hub nginx, `req.ip` lands on an internal pod
 * address (e.g. 172.16.x.x). The leftmost X-Forwarded-For entry is the client as
 * first seen at the edge, so we prefer it here and fall back to req.ip.
 */
function auditClientIp(req) {
    const fwd = req?.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) {
        const left = fwd.split(',')[0].trim();
        if (left) return left.replace(/^::ffff:/, '');
    }
    return clientIp(req);
}

/**
 * Whether the clickwrap consent system is active at all.
 *
 * Legal-document consent — the signup clickwrap, the re-consent gate, and the
 * settings consent centre — is a Bee Flow Cloud concept only. On a self-hosted
 * install the customer relationship is governed by their licence agreement, not
 * by clickwrap acceptance of Bee Flow's SaaS terms, so every consent surface is
 * disabled and these guards become no-ops.
 *
 * Sourced from DEPLOYMENT_MODE (default 'cloud'). Only two modes exist: 'cloud'
 * and 'self-hosted'; the legacy 'private-cloud' value is treated as self-hosted,
 * mirroring license/index.js → deploymentMode().
 */
function consentEnabled() {
    return (process.env.DEPLOYMENT_MODE || 'cloud') === 'cloud';
}

/**
 * Validate a submitted consent payload against the current registry.
 *
 * @param {object} consent     - { accepted: boolean, acceptedDocs?: [{docId, version}] }
 * @param {string} accountType - 'org' | 'consumer' (or a signupType the registry normalizes)
 * @returns {{ok:true, accountType, docs}} | {ok:false, status, error, code, missing}
 */
function validateConsent(consent, accountType) {
    const type = documentRegistry.normalizeAccountType(accountType);
    // Self-hosted installs don't engage the clickwrap consent system, so signup
    // is never gated on acceptance there — treat consent as already satisfied.
    if (!consentEnabled()) return { ok: true, accountType: type, docs: [] };
    const required = documentRegistry.requiredDocsFor(type);

    if (!consent || consent.accepted !== true) {
        return {
            ok: false,
            status: 400,
            error: 'You must read and accept the legal terms to create an account.',
            code: 'CONSENT_REQUIRED',
            missing: required.map(d => d.docId),
        };
    }

    // The client MAY echo which docs/versions it accepted. We do not trust that
    // list to decide what is required — but if it is present, every required doc
    // must be covered at the current version. When it is absent we treat the
    // explicit `accepted === true` (after the UI showed the current docs) as
    // acceptance of the full current required set.
    const claimed = Array.isArray(consent.acceptedDocs) ? consent.acceptedDocs : null;
    if (claimed) {
        const claimedMap = {};
        for (const c of claimed) {
            if (c && c.docId != null) claimedMap[c.docId] = Number(c.version);
        }
        const missing = required.filter(d => claimedMap[d.docId] !== Number(d.version));
        if (missing.length) {
            return {
                ok: false,
                status: 400,
                error: 'The legal terms have been updated. Please review and accept the current version.',
                code: 'CONSENT_STALE',
                missing: missing.map(d => d.docId),
            };
        }
    }

    return { ok: true, accountType: type, docs: required };
}

/**
 * Write one append-only ledger row per required document. Best-effort but the
 * caller MUST have already passed validateConsent. Also refreshes the user's
 * cached accepted-versions summary so re-consent detection is fast.
 *
 * @param {object} args - { userId, email, accountType, req, method, organizationId?, docs? }
 */
async function recordConsent({ userId, email, accountType, req, method, organizationId = null, docs = null }) {
    // The consent ledger is a Cloud-only concept — nothing to record on self-hosted.
    if (!consentEnabled()) return;
    const type = documentRegistry.normalizeAccountType(accountType);
    const required = docs || documentRegistry.requiredDocsFor(type);
    const ip = req ? auditClientIp(req) : null;
    const userAgent = req?.headers?.['user-agent'] || null;
    const route = req?.originalUrl || null;

    for (const d of required) {
        await userStore.recordConsentAcceptance({
            userId,
            email,
            accountType: type,
            docId: d.docId,
            docVersion: d.version,
            docSha256: documentRegistry.sha256For(d.docId),
            method,
            route,
            ip,
            userAgent,
            organizationId,
        });
    }

    // Refresh the cached summary (merge — never drop previously accepted docs).
    try {
        const summary = await userStore.getConsentSummary(userId);
        for (const d of required) summary[d.docId] = d.version;
        await userStore.setConsentSummary(userId, summary);
    } catch (e) {
        console.error('[ConsentGuards] Failed to update consent summary:', e.message);
    }
}

/**
 * Whether the user must (re)accept one or more documents for their account type.
 * Returns { needsReconsent, docs } where docs is [{docId, version, urlPath}].
 */
async function needsReconsent(userId, accountType) {
    // No consent surface on self-hosted → the re-consent gate never triggers.
    if (!consentEnabled()) return { needsReconsent: false, docs: [] };
    const summary = await userStore.getConsentSummary(userId);
    const stale = documentRegistry.staleDocsFor(summary, accountType);
    return { needsReconsent: stale.length > 0, docs: stale };
}

/**
 * Validate the consumer right-of-withdrawal waiver submitted at paid checkout.
 * @param {object} waiver - { accepted: boolean }
 */
function validateWaiver(waiver) {
    if (!waiver || waiver.accepted !== true) {
        return {
            ok: false,
            status: 400,
            error: 'To start a paid plan immediately you must confirm the waiver of your right of withdrawal.',
            code: 'WAIVER_REQUIRED',
        };
    }
    return { ok: true, waiver: documentRegistry.getWithdrawalWaiver() };
}

/**
 * Record a consumer withdrawal-waiver acceptance at checkout.
 * @param {object} args - { userId, email, req, organizationId? }
 */
async function recordWaiver({ userId, email, req, organizationId = null }) {
    const w = documentRegistry.getWithdrawalWaiver();
    await userStore.recordConsentAcceptance({
        userId,
        email,
        accountType: 'consumer',
        docId: w.docId,
        docVersion: w.version,
        docSha256: null,
        method: 'checkout_waiver',
        route: req?.originalUrl || null,
        ip: req ? auditClientIp(req) : null,
        userAgent: req?.headers?.['user-agent'] || null,
        organizationId,
    });
}

module.exports = {
    consentEnabled,
    validateConsent,
    recordConsent,
    needsReconsent,
    validateWaiver,
    recordWaiver,
    auditClientIp,
};
