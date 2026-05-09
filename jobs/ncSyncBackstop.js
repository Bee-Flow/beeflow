/**
 * Periodic NC user/group sync backstop.
 *
 * Real-time NC events (server/routes/webhooks/ncEvents.js) are the primary
 * sync path, but they can drop on NC restart, network blips, or if the
 * connector's events_listener subscription drifts. This cron does a full
 * diff every 6 hours per org so missed events self-heal without admin
 * intervention.
 *
 * Skips orgs that synced via webhook recently (last 30 min) — webhooks are
 * fresher and cheap to trust.
 *
 * No-op for non-NC tenants: itereert alleen orgs met nc_instance_id.
 */

const userStore = require('../stores/userStore');
const ncUserGroupSync = require('../services/ncUserGroupSync');

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const FRESH_WEBHOOK_WINDOW_MS = 30 * 60 * 1000;

const inFlight = new Set();
let _interval = null;

async function runOnce() {
    let orgs;
    try {
        orgs = await userStore.getAllOrganizations();
    } catch (err) {
        console.warn(`[ncSyncBackstop] Could not list orgs: ${err.message}`);
        return;
    }
    const ncOrgs = orgs.filter(o => o.nc_instance_id && (o.nc_sync_mode || 'mirror_all') !== 'manual');
    if (ncOrgs.length === 0) return;

    for (const org of ncOrgs) {
        if (inFlight.has(org.id)) continue;
        const lastSync = org.nc_last_sync_at ? new Date(org.nc_last_sync_at).getTime() : 0;
        if (Date.now() - lastSync < FRESH_WEBHOOK_WINDOW_MS) continue;

        inFlight.add(org.id);
        ncUserGroupSync.runFullSync(org)
            .then(result => {
                if (result?.error) {
                    console.warn(`[ncSyncBackstop] org=${org.id} error=${result.error}`);
                } else if (result) {
                    const drift = (result.created || 0) + (result.deactivated || 0);
                    if (drift > 0) {
                        console.log(`[ncSyncBackstop] org=${org.id} drift-corrected created=${result.created} deactivated=${result.deactivated} groupsCreated=${result.groupsCreated}`);
                    }
                }
            })
            .catch(err => {
                console.warn(`[ncSyncBackstop] org=${org.id} threw: ${err.message}`);
            })
            .finally(() => inFlight.delete(org.id));
    }
}

function start() {
    if (_interval) return;
    // Stagger first run by 5 min after boot so we don't compete with init load.
    setTimeout(() => { runOnce().catch(() => { }); }, 5 * 60 * 1000).unref?.();
    _interval = setInterval(() => { runOnce().catch(() => { }); }, SIX_HOURS_MS);
    if (typeof _interval.unref === 'function') _interval.unref();
    console.log('[ncSyncBackstop] Scheduled (every 6h, 30min webhook freshness window)');
}

function stop() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
}

module.exports = { start, stop, runOnce };
