'use strict';

/**
 * Safety / monitoring backbone for the automation runner.
 *
 * Automations historically bypassed every control that agents and direct chat
 * apply: no PII detection, no regex guardrails, and — critically — no
 * `integration_activity_log` egress rows, so "where did this automation send my
 * data and what type was it" was invisible. This module gives the runner the
 * same pipeline ordering chat uses (PII -> regex -> {LLM/tool} -> PII/regex ->
 * un-tokenize) plus unconditional egress logging.
 *
 * All heavyweight deps are required lazily inside functions to avoid the
 * well-known aiAgent <-> piiDetection require cycle (see piiDetection.js header).
 *
 * Design decisions (see plan):
 *  - Automations INHERIT the org Privacy Shield; no separate enable flag. A
 *    per-automation `definition.safety` block may only TIGHTEN.
 *  - Egress logging is UNCONDITIONAL (every integration_action / ai_step tool
 *    call writes a row for source='routine'); `monitorIntegrations` only gates
 *    the more expensive GLiNER output scan — a lightweight in-process regex scan
 *    always runs so the row still carries detected categories.
 *  - Fail-OPEN when the PII guard is unreachable (parity with chat — never
 *    silently break a scheduled automation), fail-CLOSED on a `block` action
 *    when PII is actually detected.
 *  - In dry-run a `block` is converted to an annotation, never a hard failure,
 *    so the builder preview can show "would block".
 */

class GuardrailBlockError extends Error {
    constructor(message, { violationType = 'pii', categories = [], scope = 'input' } = {}) {
        super(message);
        this.name = 'GuardrailBlockError';
        this.guardrailBlocked = true;
        this.violationType = violationType;
        this.categories = Array.isArray(categories) ? categories : [categories].filter(Boolean);
        this.scope = scope;
    }
}

// ── small utilities ─────────────────────────────────────────────────────────

function _stringify(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

// Map every string leaf of an arbitrary value through an async fn, preserving
// structure. Used to tokenize/redact structured tool inputs/outputs without
// flattening them to a JSON blob.
async function mapStringLeavesAsync(value, fn) {
    if (value == null) return value;
    if (typeof value === 'string') return await fn(value);
    if (Array.isArray(value)) {
        const out = [];
        for (const v of value) out.push(await mapStringLeavesAsync(v, fn));
        return out;
    }
    if (typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) out[k] = await mapStringLeavesAsync(value[k], fn);
        return out;
    }
    return value;
}

// Lightweight, always-available category sniff for egress labelling (no network).
function _quickCategories(text) {
    try {
        const { scanOutputForPii } = require('../integrationToolMap');
        const s = scanOutputForPii(String(text || '').slice(0, 8000));
        return s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
    } catch (_) { return []; }
}

// ── policy resolution (memoized per run on ctx) ─────────────────────────────

async function resolveAutomationPolicy(ctx) {
    if (ctx._safetyPolicy) return ctx._safetyPolicy;

    let shield = null;
    try {
        const { resolveOrgShield } = require('../orgShield');
        shield = await resolveOrgShield(ctx.orgId);
    } catch (_) { /* fail-open */ }

    let aiConfig = {};
    try { aiConfig = (await require('../aiAgent').getAIConfig()) || {}; } catch (_) { /* tolerate */ }

    const override = (ctx.definition && ctx.definition.safety) || {};

    const piiEnabled = !!(aiConfig.piiDetectionEnabled || (shield && shield.enabled) || override.scanEnabled);
    // strictest action wins; override may only tighten relative to the org shield.
    const STRICTNESS = { block: 3, tokenize: 2, redact: 1, off: 0 };
    const baseAction = (shield && shield.piiDetectionAction) || aiConfig.piiDetectionAction || 'block';
    const overrideAction = override.action || null;
    const action = overrideAction && STRICTNESS[overrideAction] > STRICTNESS[baseAction]
        ? overrideAction
        : baseAction;

    const policy = {
        shield,
        piiEnabled,
        action,
        regexRules: (shield && shield.rulesWithNames) || [],
        // egress row is always written; this only gates the GLiNER output scan.
        monitorIntegrations: shield ? shield.monitorIntegrations !== false : true,
        scope: (shield && shield.scope) || { toolInput: true, toolOutput: true, userInput: true, agentOutput: true },
        // 'external' = deliberately keep PII tokenized when it leaves to a third
        // party; 'all'/'internal' = restore real values before egress (default).
        privacyScope: override.privacyScope || (shield && shield.privacyScope) || 'all',
        confidence: (shield && shield.piiDetectionConfidenceThreshold)
            ?? aiConfig.piiDetectionConfidenceThreshold ?? 0.7,
        categories: (shield && shield.piiDetectionCategories) || aiConfig.piiDetectionCategories || null,
    };
    ctx._safetyPolicy = policy;
    return policy;
}

function buildAuditBase(ctx, step) {
    return {
        organization_id: ctx.orgId || null,
        user_id: ctx.userId || null,
        agent_id: null,
        agent_name: ctx.automationTitle || null,
        conversation_id: ctx.automationId || null,   // group all activity per automation
        automation_id: ctx.automationId || null,
        run_id: ctx.runId || null,
        step_id: step && step.id ? step.id : null,
        source: 'routine',
        model: null,
        // Lets resolveIntegration() fill the destination for nextcloud_* tools.
        // When absent the probe still captures the real peer IP, so geo is correct.
        nextcloudUrl: ctx.nextcloudUrl || null,
    };
}

// ── guardrail event helper ──────────────────────────────────────────────────

function _logGuardrail(auditBase, { violation_type, categories, direction, action_taken, isDryRun }) {
    try {
        const store = require('../../stores/guardrailEventStore');
        store.logGuardrailEvent({
            ...auditBase,
            violation_type,
            violation_categories: (categories || []).join(', ') || null,
            direction: direction || 'input',
            action_taken,
            is_dry_run: !!isDryRun,
        }).catch(() => {});
    } catch (_) { /* never fail the run on logging */ }
}

// ── PII/regex scan core ─────────────────────────────────────────────────────

// Run the org-configured GLiNER detector on a single text. Returns null on any
// failure (fail-open) or when nothing is found.
async function _detectPii(text, policy) {
    if (!text || text.length < 3) return null;
    try {
        const { detectPii } = require('../piiDetection');
        const res = await detectPii(String(text).slice(0, 8000), policy.categories, policy.confidence);
        return res && res.hasPii ? res : null;
    } catch (_) { return null; }
}

function _regexHits(text, policy) {
    if (!policy.regexRules || !policy.regexRules.length) return [];
    try {
        const { checkRegexPatterns } = require('../guardrails');
        return checkRegexPatterns(text, policy.regexRules) || [];
    } catch (_) { return []; }
}

/**
 * Guard a structured value (tool inputs OR tool/ai output). Mutates nothing;
 * returns { value, tokenMap, blocked, categories }. Throws GuardrailBlockError
 * on a block action (unless dry-run, where it annotates instead).
 */
async function _guardValue(value, policy, auditBase, { direction, scopeOn, mode }) {
    if (!policy.piiEnabled && !policy.regexRules.length) return { value, tokenMap: null, blocked: false, categories: [] };
    if (scopeOn === false) return { value, tokenMap: null, blocked: false, categories: [] };

    const text = _stringify(value);
    const isDryRun = mode === 'dry_run';

    // Regex guardrails first (cheap, deterministic).
    const rHits = _regexHits(text, policy);
    if (rHits.length) {
        const names = rHits.map(h => h.ruleName);
        if (policy.action === 'block') {
            _logGuardrail(auditBase, { violation_type: 'regex', categories: names, direction, action_taken: 'blocked', isDryRun });
            if (!isDryRun) throw new GuardrailBlockError(`Blocked by guardrail rule(s): ${names.join(', ')}`, { violationType: 'regex', categories: names, scope: direction });
            return { value, tokenMap: null, blocked: true, categories: names, wouldBlock: true };
        }
        // redact: replace matched substrings with a marker on string leaves.
        const redacted = await mapStringLeavesAsync(value, async (s) => {
            let out = s;
            for (const h of rHits) {
                try {
                    const safe = h.pattern.replace(/^\(\?i\)/, '').replace(/^\(\?-[a-z]+\)/, '');
                    out = out.replace(new RegExp(safe, 'gi'), `[REDACTED:${h.ruleName}]`);
                } catch (_) { /* skip bad pattern */ }
            }
            return out;
        });
        _logGuardrail(auditBase, { violation_type: 'regex', categories: names, direction, action_taken: 'redacted', isDryRun });
        value = redacted;
    }

    // PII detection.
    if (policy.piiEnabled) {
        const det = await _detectPii(text, policy);
        if (det) {
            const cats = [...new Set(det.entities.map(e => e.label))];
            if (policy.action === 'block') {
                _logGuardrail(auditBase, { violation_type: 'pii', categories: cats, direction, action_taken: 'blocked', isDryRun });
                if (!isDryRun) throw new GuardrailBlockError(`Blocked: sensitive data detected (${cats.join(', ')})`, { violationType: 'pii', categories: cats, scope: direction });
                return { value, tokenMap: null, blocked: true, categories: cats, wouldBlock: true };
            }
            // tokenize/redact each string leaf, accumulating a shared token map.
            const { tokenizeText } = require('../piiDetection');
            let tokenMap = {};
            const transformed = await mapStringLeavesAsync(value, async (s) => {
                const d2 = await _detectPii(s, policy);
                if (!d2) return s;
                const { tokenizedText, tokenMap: tm } = tokenizeText(s, d2.entities, tokenMap);
                tokenMap = tm;
                return tokenizedText;
            });
            _logGuardrail(auditBase, { violation_type: 'pii', categories: cats, direction, action_taken: 'redacted', isDryRun });
            return { value: transformed, tokenMap, blocked: false, categories: cats };
        }
    }

    return { value, tokenMap: null, blocked: false, categories: rHits.map(h => h.ruleName) };
}

// ── public guards ───────────────────────────────────────────────────────────

async function guardToolInput(inputs, policy, auditBase, mode) {
    return _guardValue(inputs, policy, auditBase, { direction: 'input', scopeOn: policy.scope.toolInput !== false, mode });
}

async function guardToolOutput(result, policy, auditBase, mode) {
    const r = await _guardValue(result, policy, auditBase, { direction: 'output', scopeOn: policy.scope.toolOutput !== false, mode });
    return { result: r.value, blocked: r.blocked, categories: r.categories };
}

/**
 * Guard the messages array of an ai_step before the LLM call. Mutates the last
 * user message in place when tokenizing/redacting (matching the agent runner),
 * and returns { tokenMap, blocked }.
 */
async function guardAiInput(messages, policy, auditBase, mode) {
    if (!policy.piiEnabled && !policy.regexRules.length) return { tokenMap: null, blocked: false };
    if (policy.scope.userInput === false) return { tokenMap: null, blocked: false };
    const isDryRun = mode === 'dry_run';
    const lastUser = messages.slice().reverse().find(m => m.role === 'user');
    if (!lastUser || typeof lastUser.content !== 'string') return { tokenMap: null, blocked: false };

    const guarded = await _guardValue(lastUser.content, policy, auditBase, { direction: 'input', scopeOn: true, mode });
    if (guarded.wouldBlock) return { tokenMap: null, blocked: true, categories: guarded.categories };
    if (guarded.value !== lastUser.content) lastUser.content = guarded.value;
    return { tokenMap: guarded.tokenMap, blocked: false };
}

/**
 * Guard an ai_step's output. On block (default action) throws; otherwise returns
 * the (possibly redacted) output. The caller is responsible for restoreTokens()
 * before writing the value downstream (so the model saw tokens but downstream
 * steps see real values).
 */
async function guardAiOutput(content, policy, auditBase, mode) {
    if (!policy.piiEnabled && !policy.regexRules.length) return { content, blocked: false };
    if (policy.scope.agentOutput === false) return { content, blocked: false };
    const guarded = await _guardValue(content, policy, auditBase, { direction: 'output', scopeOn: true, mode });
    if (guarded.wouldBlock && mode !== 'dry_run') {
        throw new GuardrailBlockError(`Blocked: AI step output contained sensitive data (${(guarded.categories || []).join(', ')})`, { violationType: 'pii', categories: guarded.categories, scope: 'output' });
    }
    return { content: guarded.value, blocked: !!guarded.wouldBlock, categories: guarded.categories };
}

/**
 * Restore tokenized values before they leave the platform to a third party,
 * unless the policy says PII must stay tokenized for external egress.
 */
function restoreForEgress(value, tokenMap, policy) {
    if (!tokenMap || !Object.keys(tokenMap).length) return value;
    if (policy && policy.privacyScope === 'external' && policy.action === 'tokenize') return value; // keep tokenized on purpose
    try {
        const { restoreTokens } = require('../piiDetection');
        return JSON.parse(restoreTokens(JSON.stringify(value), tokenMap));
    } catch (_) { return value; }
}

// ── egress logging (unconditional row; gated GLiNER scan) ────────────────────

async function logEgress({ toolName, toolArgs, result, probe, policy, auditBase, mode }) {
    try {
        const { resolveIntegration } = require('../integrationToolMap');
        const integMeta = resolveIntegration(toolName, toolArgs || {}, { nextcloudUrl: auditBase.nextcloudUrl });
        if (!integMeta) return; // internal / non-integration tool — nothing left the platform

        const payloadText = `${_stringify(toolArgs)}\n${_stringify(result)}`;
        let piiCats = _quickCategories(payloadText);            // always-on lightweight scan
        if (policy.monitorIntegrations && policy.piiEnabled) {   // optional richer GLiNER scan
            const det = await _detectPii(payloadText, policy);
            if (det) piiCats = [...new Set([...piiCats, ...det.entities.map(e => e.label)])];
        }

        if (probe && integMeta.isLocal) probe.is_local = true;

        const store = require('../../stores/integrationActivityStore');
        store.logIntegrationActivity({
            organization_id: auditBase.organization_id,
            user_id: auditBase.user_id,
            agent_id: auditBase.automation_id,        // reuse agent_id slot for the automation id in legacy views
            agent_name: auditBase.agent_name,
            conversation_id: auditBase.conversation_id,
            tool_name: toolName,
            integration_type: integMeta.integration,
            server_endpoint: integMeta.server,
            data_direction: integMeta.direction,
            data_categories: integMeta.dataCategories,
            pii_categories_detected: piiCats.length ? piiCats.join(', ') : null,
            pii_scan_enabled: true,
            source: 'routine',
            model: auditBase.model || null,
            probe: probe || null,
            automation_id: auditBase.automation_id,
            run_id: auditBase.run_id,
            step_id: auditBase.step_id,
            is_dry_run: mode === 'dry_run',
        }).catch(() => {});
    } catch (_) { /* never fail a run on egress logging */ }
}

module.exports = {
    GuardrailBlockError,
    resolveAutomationPolicy,
    buildAuditBase,
    guardToolInput,
    guardToolOutput,
    guardAiInput,
    guardAiOutput,
    restoreForEgress,
    logEgress,
};
