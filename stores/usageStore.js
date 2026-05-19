/**
 * Usage Store - Tracks AI API usage (tokens, models, agents, tools)
 * PostgreSQL-backed logging for monitoring dashboard.
 */

const { run, getOne, getAll, exec } = require('../db');
const { computeCost } = require('../core/modelCosts');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS ai_usage_log (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            user_id TEXT,
            agent_id TEXT,
            agent_name TEXT,
            agent_type TEXT DEFAULT 'chat',
            model TEXT,
            prompt_tokens INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            cached_tokens INTEGER DEFAULT 0,
            cache_creation_tokens INTEGER DEFAULT 0,
            reasoning_tokens INTEGER DEFAULT 0,
            cache_ttl TEXT,
            stop_reason TEXT,
            parent_call_id TEXT,
            swarm_run_id TEXT,
            tool_name TEXT,
            source TEXT DEFAULT 'unknown',
            duration_ms INTEGER DEFAULT 0,
            organization_id TEXT,
            estimated_cost REAL DEFAULT 0,
            conversation_id TEXT
        )
    `);
    // Add cached_tokens column if table already exists (safe for existing installs)
    try { await exec(`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cached_tokens INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
    // cache_creation_tokens — Anthropic returns this separately so we can tell
    // a write-and-discard (paid +25%/100% surcharge) apart from a true read
    // (paid -90%). Without the split, dashboards conflate the two.
    try { await exec(`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
    // reasoning_tokens — OpenAI o-series + GPT-5, Gemini thoughtsTokenCount.
    // Already counted in completion_tokens for billing; tracked separately so
    // dashboards can show the reasoning vs. visible-output split.
    try { await exec(`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS reasoning_tokens INTEGER DEFAULT 0`); } catch (e) { /* ignore */ }
    // cache_ttl — '5m' or '1h' for Anthropic cache writes. Without the TTL we
    // can't price cache_creation_tokens correctly (1.25× input vs 2× input).
    try { await exec(`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS cache_ttl TEXT`); } catch (e) { /* ignore */ }
    // stop_reason / finish_reason — distinguishes natural completion from
    // max_tokens truncation. Truncations often mean replies were cut off.
    try { await exec(`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS stop_reason TEXT`); } catch (e) { /* ignore */ }
    // swarm_run_id / parent_call_id — group orchestrator + sub-agent rows
    // belonging to a single swarm invocation so per-swarm cost is derivable.
    try { await exec(`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS parent_call_id TEXT`); } catch (e) { /* ignore */ }
    try { await exec(`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS swarm_run_id TEXT`); } catch (e) { /* ignore */ }
    // billed_cost — for PAYG (metered) subscriptions, the marked-up cost we
    // reported to Stripe at log time. NULL on fixed-plan rows so dashboards
    // can distinguish "this org never had PAYG history" from "PAYG cost 0".
    try { await exec(`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS billed_cost REAL`); } catch (e) { /* ignore */ }
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON ai_usage_log(timestamp DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_model ON ai_usage_log(model)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_agent ON ai_usage_log(agent_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_user ON ai_usage_log(user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_org ON ai_usage_log(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_conversation ON ai_usage_log(conversation_id)`);
    // Swarm aggregation indexes
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_usage_swarm_run ON ai_usage_log(swarm_run_id) WHERE swarm_run_id IS NOT NULL`); } catch (e) { /* ignore */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_usage_parent_call ON ai_usage_log(parent_call_id) WHERE parent_call_id IS NOT NULL`); } catch (e) { /* ignore */ }
    // Phase 2: composite index for the most common dashboard query pattern:
    // filter by org + date range, ordered by most recent first
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_org_timestamp ON ai_usage_log(organization_id, timestamp DESC)`);
    // Phase 8: additional composite indexes for common filter combos
    // user-scoped date-range queries (user dashboard)
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_user_timestamp ON ai_usage_log(user_id, timestamp DESC)`);
    // agent breakdown queries
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_agent_timestamp ON ai_usage_log(agent_id, timestamp DESC)`);
    // partial index: tool_name IS NOT NULL — getToolUsage() filters this column
    try {
        await exec(`CREATE INDEX IF NOT EXISTS idx_usage_tool_name ON ai_usage_log(tool_name) WHERE tool_name IS NOT NULL`);
    } catch (e) { /* ignore */ }

    // PAYG meter event outbox — durable queue for Stripe meter event delivery.
    // The hot path inserts a row here instead of firing-and-forgetting to
    // Stripe; a background drain worker (server/workers/paygDrain.js) picks
    // them up, calls Stripe, and stamps delivered_at on success. Survives
    // Stripe outages and process crashes without losing billing.
    await exec(`
        CREATE TABLE IF NOT EXISTS payg_meter_outbox (
            id SERIAL PRIMARY KEY,
            usage_log_id INTEGER NOT NULL,
            stripe_customer_id TEXT NOT NULL,
            event_name TEXT NOT NULL,
            amount_micro_units BIGINT NOT NULL,
            identifier TEXT NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TIMESTAMPTZ,
            last_error TEXT,
            delivered_at TIMESTAMPTZ
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_payg_outbox_pending ON payg_meter_outbox(created_at) WHERE delivered_at IS NULL`);

    initialized = true;

}

initDB().catch(err => console.error('[UsageStore] Init error:', err.message));
console.log('[UsageStore] Initialized (PostgreSQL)');

// ============ PAYG meter event resolver ============
// Per-subscriber cache: avoid hitting the DB for every AI call. Plan +
// subscription rows mutate rarely (admin actions, Stripe webhooks); a 60s
// TTL is enough for fresh-enough billing while keeping the hot path cheap.
// Callers that mutate subscription state should call invalidatePaygCache
// (see userStore.setOrgSubscription / setConsumerSubscription).
const _paygCache = new Map();
const PAYG_CACHE_TTL_MS = 60_000;

async function _resolvePaygTarget(organizationId, userId) {
    // Self-hosted installs have no PAYG plan and no Stripe wiring. Skip the
    // resolver entirely so the AI hot path is free of billing lookups when
    // DEPLOYMENT_MODE is anything other than cloud.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'self-hosted') return null;
    if (!organizationId && !userId) return null;
    const key = organizationId ? `org:${organizationId}` : `user:${userId}`;
    const hit = _paygCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    let row = null;
    try {
        if (organizationId) {
            row = await getOne(`
                SELECT os.stripe_customer_id, os.status,
                       sp.billing_model, sp.markup_percent, sp.stripe_meter_event_name, sp.currency
                  FROM organization_subscriptions os
             LEFT JOIN subscription_plans sp ON sp.id = os.plan_id
                 WHERE os.organization_id = $1`, [organizationId]);
        } else {
            row = await getOne(`
                SELECT cs.stripe_customer_id, cs.status,
                       sp.billing_model, sp.markup_percent, sp.stripe_meter_event_name, sp.currency
                  FROM consumer_subscriptions cs
             LEFT JOIN subscription_plans sp ON sp.id = cs.plan_id
                 WHERE cs.user_id = $1`, [userId]);
        }
    } catch (e) {
        // Bad DB state shouldn't throw on the AI hot path; cache the miss
        // so we don't retry the failing query on every call.
        console.error('[UsageStore] _resolvePaygTarget query failed:', e.message);
    }

    const eligible = !!row
        && row.billing_model === 'metered'
        && row.stripe_customer_id
        && row.stripe_meter_event_name
        && ['active', 'trialing', 'past_due'].includes(row.status || 'active');
    const value = eligible ? {
        stripeCustomerId: row.stripe_customer_id,
        markupPercent: Number(row.markup_percent || 0),
        meterEventName: row.stripe_meter_event_name,
        currency: (row.currency || 'EUR').toUpperCase(),
    } : null;
    _paygCache.set(key, { value, expiresAt: Date.now() + PAYG_CACHE_TTL_MS });
    return value;
}

// Per-subscriber currency cache for fixed-plan AI calls. PAYG calls already
// learn the plan currency from `_resolvePaygTarget`; this is just for
// fixed-plan and consumer-default callers so the USD→currency conversion
// is applied uniformly across all rows. Shares the PAYG cache map: keys
// are prefixed with `cur:` to avoid collision.
async function _resolvePlanCurrency(organizationId, userId) {
    if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'self-hosted') return 'USD';
    if (!organizationId && !userId) return 'EUR';
    const key = organizationId ? `cur:org:${organizationId}` : `cur:user:${userId}`;
    const hit = _paygCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    let currency = 'EUR';
    try {
        const row = organizationId
            ? await getOne(`SELECT sp.currency FROM organization_subscriptions os LEFT JOIN subscription_plans sp ON sp.id = os.plan_id WHERE os.organization_id = $1`, [organizationId])
            : await getOne(`SELECT sp.currency FROM consumer_subscriptions cs LEFT JOIN subscription_plans sp ON sp.id = cs.plan_id WHERE cs.user_id = $1`, [userId]);
        if (row?.currency) currency = String(row.currency).toUpperCase();
    } catch (e) {
        console.error('[UsageStore] _resolvePlanCurrency query failed:', e.message);
    }
    _paygCache.set(key, { value: currency, expiresAt: Date.now() + PAYG_CACHE_TTL_MS });
    return currency;
}

function invalidatePaygCache(organizationId, userId) {
    if (organizationId) _paygCache.delete(`org:${organizationId}`);
    if (userId) _paygCache.delete(`user:${userId}`);
    // Both args null → clear the whole cache. Used by global config changes
    // (FX rate updates) that affect every cached entry.
    if (!organizationId && !userId) _paygCache.clear();
}

// ============ Logging ============

async function logUsage(entry) {
    await initDB();
    try {
        const now = new Date().toISOString();
        const promptTokens = entry.prompt_tokens || 0;
        const completionTokens = entry.completion_tokens || 0;
        const cachedTokens = entry.cached_tokens || 0;
        const cacheCreationTokens = entry.cache_creation_tokens || 0;
        const reasoningTokens = entry.reasoning_tokens || 0;
        const cacheTtl = entry.cache_ttl || null;
        const stopReason = entry.stop_reason || null;
        const parentCallId = entry.parent_call_id || null;
        const swarmRunId = entry.swarm_run_id || null;
        const model = entry.model || 'unknown';
        // Cache-aware cost: cached reads at provider discount, cache writes at
        // TTL-specific premium (Anthropic 1.25× for 5m, 2× for 1h). USD —
        // modelCosts works in LiteLLM's native USD per 1M tokens.
        const costUsd = computeCost(model, promptTokens, completionTokens, cachedTokens, cacheCreationTokens, cacheTtl);

        // Resolve PAYG target up front (cached, <1ms after warmup) so we can
        // persist the marked-up `billed_cost` alongside the raw cost in a
        // single INSERT. Same target value is reused for the Stripe meter
        // event below, ensuring local history and Stripe stay in sync.
        const paygTarget = (costUsd > 0)
            ? await _resolvePaygTarget(entry.organization_id || null, entry.user_id || null).catch(err => {
                console.error('[UsageStore] PAYG resolve failed:', err.message);
                return null;
            })
            : null;

        // Convert USD → plan currency. PAYG target carries the plan currency;
        // for fixed-plan or no-subscription callers, fall back to a separate
        // lightweight lookup. Stripe meter events report micro-units in the
        // plan's currency, so the local cost columns must match.
        let targetCurrency = 'USD';
        if (costUsd > 0) {
            if (paygTarget?.currency) {
                targetCurrency = paygTarget.currency;
            } else if (entry.organization_id || entry.user_id) {
                targetCurrency = await _resolvePlanCurrency(entry.organization_id || null, entry.user_id || null).catch(() => 'EUR');
            } else {
                targetCurrency = 'EUR'; // matches subscription_plans.currency default
            }
        }
        // FX lookup. For PAYG customers a silent fallback to 1.0 would bill
        // the USD figure as if it were EUR (a 5–15 % under-bill or over-bill
        // depending on the pair). When we have a paying customer on a
        // non-USD currency and the rate provider fails, refuse to log so the
        // caller surfaces "billing service degraded" instead of writing the
        // wrong number to ai_usage_log. For non-PAYG callers, 1.0 is a safe
        // reporting fallback — the column is informational only.
        //
        // The currency helper handles three layers of resilience:
        //   1. 5-minute hot cache for the resolved rate
        //   2. 24-hour last-good cache for transient configStore failures
        //   3. `strict: true` (PAYG only) — throw on cache miss + lookup
        //      failure, rather than silently substituting 1.0.
        let fxRate = 1;
        if (costUsd > 0 && targetCurrency !== 'USD') {
            const currency = require('../core/currency');
            try {
                fxRate = await currency.getUsdToCurrencyRate(targetCurrency, { strict: !!paygTarget });
            } catch (e) {
                if (paygTarget) {
                    // Re-throw so the LLM handler surfaces 503 to the user.
                    throw e;
                }
                console.error(`[UsageStore] FX rate lookup failed for USD→${targetCurrency} (non-PAYG): ${e.message}`);
                fxRate = 1;
            }
            if (fxRate == null || !isFinite(fxRate) || fxRate <= 0) {
                if (paygTarget) {
                    throw new Error(`fx_rate_unavailable: USD→${targetCurrency}`);
                }
                fxRate = 1;
            }
        }
        const cost = costUsd * fxRate;
        const billedCost = paygTarget ? cost * (1 + paygTarget.markupPercent / 100) : null;

        const insertResult = await run(`
            INSERT INTO ai_usage_log (timestamp, user_id, agent_id, agent_name, agent_type, model, prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_creation_tokens, reasoning_tokens, cache_ttl, stop_reason, parent_call_id, swarm_run_id, tool_name, source, duration_ms, organization_id, estimated_cost, billed_cost, conversation_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
            RETURNING id
        `, [
            entry.timestamp || now,
            entry.user_id || null,
            entry.agent_id || null,
            entry.agent_name || null,
            entry.agent_type || 'chat',
            model,
            promptTokens,
            completionTokens,
            entry.total_tokens || (promptTokens + completionTokens),
            cachedTokens,
            cacheCreationTokens,
            reasoningTokens,
            cacheTtl,
            stopReason,
            parentCallId,
            swarmRunId,
            entry.tool_name || null,
            entry.source || 'unknown',
            entry.duration_ms || 0,
            entry.organization_id || null,
            cost,
            billedCost,
            entry.conversation_id || null
        ]);
        if (cachedTokens > 0) {
            console.log(`[UsageStore] 💰 Cache savings: ${cachedTokens} cached tokens (model: ${model})`);
        }

        // PAYG meter reporting — enqueue in the outbox so a Stripe outage or
        // process crash can't drop billing. The drain worker
        // (server/workers/paygDrain.js) picks it up, retries with backoff,
        // and stamps delivered_at on success. Identifier doubles as Stripe's
        // idempotency key (24h window) and our local dedup key.
        if (paygTarget && billedCost > 0) {
            const insertedId = insertResult?.rows?.[0]?.id;
            if (insertedId !== undefined) {
                // Marked-up cost expressed in micro-units of the plan currency
                // (price = 0.000001 per meter unit → 1.00 EUR worth of usage =
                // 1_000_000 meter units).
                const amountMicroUnits = Math.round(billedCost * 1_000_000);
                if (amountMicroUnits > 0) {
                    const identifier = `usage_${insertedId}`;
                    try {
                        await run(
                            `INSERT INTO payg_meter_outbox (usage_log_id, stripe_customer_id, event_name, amount_micro_units, identifier)
                             VALUES ($1, $2, $3, $4, $5)
                             ON CONFLICT (identifier) DO NOTHING`,
                            [insertedId, paygTarget.stripeCustomerId, paygTarget.meterEventName, amountMicroUnits, identifier]
                        );
                    } catch (e) {
                        console.error('[UsageStore] PAYG outbox enqueue failed:', e.message, { identifier });
                    }
                    // Best-effort happy-path: try once now. If it succeeds the
                    // drain worker has nothing to do. If it fails or never
                    // fires (process crash), the worker catches up.
                    setImmediate(() => {
                        try {
                            require('../workers/paygDrain').drainOne(identifier).catch(() => {});
                        } catch (_) { /* drain not yet loaded */ }
                    });
                }
            }
        }
    } catch (e) {
        // FX-rate failures for PAYG customers must propagate — the caller
        // is responsible for failing the request rather than silently
        // accepting a miscalculated bill. All other usage-log errors stay
        // best-effort (logging must not break the chat path for fixed
        // plans).
        if (e && typeof e.message === 'string' && e.message.startsWith('fx_rate_unavailable:')) {
            console.error('[UsageStore] PAYG usage rejected:', e.message);
            throw e;
        }
        console.error('[UsageStore] Failed to log usage:', e.message);
    }
}

// ============ Queries ============

// Cost-bearing queries pass excludeToolRows=true so per-tool zero-token rows
// don't inflate call counts or distort cost summaries. The /tools endpoint
// uses a separate filter (`tool_name IS NOT NULL`) to count those rows.
function buildFilters(filters, startIdx = 1, excludeToolRows = false) {
    const conditions = [];
    const params = [];
    let idx = startIdx;
    if (excludeToolRows) {
        conditions.push(`tool_name IS NULL`);
    }
    if (filters?.startDate) {
        conditions.push(`timestamp >= $${idx++}`);
        params.push(filters.startDate);
    }
    if (filters?.endDate) {
        conditions.push(`timestamp <= $${idx++}`);
        params.push(filters.endDate);
    }
    if (filters?.organizationId) {
        conditions.push(`organization_id = $${idx++}`);
        params.push(filters.organizationId);
    }
    if (filters?.userId) {
        conditions.push(`user_id = $${idx++}`);
        params.push(filters.userId);
    }
    if (filters?.agentId) {
        conditions.push(`agent_id = $${idx++}`);
        params.push(filters.agentId);
    }
    if (filters?.model) {
        conditions.push(`model = $${idx++}`);
        params.push(filters.model);
    }
    if (filters?.source) {
        conditions.push(`source = $${idx++}`);
        params.push(filters.source);
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, nextIdx: idx };
}

async function getUsageSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getOne(`
        SELECT
            COUNT(*) as total_calls,
            COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(cached_tokens), 0) as total_cached_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens,
            COALESCE(SUM(reasoning_tokens), 0) as total_reasoning_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COUNT(DISTINCT model) as unique_models,
            COUNT(DISTINCT agent_id) as unique_agents,
            COUNT(DISTINCT user_id) as unique_users,
            COALESCE(SUM(estimated_cost), 0) as total_estimated_cost,
            COALESCE(SUM(billed_cost), 0) as total_billed_cost,
            COUNT(*) FILTER (WHERE billed_cost IS NOT NULL) as billed_calls
        FROM ai_usage_log ${where}
    `, params);
}

async function getUsageByModel(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getAll(`
        SELECT
            model,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(cached_tokens), 0) as cached_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
            COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY model
        ORDER BY total_tokens DESC
    `, params);
}

async function getUsageByAgent(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getAll(`
        SELECT
            agent_id, agent_name, agent_type,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY agent_id, agent_name, agent_type
        ORDER BY total_tokens DESC
    `, params);
}

async function getUsageTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} as period,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(cached_tokens), 0) as cached_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

async function getToolUsage(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    const toolWhere = where
        ? where + ' AND tool_name IS NOT NULL'
        : 'WHERE tool_name IS NOT NULL';
    return getAll(`
        SELECT
            tool_name,
            COUNT(*) as calls,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms
        FROM ai_usage_log ${toolWhere}
        GROUP BY tool_name
        ORDER BY calls DESC
    `, params);
}

async function getRecentCalls(limit = 50, filters = {}) {
    await initDB();
    const conditions = [];
    const params = [];
    let idx = 1;

    if (filters?.organizationId) {
        conditions.push(`organization_id = $${idx++}`);
        params.push(filters.organizationId);
    }
    if (filters?.source) {
        conditions.push(`source = $${idx++}`);
        params.push(filters.source);
    }
    if (filters?.model) {
        conditions.push(`model = $${idx++}`);
        params.push(filters.model);
    }
    if (filters?.search) {
        const term = `%${filters.search}%`;
        conditions.push(`(agent_name ILIKE $${idx} OR user_id ILIKE $${idx + 1} OR model ILIKE $${idx + 2})`);
        params.push(term, term, term);
        idx += 3;
    }
    if (filters?.startDate) {
        conditions.push(`timestamp >= $${idx++}`);
        params.push(filters.startDate);
    }
    if (filters?.endDate) {
        conditions.push(`timestamp <= $${idx++}`);
        params.push(filters.endDate);
    }
    // Phase 8: default 30-day guard when no date filter is set.
    // Without this, getRecentCalls with no filters scans the entire table
    // even though LIMIT is set — ORDER BY timestamp DESC + the timestamp index
    // means PG stops after reading `limit` rows from the index.
    if (!filters?.startDate && !filters?.endDate) {
        conditions.push(`timestamp >= NOW() - INTERVAL '30 days'`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return getAll(`
        SELECT * FROM ai_usage_log
        ${where}
        ORDER BY timestamp DESC
        LIMIT $${idx}
    `, [...params, limit]);
}

async function getCostTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} as period,
            COUNT(*) as calls,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            COALESCE(SUM(billed_cost), 0) as total_billed_cost,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens
        FROM ai_usage_log ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

async function getUsageSources() {
    await initDB();
    // Phase 8: use the timestamp index to scan only recent data for the distinct list;
    // sources don't change often so last 90 days is representative
    const rows = await getAll(`
        SELECT DISTINCT source FROM ai_usage_log
        WHERE source IS NOT NULL
          AND timestamp >= NOW() - INTERVAL '90 days'
        ORDER BY source ASC
    `);
    return rows.map(r => r.source);
}

async function getUsageModels() {
    await initDB();
    // Phase 8: same bounded approach as getUsageSources
    const rows = await getAll(`
        SELECT DISTINCT model FROM ai_usage_log
        WHERE model IS NOT NULL
          AND timestamp >= NOW() - INTERVAL '90 days'
        ORDER BY model ASC
    `);
    return rows.map(r => r.model);
}

async function getUsageBySource(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getAll(`
        SELECT source, COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY source
        ORDER BY total_tokens DESC
    `, params);
}

async function getUsageByUser(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getAll(`
        SELECT user_id, COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY user_id
        ORDER BY total_tokens DESC
    `, params);
}

async function getUsageByConversation(filters = {}) {
    await initDB();
    const { where, params, nextIdx } = buildFilters(filters, 1, true);
    const extraWhere = where ? where + ' AND conversation_id IS NOT NULL' : 'WHERE conversation_id IS NOT NULL';
    return getAll(`
        SELECT conversation_id, agent_name, agent_id,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            MIN(timestamp) as first_call,
            MAX(timestamp) as last_call,
            STRING_AGG(DISTINCT model, ', ') as models_used,
            STRING_AGG(DISTINCT source, ', ') as sources_used
        FROM ai_usage_log ${extraWhere}
        GROUP BY conversation_id, agent_name, agent_id
        ORDER BY last_call DESC
        LIMIT 200
    `, params);
}

async function getUsageByAgentType(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getAll(`
        SELECT COALESCE(agent_type, 'chat') as agent_type,
            COUNT(*) as calls,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY agent_type
    `, params);
}

async function getUsageByModelAndAgent(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getAll(`
        SELECT
            model,
            COALESCE(agent_name, 'Direct Chat') as agent_name,
            agent_id,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY model, agent_name, agent_id
        ORDER BY total_tokens DESC
    `, params);
}

async function getUsageByModelAndUser(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1, true);
    return getAll(`
        SELECT
            model,
            user_id,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY model, user_id
        ORDER BY total_tokens DESC
    `, params);
}

// Per-swarm-run roll-up: groups orchestrator + worker rows by swarm_run_id
// so dashboards can attribute total spend to a single swarm invocation.
async function getUsageBySwarmRun(filters = {}) {
    await initDB();
    const { where, params, nextIdx } = buildFilters(filters, 1, true);
    const extraWhere = where ? where + ' AND swarm_run_id IS NOT NULL' : 'WHERE swarm_run_id IS NOT NULL';
    return getAll(`
        SELECT
            swarm_run_id,
            COUNT(*) as phase_count,
            COUNT(DISTINCT agent_id) as agent_count,
            COALESCE(SUM(CASE WHEN parent_call_id IS NULL THEN total_tokens ELSE 0 END), 0) as orchestrator_tokens,
            COALESCE(SUM(CASE WHEN parent_call_id IS NOT NULL THEN total_tokens ELSE 0 END), 0) as worker_tokens,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
            COALESCE(SUM(cached_tokens), 0) as cached_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            MIN(timestamp) as started_at,
            MAX(timestamp) as ended_at,
            STRING_AGG(DISTINCT agent_name, ', ') as agents_used,
            STRING_AGG(DISTINCT model, ', ') as models_used
        FROM ai_usage_log ${extraWhere}
        GROUP BY swarm_run_id
        ORDER BY ended_at DESC
        LIMIT 200
    `, params);
}

module.exports = {
    logUsage,
    getUsageSummary,
    getUsageByModel,
    getUsageByAgent,
    getUsageTimeline,
    getToolUsage,
    getRecentCalls,
    getUsageBySource,
    getUsageByUser,
    getCostTimeline,
    getUsageSources,
    getUsageModels,
    getUsageByConversation,
    getUsageByAgentType,
    getUsageByModelAndAgent,
    getUsageByModelAndUser,
    getUsageBySwarmRun,
    invalidatePaygCache,
};
