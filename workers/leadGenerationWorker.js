/**
 * Lead Generation Worker — drains lead_generation_jobs and runs each campaign's
 * AI discovery/enrichment/compaction pipeline.
 *
 * Pattern mirrors workers/scanRunner.js: claim outbox rows under
 * claimDueJobs() (SELECT … FOR UPDATE SKIP LOCKED) respecting per-user/org/
 * global concurrency caps, run the campaign, mark finished. Unlike the scan
 * runner there are no containers — the work is HTTP/LLM calls — so there is no
 * docker gate or reaper. Transient worker exceptions bump attempt_count and the
 * backoff retries on the next tick.
 */

const crypto = require('crypto');
const leadStudioStore = require('../stores/leadStudioStore');
const leadGenerationRunner = require('../services/leadGenerationRunner');

const WORKER_ID = `lg-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

const MAX_PER_USER = Math.max(1, parseInt(process.env.LEAD_STUDIO_MAX_CONCURRENT_PER_USER || '1', 10));
const MAX_PER_ORG = Math.max(1, parseInt(process.env.LEAD_STUDIO_MAX_CONCURRENT_PER_ORG || '2', 10));
const MAX_GLOBAL = Math.max(1, parseInt(process.env.LEAD_STUDIO_MAX_CONCURRENT_GLOBAL || '3', 10));

const HARD_FAIL_DAYS = 7;
function isHardFailed(ageMs) { return ageMs > HARD_FAIL_DAYS * 86_400_000; }

async function processCampaign(claim) {
    const campaignId = claim.campaign_id;
    const userId = claim.created_by || null;

    let outcome;
    try {
        outcome = await leadGenerationRunner.runCampaign({ campaignId });
    } catch (e) {
        outcome = { status: 'error', error: `worker_exception: ${e.message}` };
    }

    if (outcome.status === 'cancelled') {
        // The cancel route already flips the DB row; this is a safety net for a
        // flag-only cancel. markCancelled no-ops if already terminal.
        await leadStudioStore.markCancelled(campaignId, userId).catch(() => {});
    } else if (outcome.status === 'error') {
        await leadStudioStore.markFinished(campaignId, { status: 'error', error: outcome.error || 'unknown_error' });
    } else {
        await leadStudioStore.markFinished(campaignId, { status: 'completed' });
    }
    return { ok: true, status: outcome.status };
}

async function drainOnce(targetCampaignId = null) {
    const claimed = await leadStudioStore.claimDueJobs({
        batchSize: MAX_GLOBAL,
        perUserCap: MAX_PER_USER,
        orgCap: MAX_PER_ORG,
        globalCap: MAX_GLOBAL,
        targetCampaignId,
        workerId: WORKER_ID,
    });
    if (claimed.length === 0) return { processed: 0 };

    let processed = 0;
    for (const claim of claimed) {
        const ageMs = Date.now() - (claim.created_at ? new Date(claim.created_at).getTime() : Date.now());
        if (isHardFailed(ageMs)) {
            await leadStudioStore.markFinished(claim.campaign_id, {
                status: 'error',
                error: `hard_failed_after_${HARD_FAIL_DAYS}_days`,
            }).catch(() => {});
            continue;
        }
        try {
            await processCampaign(claim);
            processed++;
        } catch (e) {
            await leadStudioStore.markRetryable(claim.campaign_id, e.message).catch(() => {});
        }
    }
    return { processed };
}

/** Fast-path: drain a single just-created campaign without waiting for the tick. */
async function drainOne(campaignId) {
    if (!campaignId) return null;
    return drainOnce(campaignId);
}

module.exports = { drainOnce, drainOne, WORKER_ID };
