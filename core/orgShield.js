/**
 * Organization Privacy Shield — resolve org-level regex guardrail rules
 * 
 * Used by agentRuntime.js and directChat.js to enforce org-wide guardrails
 * before agent-specific or direct-chat-specific guardrails.
 */

const configStore = require('../stores/configStore');

/**
 * Resolve org privacy shield rules for a given organization ID.
 * Returns null if no shield is configured or enabled.
 * 
 * @param {string} orgId - Organization ID
 * @returns {{ enabled: boolean, rulesWithNames: Array, scope: object, action: string } | null}
 */
async function resolveOrgShield(orgId) {
    if (!orgId) return null;

    const shield = await configStore.getConfig(`org_privacy_shield_${orgId}`);
    if (!shield?.enabled) return null;

    // Need global regex config to resolve collection IDs to actual rules
    const { getAIConfig } = require('./aiAgent');
    const globalConfig = await getAIConfig();
    const globalRegexConfig = globalConfig.regexGuardrails || {};
    const globalRules = globalRegexConfig.rules || [];
    const globalCollections = globalRegexConfig.collections || [];

    const rulesWithNames = [];
    const stalenessWarnings = [];
    if (shield.collectionIds?.length > 0) {
        for (const colId of shield.collectionIds) {
            const collection = globalCollections.find(c => c.id === colId);
            if (!collection) {
                // The collection was deleted but the shield still references it
                // → the org's regex guard silently stops firing. Surface this to
                // the admin UI without blowing up the runtime (the existing
                // behaviour of silently skipping is preserved).
                stalenessWarnings.push({ collectionId: colId, reason: 'collection_not_found' });
                continue;
            }
            const resolvedRules = [];
            for (const ruleId of collection.ruleIds || []) {
                const rule = globalRules.find(r => r.id === ruleId);
                if (rule?.pattern) {
                    resolvedRules.push({ name: rule.name, pattern: rule.pattern });
                } else {
                    stalenessWarnings.push({ collectionId: colId, ruleId, reason: 'rule_not_found' });
                }
            }
            if (resolvedRules.length === 0) {
                stalenessWarnings.push({ collectionId: colId, reason: 'collection_empty' });
            }
            rulesWithNames.push(...resolvedRules);
        }
    }

    return {
        enabled: true,
        rulesWithNames,
        stalenessWarnings,
        // Only userInput / agentOutput are honoured at runtime; any lingering
        // toolInput / toolOutput from older saves is silently dropped.
        scope: shield.scope
            ? { userInput: !!shield.scope.userInput, agentOutput: !!shield.scope.agentOutput }
            : { userInput: true, agentOutput: true },
        action: shield.action || 'delete',
        // PII detection settings
        azurePiiEnabled: !!shield.azurePiiEnabled,
        piiDetectionCategories: shield.piiDetectionCategories || [],
        piiDetectionConfidenceThreshold: shield.piiDetectionConfidenceThreshold,
        piiDetectionAction: shield.piiDetectionAction || globalConfig.piiDetectionAction || 'block',
        // Content Safety
        azureSeverityThreshold: shield.azureSeverityThreshold,
        azureEnabledCategories: shield.azureEnabledCategories,
        // Other features
        moderationEnabled: !!shield.moderationEnabled,
        // Exactly one provider runs per turn. If the stored value is missing
        // or unknown, default to Llama Guard (self-hosted).
        moderationProvider: shield.moderationProvider === 'azure' ? 'azure' : 'llamaguard',
        moderationCategories: shield.moderationCategories || [],
        euModeEnabled: !!shield.euModeEnabled,
        webSearchGuardEnabled: !!shield.webSearchGuardEnabled,
        disableSearchOnUpload: !!shield.disableSearchOnUpload,
        monitorIntegrations: !!shield.monitorIntegrations,
        // The Web-Search Guard PII filter used to maintain its own separate
        // category list, which drifted from the main PII list. The new
        // contract: if Web-Search Guard is enabled and the admin hasn't
        // explicitly picked a subset, fall back to the main PII categories
        // so the two stay in sync. See plan S6.
        webSearchGuardPiiCategories: (Array.isArray(shield.webSearchGuardPiiCategories) && shield.webSearchGuardPiiCategories.length > 0)
            ? shield.webSearchGuardPiiCategories
            : (Array.isArray(shield.piiDetectionCategories) ? shield.piiDetectionCategories : []),
        // DLP (Data Loss Prevention) — interactive outbound scanner before
        // prompts reach external LLMs. Default off so existing orgs are unaffected.
        dlpEnabled: !!shield.dlpEnabled,
        dlpScope: shield.dlpScope || 'external',            // 'external' | 'all'
        dlpMode: shield.dlpMode || 'ask',                   // 'ask' | 'auto_redact' | 'block'
        dlpFailureMode: shield.dlpFailureMode || 'fail_closed', // 'fail_closed' | 'fail_open'
        dlpAllowlistedHosts: shield.dlpAllowlistedHosts || [],
        customSensitiveTerms: Array.isArray(shield.customSensitiveTerms) ? shield.customSensitiveTerms : [],
        // Canonical Privacy fields (the Guardrails Redesign).
        // Runtime code consumes these; legacy dlp*/piiDetection* fields are
        // still returned above for backwards compatibility while call-sites
        // migrate. See plan: /home/tom/.claude/plans/quirky-wondering-pond.md
        ...synthesizePrivacyFields(shield, orgId),
    };
}

/**
 * Map stored legacy fields (`dlpEnabled`, `dlpMode`, `azurePiiEnabled`,
 * `piiDetectionAction`, …) onto the canonical Privacy fields
 * (`privacyScanEnabled`, `privacyAction`, `privacyScope`, `privacyFailureMode`).
 *
 * Rules:
 *   - `privacyScanEnabled` = dlpEnabled OR azurePiiEnabled (either surfaces a scan)
 *   - `privacyAction` — if dlpMode is set (new feature), it wins; otherwise fall
 *     back to the legacy `piiDetectionAction` ('tokenize' → 'redact').
 *   - `privacyScope` = dlpScope ('external' by default)
 *   - `privacyFailureMode` = dlpFailureMode ('fail_closed' by default)
 *
 * This is read-only: the stored document is untouched, so we never risk a
 * destructive migration at deploy time.
 */
function synthesizePrivacyFields(shield, orgId) {
    const hasDlpMode = !!shield.dlpMode;
    const mapDlpMode = { ask: 'ask', auto_redact: 'redact', block: 'block' };
    const mapPiiAction = { block: 'block', tokenize: 'redact', redact: 'redact', warn: 'ask' };

    let privacyAction;
    if (hasDlpMode && mapDlpMode[shield.dlpMode]) {
        privacyAction = mapDlpMode[shield.dlpMode];
    } else if (shield.piiDetectionAction && mapPiiAction[shield.piiDetectionAction]) {
        privacyAction = mapPiiAction[shield.piiDetectionAction];
    } else {
        privacyAction = 'ask';
    }

    const privacyScanEnabled = !!(shield.dlpEnabled || shield.azurePiiEnabled);
    const migratedFromLegacy = !shield.privacyScanEnabled && privacyScanEnabled
        && !hasDlpMode && shield.piiDetectionAction;
    if (migratedFromLegacy) {
        // Once-per-process hint so ops can see who still needs a re-save.
        const key = orgId || '(unknown)';
        if (!_legacyLogged.has(key)) {
            _legacyLogged.add(key);
            console.log(`[OrgShield] Migrating legacy PII/DLP fields for org=${key} (on read). Next save will normalise.`);
        }
    }

    return {
        privacyScanEnabled,
        privacyAction,
        privacyScope: shield.dlpScope || 'external',
        privacyFailureMode: shield.dlpFailureMode || 'fail_closed',
    };
}

const _legacyLogged = new Set();

/**
 * Merge org shield rules with agent/direct-chat rules.
 * Org rules come first. Action uses the stricter of the two ('delete' > 'redact').
 * Scope is merged with OR (if either enables a scope, it's enabled).
 * 
 * @param {object|null} orgConfig - From resolveOrgShield()
 * @param {object|null} localConfig - Agent or direct chat regex config
 * @returns {object|null} Merged config, or null if nothing enabled
 */
function mergeWithOrgShield(orgConfig, localConfig) {
    if (!orgConfig && !localConfig) return null;
    if (!orgConfig) return localConfig;
    if (!localConfig) return orgConfig;

    // Merge rules: org first, then local (dedup by pattern)
    const seenPatterns = new Set();
    const mergedRules = [];
    for (const r of [...orgConfig.rulesWithNames, ...localConfig.rulesWithNames]) {
        if (!seenPatterns.has(r.pattern)) {
            seenPatterns.add(r.pattern);
            mergedRules.push(r);
        }
    }

    // Action: strictest wins (delete > redact)
    const action = (orgConfig.action === 'delete' || localConfig.action === 'delete') ? 'delete' : 'redact';

    // Scope: OR merge. Only userInput and agentOutput are read at runtime;
    // the old toolInput/toolOutput fields were never consumed and have been
    // dropped from the accepted payload.
    const scope = {
        userInput: !!(orgConfig.scope?.userInput || localConfig.scope?.userInput),
        agentOutput: !!(orgConfig.scope?.agentOutput || localConfig.scope?.agentOutput),
    };

    return { enabled: true, rulesWithNames: mergedRules, scope, action, webSearchGuardEnabled: !!(orgConfig.webSearchGuardEnabled || localConfig.webSearchGuardEnabled), disableSearchOnUpload: !!(orgConfig.disableSearchOnUpload || localConfig.disableSearchOnUpload) };
}

/**
 * Boot-time self-check: walk every `org_privacy_shield_*` config and run it
 * through `resolveOrgShield`. Logs warnings for legacy shapes, orphaned
 * collections, and invalid custom-term regexes so an operator can spot issues
 * in the startup log before any user hits them.
 *
 * Never throws — a bad shield must never stop the server.
 */
async function selfCheckOrgShields() {
    try {
        const all = await configStore.getAllConfig() || {};
        const entries = Object.entries(all).filter(([k]) => k.startsWith('org_privacy_shield_'));
        if (entries.length === 0) {
            console.log('[OrgShieldSelfCheck] No org shields stored yet.');
            return;
        }
        let ok = 0, warnings = 0;
        for (const [key] of entries) {
            const orgId = key.replace(/^org_privacy_shield_/, '');
            try {
                const resolved = await resolveOrgShield(orgId);
                if (!resolved) continue; // shield disabled
                if (resolved.stalenessWarnings?.length) {
                    warnings += resolved.stalenessWarnings.length;
                    for (const w of resolved.stalenessWarnings) {
                        console.warn(`[OrgShieldSelfCheck] org=${orgId} stale reference:`, w);
                    }
                }
                // Validate custom-term regexes so a bad one doesn't surface only at request-time.
                for (const term of resolved.customSensitiveTerms || []) {
                    if (term.type !== 'regex') continue;
                    try { new RegExp(term.pattern, term.caseSensitive ? '' : 'i'); }
                    catch (err) {
                        warnings++;
                        console.warn(`[OrgShieldSelfCheck] org=${orgId} invalid regex in term "${term.label}": ${err.message}`);
                    }
                }
                ok++;
            } catch (err) {
                warnings++;
                console.warn(`[OrgShieldSelfCheck] org=${orgId} resolve error: ${err.message}`);
            }
        }
        console.log(`[OrgShieldSelfCheck] Scanned ${entries.length} org shield(s) — ${ok} OK, ${warnings} warning(s).`);
    } catch (err) {
        console.warn('[OrgShieldSelfCheck] Self-check failed:', err.message);
    }
}

module.exports = { resolveOrgShield, mergeWithOrgShield, selfCheckOrgShields };
