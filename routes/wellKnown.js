/**
 * /.well-known/* — public discovery documents (no auth, no license gate).
 *
 * Currently serves the Microsoft Identity Association file used for Azure AD
 * publisher-domain verification.
 *
 * Azure verifies that the publisher owns a domain by fetching
 *   https://<domain>/.well-known/microsoft-identity-association.json
 * and checking that the app registration's Application (client) ID appears
 * under `associatedApplications`. Serving this lets Bee Flow Cloud's Azure app
 * ("Bee Flow - AI - Live") show a *verified* publisher on its consent screen —
 * required before end users can grant consent to a multitenant app.
 *
 * Cloud-only. This is meaningful only on Bee Flow Cloud (beeflow.nl), whose
 * domain is the publisher domain registered in Azure. Self-hosted installs run
 * on their own domains with their own Azure app registrations (if any), so they
 * must NOT advertise our application IDs — the route 404s there.
 *
 * App ID source (first non-empty wins):
 *   1. MICROSOFT_IDENTITY_ASSOCIATION_APP_IDS — comma-separated GUIDs. Use to
 *      associate more than one app (e.g. Live + Dev) or to pin an explicit
 *      value independent of the SSO config.
 *   2. The configured Microsoft SSO Application (client) ID
 *      (config.providers.microsoft.clientId) — the same Azure app users sign in
 *      with, so the file stays in sync with the SSO config automatically.
 */

const express = require('express');
const router = express.Router();
const { loadConfig } = require('../auth/permissions');

// Azure Application (client) IDs are GUIDs.
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Mirror license/index.js#deploymentMode: only 'cloud' | 'self-hosted' exist;
// the retired 'private-cloud' value normalises to self-hosted.
function deploymentMode() {
    const mode = process.env.DEPLOYMENT_MODE || 'cloud';
    return mode === 'private-cloud' ? 'self-hosted' : mode;
}

async function resolveAppIds() {
    const fromEnv = (process.env.MICROSOFT_IDENTITY_ASSOCIATION_APP_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    if (fromEnv.length) return fromEnv.filter(id => GUID_RE.test(id));

    try {
        const config = await loadConfig();
        const clientId = config?.providers?.microsoft?.clientId;
        if (clientId && GUID_RE.test(clientId)) return [clientId];
    } catch (_) { /* fall through — nothing to associate */ }
    return [];
}

router.get('/microsoft-identity-association.json', async (req, res) => {
    // Cloud-only — self-hosted installs must not advertise our Azure app IDs.
    if (deploymentMode() === 'self-hosted') {
        return res.status(404).json({ error: 'Not found' });
    }

    const appIds = await resolveAppIds();
    if (!appIds.length) {
        // No Microsoft SSO app configured yet — there is nothing to associate.
        return res.status(404).json({ error: 'Not configured' });
    }

    // Emit EXACTLY `application/json` — no `; charset=utf-8`. Azure AD's verifier
    // is strict about the Content-Type and the charset suffix trips its
    // "unexpected content type header value" check. express res.json()/res.send()
    // re-append the charset even after setHeader, so write the body via res.end.
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(JSON.stringify({
        associatedApplications: appIds.map(applicationId => ({ applicationId })),
    }));
});

module.exports = router;
