/**
 * GDPR Art. 35 — Data Protection Impact Assessment for high-risk processing.
 *
 * Per-source check: subjects = published agents heuristically classified as
 * high-risk. A subject passes if a current DPIA row exists for it (either
 * attestation-mode or questionnaire-mode, user-configurable).
 *
 * High-risk heuristic (Art. 35(3) and EDPB guidance):
 *   - agent.config indicates automated decision-making OR PII categories
 *   - agent.system_prompt mentions decisions ("approve", "deny", "recommend"...)
 *   - external provider in agent.model (cross-border processing)
 *
 * The heuristic deliberately errs on the side of "high-risk" — a false flag
 * forces a 30-second attestation, which is cheap; a missed high-risk agent
 * is a real Art. 35 breach.
 */

const { getAll } = require('../../../db');
const dpiaStore = require('../../../stores/dpiaStore');

const DECISION_KEYWORDS = /\b(approve|deny|reject|recommend|score|classif|decid|grade|rank|verdict)\w*\b/i;
const EXTERNAL_PROVIDER_PREFIXES = /\b(openai|claude|anthropic|google|google-vertex|azure|mistral|cohere|groq|together|fireworks|perplexity)\b/i;

function _parseConfig(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try { return JSON.parse(value) || {}; } catch { return {}; }
}

function _isHighRisk(agent) {
    const cfg = _parseConfig(agent.config);
    if (cfg.automated_decision_making) return { reason: 'automated_decision_making flag' };
    if (Array.isArray(cfg.pii_categories) && cfg.pii_categories.length > 0) {
        return { reason: `processes PII categories: ${cfg.pii_categories.slice(0, 3).join(', ')}` };
    }
    const prompt = String(agent.system_prompt || '');
    if (DECISION_KEYWORDS.test(prompt)) {
        return { reason: 'system prompt mentions automated decisions' };
    }
    const model = String(agent.model || '');
    if (EXTERNAL_PROVIDER_PREFIXES.test(model)) {
        return { reason: `routes data to external provider (${model.split(/[\/:]/)[0]})` };
    }
    return null;
}

async function _highRiskAgents(orgId) {
    let rows = [];
    try {
        rows = await getAll(`
            SELECT id, name, model, system_prompt, config, organization_id
            FROM agents WHERE is_published = TRUE
        `);
    } catch {
        return [];
    }
    const out = [];
    for (const a of rows) {
        if (orgId && a.organization_id && a.organization_id !== orgId) continue;
        const risk = _isHighRisk(a);
        if (risk) out.push({ id: a.id, label: a.name || `agent-${a.id}`, risk_reason: risk.reason });
    }
    return out;
}

module.exports = {
    id: 'GDPR-Art35-dpia-high-risk',
    regulation: 'GDPR',
    article: '35',
    severity: 'high',
    scope: 'per-source',
    titleKey: 'compliance.checks.gdpr_art35.title',
    descriptionKey: 'compliance.checks.gdpr_art35.desc',
    remediationKey: 'compliance.checks.gdpr_art35.fix',
    remediationLink: 'admin/compliance?expand=dpia',

    async listSubjects(orgId) {
        return _highRiskAgents(orgId);
    },

    async evaluate(orgId, subject) {
        if (!subject?.id) {
            return { status: 'not_applicable', evidence: {}, details: 'No high-risk agent to assess.' };
        }
        const dpia = await dpiaStore.getLatestForAgent(orgId, subject.id);
        if (!dpia) {
            return {
                status: 'fail',
                evidence: { agent_id: subject.id, agent_name: subject.label, risk_reason: subject.risk_reason },
                details: `No DPIA on record for "${subject.label}" — required because it ${subject.risk_reason}.`,
            };
        }
        const current = dpiaStore.isCurrent(dpia);
        if (!current) {
            return {
                status: 'warn',
                evidence: {
                    agent_id: subject.id, agent_name: subject.label,
                    mode: dpia.mode, approved_at: dpia.approved_at, expires_at: dpia.expires_at,
                    risk_reason: subject.risk_reason,
                },
                details: `DPIA for "${subject.label}" has expired (${dpia.expires_at}). Re-attest under Compliance → DPIA.`,
            };
        }
        return {
            status: 'pass',
            evidence: {
                agent_id: subject.id, agent_name: subject.label,
                mode: dpia.mode, approved_at: dpia.approved_at,
                approved_by: dpia.approved_by, expires_at: dpia.expires_at,
                risk_reason: subject.risk_reason,
            },
            details: `DPIA on record (${dpia.mode}) — last approved ${new Date(dpia.approved_at).toISOString().slice(0, 10)}.`,
        };
    },
};
