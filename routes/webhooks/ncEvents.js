/**
 * Webhook receiver for NC events forwarded by the Bee Flow connector.
 *
 * The connector subscribes to OCP\User and OCP\Group events via NC's
 * AppAPI events_listener. NC posts to the connector at /webhook/nc-events;
 * the connector signs the payload with the tenant key and forwards here.
 *
 * Auth model:
 *   X-Beeflow-NC-Instance-Id  identifies the org via nc_instance_id.
 *   X-Beeflow-Sig             HMAC-SHA256(tenantKey, ts || method || url || body)
 *                             prefixed with `<unixSeconds>.`
 *   ±5min skew allowed; constant-time compare; tenant-key lookup is
 *   per-org so a leaked key only impersonates that org's connector.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const userStore = require('../../stores/userStore');
const configStore = require('../../stores/configStore');
const sync = require('../../services/ncUserGroupSync');

// We need the raw body bytes for HMAC verification, but downstream wants
// the parsed JSON. express.json() with verify hook captures both.
const captureRaw = express.json({
    limit: '256kb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
});

async function verifySig(req) {
    const instanceId = String(req.headers['x-beeflow-nc-instance-id'] || '');
    if (!instanceId) return null;
    const org = await userStore.getOrganizationByNcInstanceId(instanceId);
    if (!org) return null;
    const tenantKey = await configStore.getSecret(`connector_tenant_key_${org.id}`);
    if (!tenantKey) return null;

    const sigHeader = String(req.headers['x-beeflow-sig'] || '');
    const dot = sigHeader.indexOf('.');
    if (dot === -1) return null;
    const ts = parseInt(sigHeader.slice(0, dot), 10);
    const sig = sigHeader.slice(dot + 1);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return null;

    const message = `${ts}\n${req.method}\n${req.originalUrl}\n${req.rawBody || ''}`;
    const expected = crypto.createHmac('sha256', tenantKey).update(message).digest('hex');
    if (expected.length !== sig.length) return null;
    try {
        if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return null;
    } catch { return null; }
    return org;
}

router.post('/webhook/nc-user-sync', captureRaw, async (req, res) => {
    const org = await verifySig(req);
    if (!org) return res.status(401).json({ error: 'Invalid or missing signature' });

    const { event, ncUid, groupId } = req.body || {};
    if (!event || !ncUid) return res.status(400).json({ error: 'Missing event or ncUid' });

    try {
        let result;
        switch (event) {
            case 'user.created':
            case 'user.updated':
                result = await sync.applyUserCreated(org, ncUid);
                break;
            case 'user.deleted':
                result = await sync.applyUserDeleted(org, ncUid);
                break;
            case 'group.member_added':
            case 'group.member_removed':
                result = await sync.applyGroupMemberChange(org, ncUid, groupId);
                break;
            default:
                return res.status(200).json({ ignored: event });
        }
        return res.json({ ok: true, ...result });
    } catch (e) {
        console.error(`[ncWebhook] ${event} ${ncUid}: ${e.message}`);
        return res.status(500).json({ error: e.message });
    }
});

module.exports = router;
