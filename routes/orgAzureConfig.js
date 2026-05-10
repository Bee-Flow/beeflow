/**
 * Organization Azure Configuration API
 * 
 * In private-cloud mode, org admins can view and manage the SAME global
 * Azure configuration that platform admins set in the admin dashboard.
 * This avoids config duplication — there's one source of truth.
 */

const express = require('express');
const router = express.Router();
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds } = require('../auth');
const { loadConfig, saveConfig } = require('../auth/permissions');
const { syncAzureGroupsToOrg, getSyncSettings, setSyncSettings, getSyncStatus } = require('../integrations/azureGroupSync');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Check if the current user is an admin for the given org.
 * Platform super admins can manage any org.
 */
async function isOrgAdmin(req, orgId) {
    // Platform super admin
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;

    const userId = req.session?.user?.id;
    if (!userId) return false;

    const user = await userStore.getUser(userId);
    if (!user) return false;

    // Check orgRole directly
    if (user.organizationId === orgId && user.orgRole === 'org_admin') return true;

    let groupIds = [];
    if (Array.isArray(user.groups)) groupIds = user.groups;
    else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { } }

    const allGroups = await userStore.getAllGroups();
    for (const gid of groupIds) {
        const group = allGroups.find(g => g.id === gid);
        if (group?.organizationId === orgId) {
            const perms = Array.isArray(group.permissions) ? group.permissions : [];
            const roles = Array.isArray(group.roles) ? group.roles : [];
            if (perms.includes('all') || perms.includes('admin') ||
                roles.includes('admin') || roles.includes('org_admin')) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Helper: Mask a secret for display (show last 4 chars)
 */
function maskSecret(value) {
    if (!value) return '';
    return '••••' + value.slice(-4);
}

/**
 * Helper: Get the global AI config (same as admin dashboard)
 */
async function getAIConfig() {
    const raw = await configStore.getConfig('ai');
    return raw || {};
}

// GET /:orgId — get Azure config (reads global platform config)
router.get('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;

        // Must be member of org or super admin
        const orgIds = await resolveUserOrgIds(req);
        const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });

        // Must be org admin to view config
        const admin = await isOrgAdmin(req, orgId);
        if (!admin) return res.status(403).json({ error: 'Only organization admins can view Azure configuration' });

        const config = await getAIConfig();

        // Azure OpenAI — global keys (same as admin dashboard)
        const azureEndpoint = await configStore.getConfig('azure_endpoint') || '';
        const azureApiKey = await configStore.getSecret('azure_api_key');
        const azureApiVersion = await configStore.getConfig('azure_api_version') || '2025-04-01-preview';
        const azureModels = await configStore.getConfig('azure_models') || '';

        // Chat Model Tiers — same config key as GET /ai/config/chat-models
        const chatModelTiers = await configStore.getConfig('chat_model_tiers') || {
            fast: { modelId: '', label: 'Fast' },
            thinking: { modelId: '', label: 'Thinking' },
            writer: { modelId: '', label: 'Writer' },
            pro: { modelId: '', label: 'Deep Thinking' }
        };
        if (!chatModelTiers.writer) chatModelTiers.writer = { modelId: '', label: 'Writer' };

        // Content Safety — global keys
        const contentSafetyEndpoint = await configStore.getConfig('azure_content_safety_endpoint') || '';
        const contentSafetyKey = await configStore.getSecret('azure_content_safety_key');

        // Azure Document Processing
        const azureDocEndpoint = await configStore.getConfig('azure_doc_intelligence_endpoint') || '';
        const azureDocKey = await configStore.getSecret('azure_doc_intelligence_key');
        const azureEmbedEndpoint = await configStore.getConfig('azure_openai_embedding_endpoint') || '';
        const azureEmbedKey = await configStore.getSecret('azure_openai_embedding_key');
        const azureEmbedModel = await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small';
        const useAzureDocProcessing = await configStore.getConfig('use_azure_doc_processing');

        // SSO / Microsoft provider config
        const authConfig = await loadConfig();
        const msProvider = authConfig.providers?.microsoft || {};
        const org = await userStore.getOrganization(orgId);

        // PII Detection — from ai blob
        res.json({
            // Azure OpenAI
            azureEndpoint,
            hasAzureApiKey: !!azureApiKey,
            azureApiKeyMasked: maskSecret(azureApiKey),
            azureApiVersion,
            azureModels,

            // Chat Model Tiers
            chatModelTiers,

            // Content Safety
            contentSafetyEndpoint,
            hasContentSafetyKey: !!contentSafetyKey,
            contentSafetyKeyMasked: maskSecret(contentSafetyKey),
            contentSafetySeverityThreshold: config.azureContentSafetySeverityThreshold ?? 2,
            contentSafetyCategories: config.azureContentSafetyCategories || null,
            moderationProvider: config.moderationProvider || 'azure',

            // PII Detection
            piiDetectionEnabled: config.piiDetectionEnabled === true || config.piiDetectionEnabled === 'true',
            piiDetectionCategories: config.piiDetectionCategories || null,
            piiDetectionConfidenceThreshold: config.piiDetectionConfidenceThreshold ?? 0.7,
            piiDetectionScope: config.piiDetectionScope || { userInput: true, agentOutput: false },
            piiDetectionAction: config.piiDetectionAction || 'block',

            // Azure Document Processing
            azureDocEndpoint,
            hasAzureDocEndpoint: !!azureDocEndpoint,
            hasAzureDocKey: !!azureDocKey,
            azureEmbedEndpoint,
            hasAzureEmbedEndpoint: !!azureEmbedEndpoint,
            hasAzureEmbedKey: !!azureEmbedKey,
            azureEmbedModel,
            useAzureDocProcessing: !!useAzureDocProcessing,

            // Microsoft SSO
            ssoClientId: msProvider.clientId || '',
            hasSsoClientSecret: !!msProvider.clientSecret,
            ssoClientSecretMasked: maskSecret(msProvider.clientSecret),
            ssoTenantId: msProvider.tenantId || 'common',
            autoApproveSSO: org?.autoApproveSSO || false,

            // Group Sync settings & status
            groupSyncSettings: await getSyncSettings(orgId),
            groupSyncStatus: await getSyncStatus(orgId),
        });
    } catch (e) {
        console.error('[OrgAzureConfig] GET error:', e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /:orgId — save Azure config (writes to global platform config — same keys as admin dashboard)
router.put('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        const admin = await isOrgAdmin(req, orgId);
        if (!admin) {
            return res.status(403).json({ error: 'Only organization admins can manage Azure configuration' });
        }

        const { section } = req.body;

        // Save by section — uses the same global keys as POST /ai/config
        if (section === 'openai') {
            const { azureEndpoint, azureApiKey, azureApiVersion, azureModels } = req.body;
            if (azureEndpoint !== undefined) await configStore.setConfig('azure_endpoint', azureEndpoint || '');
            if (azureApiKey !== undefined) await configStore.setSecret('azure_api_key', azureApiKey || '');
            if (azureApiVersion !== undefined) await configStore.setConfig('azure_api_version', azureApiVersion || '2025-04-01-preview');
            if (azureModels !== undefined) await configStore.setConfig('azure_models', azureModels || '');
        }

        if (section === 'chatModels') {
            const { chatModelTiers } = req.body;
            if (chatModelTiers) {
                const tiers = {
                    fast: chatModelTiers.fast || { modelId: '', label: 'Fast' },
                    thinking: chatModelTiers.thinking || { modelId: '', label: 'Thinking' },
                    writer: chatModelTiers.writer || { modelId: '', label: 'Writer' },
                    pro: chatModelTiers.pro || { modelId: '', label: 'Deep Thinking' },
                };
                await configStore.setConfig('chat_model_tiers', tiers);
            }
        }

        if (section === 'contentSafety') {
            const { contentSafetyEndpoint, contentSafetyKey, contentSafetySeverityThreshold, contentSafetyCategories, moderationProvider } = req.body;
            if (contentSafetyEndpoint !== undefined) await configStore.setConfig('azure_content_safety_endpoint', contentSafetyEndpoint || '');
            if (contentSafetyKey !== undefined) await configStore.setSecret('azure_content_safety_key', contentSafetyKey || '');

            // These are stored in the ai blob
            const config = await getAIConfig();
            if (contentSafetySeverityThreshold !== undefined) config.azureContentSafetySeverityThreshold = contentSafetySeverityThreshold;
            if (contentSafetyCategories !== undefined) config.azureContentSafetyCategories = contentSafetyCategories;
            if (moderationProvider !== undefined) config.moderationProvider = moderationProvider;
            
            // Auto-switch to azure provider if endpoint is set and moderationProvider wasn't explicitly passed
            if (contentSafetyEndpoint && moderationProvider === undefined && config.moderationProvider !== 'azure') {
                config.moderationProvider = 'azure';
            }
            
            await configStore.setConfig('ai', config);
        }

        if (section === 'piiDetection') {
            const { piiDetectionEnabled, piiDetectionCategories, piiDetectionConfidenceThreshold, piiDetectionScope, piiDetectionAction } = req.body;
            const config = await getAIConfig();
            if (piiDetectionEnabled !== undefined) config.piiDetectionEnabled = !!piiDetectionEnabled;
            if (piiDetectionCategories !== undefined) config.piiDetectionCategories = piiDetectionCategories;
            if (piiDetectionConfidenceThreshold !== undefined) config.piiDetectionConfidenceThreshold = piiDetectionConfidenceThreshold;
            if (piiDetectionScope !== undefined) config.piiDetectionScope = piiDetectionScope;
            if (piiDetectionAction !== undefined) config.piiDetectionAction = piiDetectionAction;
            await configStore.setConfig('ai', config);
        }

        if (section === 'docProcessing') {
            const { useAzureDocProcessing, azureDocIntelligenceEndpoint, azureDocIntelligenceKey, azureOpenaiEmbeddingEndpoint, azureOpenaiEmbeddingKey, azureOpenaiEmbeddingModel } = req.body;
            if (useAzureDocProcessing !== undefined) {
                await configStore.setConfig('use_azure_doc_processing', useAzureDocProcessing ? 'true' : '');
            }
            if (azureDocIntelligenceEndpoint !== undefined) {
                await configStore.setConfig('azure_doc_intelligence_endpoint', azureDocIntelligenceEndpoint || '');
            }
            if (azureDocIntelligenceKey !== undefined) {
                await configStore.setSecret('azure_doc_intelligence_key', azureDocIntelligenceKey || '');
            }
            if (azureOpenaiEmbeddingEndpoint !== undefined) {
                await configStore.setConfig('azure_openai_embedding_endpoint', azureOpenaiEmbeddingEndpoint || '');
            }
            if (azureOpenaiEmbeddingKey !== undefined) {
                await configStore.setSecret('azure_openai_embedding_key', azureOpenaiEmbeddingKey || '');
            }
            if (azureOpenaiEmbeddingModel !== undefined) {
                await configStore.setConfig('azure_openai_embedding_model', azureOpenaiEmbeddingModel || 'text-embedding-3-small');
            }
        }

        if (section === 'sso') {
            const { ssoClientId, ssoClientSecret, ssoTenantId, autoApproveSSO } = req.body;
            const authConfig = await loadConfig();
            authConfig.providers = authConfig.providers || {};
            authConfig.providers.microsoft = authConfig.providers.microsoft || {};
            if (ssoClientId !== undefined) authConfig.providers.microsoft.clientId = ssoClientId;
            if (ssoClientSecret && ssoClientSecret.trim()) authConfig.providers.microsoft.clientSecret = ssoClientSecret;
            if (ssoTenantId !== undefined) {
                const tid = (ssoTenantId || '').trim();
                const knownAliases = ['common', 'organizations', 'consumers', ''];
                const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid);
                if (!knownAliases.includes(tid.toLowerCase()) && !isGuid) {
                    return res.status(400).json({ error: `Invalid Tenant ID "${tid}". Must be a GUID or one of: common, organizations, consumers` });
                }
                authConfig.providers.microsoft.tenantId = tid || 'common';
            }
            saveConfig(authConfig);

            // Update org-level autoApproveSSO flag
            if (autoApproveSSO !== undefined) {
                await userStore.updateOrganization(orgId, { autoApproveSSO: !!autoApproveSSO });
            }
        }

        console.log(`[OrgAzureConfig] Saved ${section || 'config'} for org ${orgId} by ${req.session.user.id}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('[OrgAzureConfig] PUT error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// ── Azure AD Group Sync Endpoints ─────────────────────────
// ═══════════════════════════════════════════════════════════

// POST /:orgId/sync-groups — trigger a sync
router.post('/:orgId/sync-groups', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        const admin = await isOrgAdmin(req, orgId);
        if (!admin) {
            return res.status(403).json({ error: 'Only organization admins can trigger group sync' });
        }

        console.log(`[AzureGroupSync] Sync triggered for org ${orgId} by ${req.session.user.id}`);
        const result = await syncAzureGroupsToOrg(orgId);
        res.json(result);
    } catch (e) {
        console.error('[AzureGroupSync] Sync endpoint error:', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /:orgId/sync-groups/status — get last sync status
router.get('/:orgId/sync-groups/status', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        const admin = await isOrgAdmin(req, orgId);
        if (!admin) {
            return res.status(403).json({ error: 'Only organization admins can view sync status' });
        }

        const status = await getSyncStatus(orgId);
        const settings = await getSyncSettings(orgId);
        res.json({ status, settings });
    } catch (e) {
        console.error('[AzureGroupSync] Status endpoint error:', e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /:orgId/sync-groups/settings — update sync settings
router.put('/:orgId/sync-groups/settings', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        const admin = await isOrgAdmin(req, orgId);
        if (!admin) {
            return res.status(403).json({ error: 'Only organization admins can manage sync settings' });
        }

        const { destructiveSync, autoActivateUsers, periodicSync, syncIntervalHours } = req.body;
        const updates = {};
        if (destructiveSync !== undefined) updates.destructiveSync = !!destructiveSync;
        if (autoActivateUsers !== undefined) updates.autoActivateUsers = !!autoActivateUsers;
        if (periodicSync !== undefined) updates.periodicSync = !!periodicSync;
        if (syncIntervalHours !== undefined) {
            const hours = parseInt(syncIntervalHours, 10);
            if (hours >= 1 && hours <= 168) updates.syncIntervalHours = hours;
        }

        const settings = await setSyncSettings(orgId, updates);
        console.log(`[AzureGroupSync] Settings updated for org ${orgId} by ${req.session.user.id}:`, updates);
        res.json({ ok: true, settings });
    } catch (e) {
        console.error('[AzureGroupSync] Settings endpoint error:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
