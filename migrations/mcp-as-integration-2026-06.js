/**
 * Migration: MCP servers ARE integrations.
 *
 * MCP servers used to be a separate capability "kind" with their own plan
 * column (`subscription_plans.allowed_mcp_servers`) and their own org grant
 * location (`organizations.org_granted_capabilities`, holding `mcp:<id>` ids).
 * The unification folds MCP into the integration path:
 *
 *   A. Plans: fold `allowed_mcp_servers` into `allowed_integrations`, then clear
 *      the dormant column. CRUCIAL: a plan with `allowed_integrations = NULL`
 *      used to mean "all integrations" AND separately allow its MCP servers.
 *      Under the new rule a NULL cap excludes MCP, so we materialise NULL into
 *      an explicit array of [all catalog integration ids + the mcp ids] to keep
 *      those servers available to orgs on that plan.
 *
 *   B. Orgs: move `mcp:<id>` ids out of `org_granted_capabilities` into
 *      `org_enabled_integrations` (the integration grant path), then strip them
 *      from the granted column.
 *
 * Idempotent: A only touches plans where `allowed_mcp_servers IS NOT NULL`
 * (cleared after folding); B only touches orgs whose `org_granted_capabilities`
 * still contains an `mcp:` id (removed after moving). Safe to run repeatedly.
 */

const { getAll, run } = require('../db');

function parseList(v) {
    if (v == null) return null;
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch (_) { return null; } }
    return null;
}

function catalogIntegrationIds() {
    try {
        const registry = require('../core/capabilityRegistry');
        return registry.listCapabilities()
            .filter(c => c.kind === 'integration' && !c._mcpServer)
            .map(c => c.id);
    } catch (_) { return []; }
}

async function up() {
    // ── A. Plans: allowed_mcp_servers → allowed_integrations ──────────────
    try {
        const plans = await getAll(`SELECT id, allowed_integrations, allowed_mcp_servers
                                      FROM subscription_plans
                                     WHERE allowed_mcp_servers IS NOT NULL`);
        const catalog = catalogIntegrationIds();
        for (const p of (plans || [])) {
            const mcp = parseList(p.allowed_mcp_servers) || [];
            if (mcp.length === 0) {
                await run(`UPDATE subscription_plans SET allowed_mcp_servers = NULL WHERE id = $1`, [p.id]);
                continue;
            }
            const integ = parseList(p.allowed_integrations); // null ⇒ was "all integrations"
            const next = integ == null
                ? [...new Set([...catalog, ...mcp])]   // materialise: keep all catalog + the mcp servers
                : [...new Set([...integ, ...mcp])];
            await run(`UPDATE subscription_plans SET allowed_integrations = $1, allowed_mcp_servers = NULL WHERE id = $2`,
                [JSON.stringify(next), p.id]);
            console.log(`[mcp-as-integration] plan ${p.id}: folded ${mcp.length} MCP server(s) into allowed_integrations`);
        }
    } catch (e) {
        // Column may not exist on very old installs — that just means nothing to fold.
        console.warn('[mcp-as-integration] plan fold skipped:', e.message);
    }

    // ── B. Orgs: org_granted_capabilities mcp:<id> → org_enabled_integrations ──
    try {
        const orgs = await getAll(`SELECT id, "org_granted_capabilities", "org_enabled_integrations"
                                     FROM organizations
                                    WHERE "org_granted_capabilities" LIKE '%mcp:%'`);
        for (const o of (orgs || [])) {
            const granted = parseList(o.org_granted_capabilities) || [];
            const mcpIds = granted.filter(id => typeof id === 'string' && id.startsWith('mcp:'));
            if (mcpIds.length === 0) continue;
            const keep = granted.filter(id => !(typeof id === 'string' && id.startsWith('mcp:')));
            const enabled = parseList(o.org_enabled_integrations) || [];
            const nextEnabled = [...new Set([...enabled, ...mcpIds])];
            await run(`UPDATE organizations SET "org_granted_capabilities" = $1, "org_enabled_integrations" = $2 WHERE id = $3`,
                [JSON.stringify(keep), JSON.stringify(nextEnabled), o.id]);
            console.log(`[mcp-as-integration] org ${o.id}: moved ${mcpIds.length} MCP grant(s) to org_enabled_integrations`);
        }
    } catch (e) {
        console.warn('[mcp-as-integration] org grant move skipped:', e.message);
    }
}

module.exports = { up };
