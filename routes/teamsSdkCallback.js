/**
 * ACS Call Automation webhook receiver.
 *
 * ACS delivers EventGrid-shaped events to this endpoint whenever a call
 * started via teams-sdk.js changes state (connected, recording ready,
 * disconnected, etc.). There is no user auth here — the URL is called by
 * Azure, not a browser. Validation is handled two ways:
 *
 *   1. EventGrid subscription validation handshake: Azure sends a
 *      SubscriptionValidationEvent the first time the URL is registered. We
 *      echo back the validation code.
 *   2. A shared-secret query param (`?token=…`) if teams_bot_callback_secret
 *      is configured — cheap defence against random POSTs. Skipped when not
 *      configured so local development isn't blocked.
 *
 * Events are forwarded to teamsSdkProvider.handleAcsEvent() which owns the
 * session-map bookkeeping and recording download.
 */

const express = require('express');
const router = express.Router();

const configStore = require('../stores/configStore');
const teamsSdk = require('../core/meetBotProviders/teams-sdk');

async function verifySecret(req) {
    const expected = await configStore.getSecret('teams_bot_callback_secret').catch(() => null);
    if (!expected) return true; // not enforced
    return req.query.token === expected;
}

router.post('/', express.json({ limit: '10mb' }), async (req, res) => {
    if (!(await verifySecret(req))) {
        return res.status(403).json({ error: 'Invalid callback secret' });
    }

    const events = Array.isArray(req.body) ? req.body : [req.body];

    // EventGrid subscription validation handshake (one-time per registration).
    for (const evt of events) {
        if (evt?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent' && evt?.data?.validationCode) {
            console.log('[TeamsSDK] EventGrid validation handshake');
            return res.status(200).json({ validationResponse: evt.data.validationCode });
        }
    }

    // Process ACS events.
    for (const evt of events) {
        try {
            await teamsSdk.handleAcsEvent(evt);
        } catch (err) {
            console.error('[TeamsSDK] handleAcsEvent failed:', err.message);
        }
    }

    res.status(200).json({ ok: true });
});

module.exports = router;
