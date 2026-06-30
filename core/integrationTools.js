/**
 * Integration Tools — Shared tool injection for direct chat and agent chat
 * 
 * Builds the list of available integration tools (Gmail, Calendar,
 * Docs, Drive, Fireflies, YouTrack, Gamma, N8N, Tavily, Image Gen,
 * Video Gen, Terminal, Regex Generator) based on user session,
 * org settings, and enabled apps.
 */

const configStore = require('../stores/configStore');
const { GMAIL_TOOLS } = require('../integrations/gmailTools');
const { CALENDAR_TOOLS } = require('../integrations/calendarTools');
const { DRIVE_TOOLS } = require('../integrations/driveTools');
const { DOCS_TOOLS } = require('../integrations/docsTools');
const { SHEETS_TOOLS } = require('../integrations/sheetsTools');
const { SLIDES_TOOLS } = require('../integrations/slidesTools');
const { CONTACTS_TOOLS } = require('../integrations/contactsTools');
const { KEEP_TOOLS } = require('../integrations/keepTools');
const { GOOGLE_GROUPS_TOOLS } = require('../integrations/googleGroupsTools');
const { FIREFLIES_TOOLS } = require('../integrations/firefliesTools');
const { YOUTRACK_TOOLS } = require('../integrations/youtrackTools');
const { SIGNREQUEST_TOOLS } = require('../integrations/signrequestTools');
const { GAMMA_TOOLS } = require('../integrations/gammaTools');
const { AFAS_TOOLS } = require('../integrations/afasTools');
const { NMBRS_TOOLS } = require('../integrations/nmbrsTools');
const { buildN8nTools } = require('../integrations/n8nTools');
const { N8N_WORKFLOW_TOOLS, getN8nToolPermission } = require('../integrations/n8nWorkflowTools');
const { hasPermission } = require('../auth/permissions');
const { AGENT_SEARCH_TOOLS } = require('../integrations/agentSearchTools');
const { REGEX_GENERATOR_TOOLS } = require('../integrations/regexGeneratorTools');
const { IMAGE_GEN_TOOLS } = require('../routes/ai/imageGenTool');
const { VIDEO_GEN_TOOLS } = require('../routes/ai/videoGenTool');
const { ELEVENLABS_TOOLS } = require('../routes/ai/elevenLabsTools');
const { WORKSPACE_TOOLS } = require('../integrations/workspaceTools');
const { KB_SEARCH_TOOLS } = require('../integrations/kbSearchTools');
const { KB_INGEST_TOOLS } = require('../integrations/kbIngestTools');
const { MAPS_TOOLS } = require('../integrations/mapsTools');
const { LINKEDIN_TOOLS } = require('../integrations/linkedinTools');
const { GITHUB_TOOLS } = require('../integrations/githubTools');
const { OUTLOOK_TOOLS, OUTLOOK_READONLY_TOOLS } = require('../integrations/outlookTools');
const { MS_CALENDAR_TOOLS } = require('../integrations/msCalendarTools');
const { ONEDRIVE_TOOLS } = require('../integrations/oneDriveTools');
const { MS_CONTACTS_TOOLS } = require('../integrations/msContactsTools');
const { TRANSCRIPTION_TOOLS } = require('../integrations/transcriptionTools');
const { NEXTCLOUD_TOOLS } = require('../integrations/nextcloudTools');
const { NEXTCLOUD_CALENDAR_TOOLS } = require('../integrations/nextcloudCalendarTools');
const { NEXTCLOUD_CONTACTS_TOOLS } = require('../integrations/nextcloudContactsTools');
const { NEXTCLOUD_DECK_TOOLS } = require('../integrations/nextcloudDeckTools');
const { NEXTCLOUD_NOTIFICATIONS_TOOLS } = require('../integrations/nextcloudNotificationsTools');
const { NEXTCLOUD_TALK_TOOLS } = require('../integrations/nextcloudTalkTools');
const { NEXTCLOUD_TASKS_TOOLS } = require('../integrations/nextcloudTasksTools');
const { NEXTCLOUD_NOTES_TOOLS } = require('../integrations/nextcloudNotesTools');
const { NEXTCLOUD_MAIL_TOOLS } = require('../integrations/nextcloudMailTools');
const { NEXTCLOUD_ACTIVITY_TOOLS } = require('../integrations/nextcloudActivityTools');
const { NEXTCLOUD_STATUS_TOOLS } = require('../integrations/nextcloudStatusTools');
const { TICKET_ASSISTANT_TOOLS } = require('../integrations/ticketAssistantTools');
const { WEBPAGE_AUTOMATION_TOOLS } = require('../integrations/webpageAutomationTools');
const { RECHTSPRAAK_TOOLS } = require('../integrations/rechtspraakTools');
const { EURLEX_TOOLS } = require('../integrations/eurlexTools');
const { KAMERSTUKKEN_TOOLS } = require('../integrations/kamerstukkenTools');
const { BEKENDMAKINGEN_TOOLS } = require('../integrations/bekendmakingenTools');
const { TUCHTRECHT_TOOLS } = require('../integrations/tuchtrechtTools');
const { userHasBetaFeature } = require('./betaFeatures');

// IDs that are exempt from org-level gating (admin-only tools, internal utilities)
const ORG_EXEMPT_APPS = ['workspace', 'regex-gen', 'kb-ingest'];

// Integrations auto-enabled for users with an existing saved enabled-apps list
// (they were added after the user saved their list, so they wouldn't be in it).
// Module-scoped because BOTH getIntegrationTools() and getUserPermittedApps()
// gate on it — when this lived inside getIntegrationTools the permitted-apps
// helper threw a ReferenceError that was swallowed, emptying the builder palette.
const AUTO_ENABLED_APPS = ['agent-search', 'workspace', 'image-gen', 'music-gen', 'video-gen', 'elevenlabs', 'google-maps', 'linkedin', 'github', 'google-contacts', 'google-keep', 'outlook', 'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts', 'google-groups', 'n8n', 'nextcloud', 'nextcloud-calendar', 'nextcloud-contacts', 'nextcloud-deck', 'nextcloud-mail', 'nextcloud-notifications', 'nextcloud-talk', 'nextcloud-tasks', 'nextcloud-notes', 'nextcloud-activity', 'nextcloud-status', 'webpages'];

/**
 * Build the list of integration tools available for the current user.
 * 
 * @param {Object} options
 * @param {string}  options.userId       - Current user ID
 * @param {Object}  options.session      - Express session (for OAuth tokens)
 * @param {boolean} options.isAdmin      - Whether user is admin
 * @returns {Object} { tools: Array, n8nOrgId: string|null }
 */
async function getIntegrationTools({ userId, session, isAdmin, agentConfig, routineStep = false, connectionPolicy = null }) {
    const tools = [];
    let n8nOrgId = null;

    // Simple Mode strips the agent's toolbelt to the basics. Notebooks,
    // webpages, meeting transcripts (Fireflies), automations (n8n) and the
    // admin regex-guardrail tools are all withheld so the agent can't act on
    // surfaces the user has explicitly opted out of.
    const userSimpleMode = !!(await configStore.getConfig(`simple_mode_user_${userId}`));

    // Load user's enabled apps (null = all enabled)
    const userEnabledApps = await configStore.getConfig(`enabled_apps_user_${userId}`);

    // Load org-level enabled integrations
    let orgEnabledIntegrations = null;
    // Org-admin "active" subset of the super-admin allow-list (non-NC only).
    // null = no restriction (used for NC which has its own group path); a
    // Set = only IDs in here pass the org-admin gate.
    let orgActiveSet = null;
    let userOrgId = null;
    // Per-group NC opt-out (Fase G). Resolved per-user: only the groups the
    // current user belongs to are loaded, with their disabled_integrations
    // arrays. Used by isAppOn() with "enable wins" semantics — see below.
    let userGroupDisableLists = null;
    // NC ID set — used to skip the org-admin active filter for NC tools,
    // which are governed by the dedicated NC panel + per-group opt-out path.
    let ncIdSet = new Set();
    try {
        const cat = require('./ncIntegrationCatalog');
        ncIdSet = cat.NC_INTEGRATION_ID_SET || new Set(cat.NC_INTEGRATION_IDS || []);
    } catch (_) { }
    try {
        const userStore = require('../stores/userStore');
        const currentUser = await userStore.getUser(userId);
        const isSuperAdmin = isAdmin || session?.user?.role === 'admin';
        if (currentUser?.organizationId) {
            userOrgId = currentUser.organizationId;
            const org = await userStore.getOrganization(currentUser.organizationId);
            if (org?.enabledIntegrations) {
                // Org has custom overrides
                orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
                    ? JSON.parse(org.enabledIntegrations)
                    : org.enabledIntegrations;
            } else {
                // Org uses defaults — load global default integrations
                const globalDefaults = await configStore.getConfig('default_org_integrations');
                if (globalDefaults) {
                    orgEnabledIntegrations = typeof globalDefaults === 'string'
                        ? JSON.parse(globalDefaults)
                        : globalDefaults;
                }
                // null globalDefaults = all enabled (no defaults configured yet)
            }
            // Org-admin's active subset. Super admin bypasses this entirely
            // so they can always see/use everything the platform allows.
            if (!isSuperAdmin) {
                try {
                    const activeList = await userStore.getOrgEnabledIntegrations(currentUser.organizationId);
                    orgActiveSet = new Set(activeList);
                } catch (_) { orgActiveSet = new Set(); }
            }
            // Collect disabled_integrations arrays from each group the user
            // belongs to. Skip when user is not in any groups; isAppOn then
            // bypasses the group-deny path entirely.
            const userGroupIds = Array.isArray(currentUser.groups)
                ? currentUser.groups
                : (() => { try { return JSON.parse(currentUser.groups || '[]'); } catch { return []; } })();
            if (userGroupIds.length > 0) {
                const allGroups = await userStore.getAllGroups();
                const groupById = new Map(allGroups.map(g => [g.id, g]));
                userGroupDisableLists = userGroupIds
                    .map(gid => groupById.get(gid))
                    .filter(Boolean)
                    .map(g => Array.isArray(g.disabled_integrations) ? g.disabled_integrations : []);
                // If every group's list is empty there's no constraint — drop
                // the array so isAppOn can short-circuit.
                if (userGroupDisableLists.every(lst => lst.length === 0)) userGroupDisableLists = null;
            }
        } else if (isSuperAdmin) {
            // Super admins without an org use the '__system__' config scope
            userOrgId = '__system__';
        }
    } catch (e) { /* ignore */ }

    // AUTO_ENABLED_APPS is now module-scoped (see top of file).

    // Unified entitlement resolution — the single source of truth for which
    // integrations this user/org is entitled to: ceiling ∩ org-grant ∩ per-group
    // grant. This is what folds the org-admin "active" subset AND the new
    // grant-only per-group access into one decision. The per-user `enabled_apps`
    // selection and the legacy NC per-group opt-out stay below as the final
    // tool-selection step — the NC connector path is untouched.
    let entSnapshot = null;
    let effectiveIntegrations = null;
    try {
        const entitlements = require('./entitlements');
        const resolveOrgId = (userOrgId && userOrgId !== '__system__') ? userOrgId : null;
        const snap = await entitlements.resolveEntitlements({ userId, orgId: resolveOrgId, session });
        entSnapshot = snap;
        if (snap && !snap.degraded) effectiveIntegrations = new Set(snap.effective.integration);
    } catch (_) { effectiveIntegrations = null; /* fall back to the legacy org gate */ }
    let _capReg = null;
    try { _capReg = require('./capabilityRegistry'); } catch (_) { _capReg = null; }
    const isKnownIntegration = (appId) => !!(_capReg && _capReg.getCapability(appId)?.kind === 'integration');

    const isAppOn = (appId) => {
        // Must be enabled at user level (a per-user UX preference)
        if (userEnabledApps) {
            // For auto-enabled apps, they're on unless _explicitly_ in a list that excluded them
            // after they existed. Since we can't tell, we default to enabled.
            if (AUTO_ENABLED_APPS.includes(appId)) {
                // Only block if user explicitly has this app in their list AND it's set to off
                // For now, auto-enabled apps are always on at user level
            } else if (!userEnabledApps.includes(appId)) {
                return false;
            }
        }
        // ENTITLEMENT — the unified resolver decides org-wide + per-group grants
        // (org_enabled_integrations is the org-wide grant; NC + exempt apps are
        // granted by the resolver's bypass; group grants add within the ceiling).
        // Ids unknown to the registry (exempt infra tools) pass through. If the
        // resolver was unavailable, fall back to the legacy inline org gate so a
        // transient failure never strips an agent's whole toolbelt.
        if (effectiveIntegrations && isKnownIntegration(appId)) {
            if (!effectiveIntegrations.has(appId)) return false;
        } else {
            if (!ORG_EXEMPT_APPS.includes(appId) && orgEnabledIntegrations && !orgEnabledIntegrations.includes(appId)) return false;
            if (orgActiveSet && !ORG_EXEMPT_APPS.includes(appId) && !ncIdSet.has(appId) && !orgActiveSet.has(appId)) {
                return false;
            }
        }
        // Per-group NC opt-out with "enable wins" (transitional, NC only). The
        // tool is denied only if EVERY user group disables it — a single
        // permissive group is enough to allow it. Untouched from before.
        if (userGroupDisableLists && appId.startsWith('nextcloud') && userGroupDisableLists.every(lst => lst.includes(appId))) {
            return false;
        }
        return true;
    };

    const addTools = (toolArray) => {
        for (const tool of toolArray) {
            if (!tools.find(t => t.function.name === tool.function.name)) {
                tools.push(tool);
            }
        }
    };

    // Google integrations — require OAuth
    if (session?.oauthProvider === 'google' && session?.accessToken) {
        if (isAppOn('gmail')) addTools(GMAIL_TOOLS);
        if (isAppOn('google-calendar')) addTools(CALENDAR_TOOLS);
        if (isAppOn('google-drive')) addTools(DRIVE_TOOLS);
        if (isAppOn('google-docs')) addTools(DOCS_TOOLS);
        if (isAppOn('google-sheets')) addTools(SHEETS_TOOLS);
        if (isAppOn('google-slides')) addTools(SLIDES_TOOLS);
        if (isAppOn('google-contacts')) addTools(CONTACTS_TOOLS);
        if (isAppOn('google-keep')) addTools(KEEP_TOOLS);
        if (isAppOn('google-groups')) addTools(GOOGLE_GROUPS_TOOLS);
    }

    // Microsoft integrations — require Microsoft OAuth
    if (session?.oauthProvider === 'microsoft' && session?.accessToken) {
        if (isAppOn('outlook')) addTools(OUTLOOK_TOOLS);
        if (isAppOn('outlook-readonly')) addTools(OUTLOOK_READONLY_TOOLS);
        if (isAppOn('ms-calendar')) addTools(MS_CALENDAR_TOOLS);
        if (isAppOn('onedrive')) addTools(ONEDRIVE_TOOLS);
        if (isAppOn('ms-contacts')) addTools(MS_CONTACTS_TOOLS);
    }

    // Image Generation — requires Google API key
    const hasGoogleKey = !!(await configStore.getSecret('google_api_key'));
    if (hasGoogleKey && isAppOn('image-gen')) {
        addTools(IMAGE_GEN_TOOLS);
    }

    // Video Generation — requires Google API key (Veo 3.1)
    if (hasGoogleKey && isAppOn('video-gen')) {
        addTools(VIDEO_GEN_TOOLS);
    }

    // ElevenLabs — Music (with vocals), TTS, Sound Effects
    const hasElevenLabsKey = !!(await configStore.getSecret('elevenlabs_api_key'));
    if (hasElevenLabsKey && isAppOn('elevenlabs')) {
        addTools(ELEVENLABS_TOOLS);
    }

    // Agent Search — self-hosted AI search, Bing, or cloud-only node-search
    const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
    const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
    const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
    const hasSerperKey = !!(await configStore.getSecret('serper_api_key'));
    // When the configured provider is agent-search but the GPU service URL is
    // gone (typical CPU-only deploy), fall back to node-search transparently
    // so the agent keeps having a search tool. The dispatcher mirrors this.
    const canFallbackToNode = searchProvider === 'agent-search' && !hasAgentSearchUrl && hasSerperKey;
    const searchAvailable = searchProvider !== 'disabled' && (
        (searchProvider === 'bing' && hasBingSearchKey) ||
        (searchProvider === 'node-search' && hasSerperKey) ||
        (searchProvider === 'agent-search' && hasAgentSearchUrl) ||
        canFallbackToNode
    );
    if (searchAvailable && isAppOn('agent-search')) {
        addTools(AGENT_SEARCH_TOOLS);
        if (canFallbackToNode) {
            console.warn('[IntegrationTools] agent_search registered via node-search fallback: provider=agent-search but SEARCH_SERVICE_URL/agent_search_url is empty. Using serper_api_key directly. Set search_provider=node-search explicitly to silence this.');
        }
    } else if (isAppOn('agent-search') && searchProvider !== 'disabled') {
        if (searchProvider === 'agent-search') {
            console.warn('[IntegrationTools] agent_search NOT registered: provider=agent-search but SEARCH_SERVICE_URL is not set, no agent_search_url admin config, and no serper_api_key for node-search fallback. The model will not have web search. Set SEARCH_SERVICE_URL, or set serper_api_key + search_provider=node-search.');
        } else if (searchProvider === 'bing') {
            console.warn('[IntegrationTools] agent_search NOT registered: provider=bing but bing_search_key secret is not set. The model will not have web search.');
        } else if (searchProvider === 'node-search') {
            console.warn('[IntegrationTools] agent_search NOT registered: provider=node-search but serper_api_key secret is not set. The model will not have web search.');
        }
    }

    // ── Connection lending (gated) ──────────────────────────────────
    // On a SHARED resource run (connectionPolicy carries the owner + resource),
    // a provider the running user hasn't connected may still be available via a
    // LENT connection from the owner (full delegation, resolved at dispatch).
    // isLentProvider lets the catalog OFFER those tools; the dispatch override in
    // chatStream/chatWithAgent then runs them as the owner. Inert unless
    // INTEGRATION_CONNECTION_LENDING_ENABLED is set AND a policy is passed — and
    // only agent paths that ALSO apply the dispatch override pass a policy.
    let _lendCtx = undefined;
    const _cr = require('./connectionResolution');
    const _lendingOn = _cr.isLendingEnabled() && connectionPolicy && connectionPolicy.ownerUserId && connectionPolicy.ownerUserId !== userId;
    async function isLentProvider(provider) {
        if (!_lendingOn) return false;
        try {
            if (_lendCtx === undefined) _lendCtx = await _cr.runningUserContext(userId);
            const store = require('../stores/integrationConnectionStore');
            const r = await store.resolveConnectionForRun({
                runningUserId: userId, runningUserOrgId: _lendCtx.orgId, runningUserGroups: _lendCtx.groups,
                ownerUserId: connectionPolicy.ownerUserId, provider,
                resourceType: connectionPolicy.resourceType || null, resourceId: connectionPolicy.resourceId || null,
            });
            return !!(r && r.mode === 'delegated');
        } catch (_) { return false; }
    }

    // Fireflies — requires user API key (or a lent connection)
    const hasFirefliesKey = !!(await configStore.getSecret(`fireflies_api_key_user_${userId}`)) || await isLentProvider('fireflies');
    if (!userSimpleMode && hasFirefliesKey && isAppOn('fireflies')) {
        addTools(FIREFLIES_TOOLS);
    }

    // YouTrack — requires user URL + token (or a lent connection)
    const hasYouTrackConfig = (!!(await configStore.getSecret(`youtrack_url_user_${userId}`)) && !!(await configStore.getSecret(`youtrack_token_user_${userId}`))) || await isLentProvider('youtrack');
    if (hasYouTrackConfig && isAppOn('youtrack')) {
        addTools(YOUTRACK_TOOLS);
    }

    // Gamma — requires user API key (or a lent connection)
    const hasGammaKey = !!(await configStore.getSecret(`gamma_api_key_user_${userId}`)) || await isLentProvider('gamma');
    if (hasGammaKey && isAppOn('gamma')) {
        addTools(GAMMA_TOOLS);
    }

    // SignRequest — requires user subdomain + token (or a lent connection)
    const hasSignRequestConfig = (!!(await configStore.getSecret(`signrequest_subdomain_user_${userId}`)) && !!(await configStore.getSecret(`signrequest_token_user_${userId}`))) || await isLentProvider('signrequest');
    if (hasSignRequestConfig && isAppOn('signrequest')) {
        addTools(SIGNREQUEST_TOOLS);
    }

    // AFAS Profit — requires user member number + AppConnector token. Deliberately
    // NOT lendable (no isLentProvider clause): ERP data stays bring-your-own.
    const hasAfasConfig = !!(await configStore.getSecret(`afas_token_user_${userId}`)) && !!(await configStore.getSecret(`afas_member_number_user_${userId}`));
    if (hasAfasConfig && isAppOn('afas-profit')) {
        addTools(AFAS_TOOLS);
    }

    // NMBRS — read-only payroll/HR. Requires subdomain + token (and login email
    // for the SOAP API). Bring-your-own like AFAS: payroll data is not lendable.
    const hasNmbrsConfig = !!(await configStore.getSecret(`nmbrs_subdomain_user_${userId}`)) && !!(await configStore.getSecret(`nmbrs_token_user_${userId}`));
    if (hasNmbrsConfig && isAppOn('nmbrs')) {
        addTools(NMBRS_TOOLS);
    }

    // N8N workflows — org-level config. Read/run tools are implicit for every
    // member once the org has n8n configured (umbrella 'n8n' toggle, handled by
    // AUTO_ENABLED_APPS so legacy users with stale enabledApps lists don't lose
    // access). Only the write-bucket is permission-gated via modify_n8n_workflows.
    try {
        if (!userSimpleMode && userOrgId) {
            n8nOrgId = userOrgId;
            const n8nUrl = await configStore.getConfig(`n8n_url_org_${n8nOrgId}`);
            const n8nKey = await configStore.getSecret(`n8n_api_key_org_${n8nOrgId}`);
            if (n8nUrl && n8nKey && isAppOn('n8n')) {
                const canModify = await hasPermission(userId, 'modify_n8n_workflows', session);

                // Dynamic webhook-trigger tools — umbrella gating.
                // A user who has 'n8n' enabled (or is covered by AUTO_ENABLED_APPS)
                // gets every configured workflow, no per-workflow toggle required.
                const n8nTools = await buildN8nTools(n8nOrgId);
                for (const n8nTool of n8nTools) {
                    const { _n8n, ...cleanTool } = n8nTool;
                    if (!tools.find(t => t.function.name === cleanTool.function.name)) {
                        tools.push(cleanTool);
                    }
                }

                // Workflow-management tools — split by permission bucket:
                //   read-only (list/get/nodes_find/execution reads) → always included
                //   write / execute / delete / activate             → modify_n8n_workflows
                for (const tool of N8N_WORKFLOW_TOOLS) {
                    const perm = getN8nToolPermission(tool.function.name);
                    if (perm === 'modify_n8n_workflows' && !canModify) continue;
                    if (!tools.find(t => t.function.name === tool.function.name)) {
                        tools.push(tool);
                    }
                }
            }
        }
    } catch (e) {
        console.error('[IntegrationTools] n8n tool injection error:', e.message);
    }

    // Regex Generator — admin only
    if (!userSimpleMode && isAdmin) {
        addTools(REGEX_GENERATOR_TOOLS);
    }

    // Workspace/Notebook — check feature flag (disabled from admin panel = no tools)
    const notebooksFeatureEnabled = (await configStore.getConfig('feature_notebooks_enabled')) !== false;
    if (!userSimpleMode && notebooksFeatureEnabled) {
        // BFSF-207: notebook tools mirror the HTTP surface gates — `notebooks`
        // capability via the unified resolver (same as requireCapability on
        // /api/notebooks + /api/ai/chat/notebook) AND the use_notebooks RBAC
        // permission (same as routes/notebooks.js). Fail closed on a missing/
        // degraded snapshot (matches the MCP fail-closed posture below).
        let notebooksEntitled = false;
        try {
            const entitlements = require('./entitlements');
            notebooksEntitled = !!(entSnapshot && !entSnapshot.degraded && entitlements.snapshotHas(entSnapshot, 'notebooks'));
        } catch (_) { notebooksEntitled = false; }
        if (notebooksEntitled && await hasPermission(userId, 'use_notebooks', session)) {
            addTools(WORKSPACE_TOOLS);
        }
    }

    // KB Search — available when agent has knowledge bases configured
    // This lets agents explicitly search KB with custom queries (e.g., after reading an email)
    if (agentConfig?.knowledge_base_ids?.length > 0) {
        addTools(KB_SEARCH_TOOLS);
    }

    // KB Ingest — routine-only WRITE tool (Support Studio "solved tickets → KB"
    // template). Never surfaced to chat agents (routineStep gate) and only to
    // holders of the org-level support_inbox permission.
    if (routineStep && isAppOn('kb-ingest') && await hasPermission(userId, 'support_inbox', session)) {
        addTools(KB_INGEST_TOOLS);
    }

    // LinkedIn — requires user OAuth tokens (or a lent connection)
    const hasLinkedIn = !!(await configStore.getSecret(`linkedin_access_token_user_${userId}`)) || await isLentProvider('linkedin');
    if (hasLinkedIn && isAppOn('linkedin')) {
        addTools(LINKEDIN_TOOLS);
    }

    // Google Maps — requires Maps API key
    const hasMapsKey = !!(await configStore.getSecret('google_maps_api_key'));
    if (hasMapsKey && isAppOn('google-maps')) {
        addTools(MAPS_TOOLS);
    }

    // GitHub — requires user PAT (or a lent connection)
    const hasGitHub = !!(await configStore.getSecret(`github_token_user_${userId}`)) || await isLentProvider('github');
    if (hasGitHub && isAppOn('github')) {
        addTools(GITHUB_TOOLS);
    }

    // Nextcloud — OAuth path (parity with Google/Microsoft above) with
    // app-password fallback for users not logged in via Nextcloud OAuth.
    // Once a Nextcloud connection (either mode) is established, every
    // sub-app (files, calendar, contacts, Deck, notifications) gates on its
    // own per-app toggle so admins can disable individual surfaces.
    try {
        const oauthCfg = (await configStore.getConfig('oauth')) || {};
        // Connector-bound user: NC tools route through the connector's /nc/*
        // proxy with AppAPI shared-secret + impersonation. No OAuth URL or
        // app password is required; the org's nc_base_url is the binding.
        const isConnectorUser = session?.user?.provider === 'nextcloud_connector'
            || !!session?.connectorOrgId;
        // A user who saved their own app password may also carry a per-user
        // Nextcloud URL (Settings → Connections), which makes NC reachable even
        // when the org-wide oauth.nextcloudUrl is unset. Look it up once so it
        // can both open the gate and signal the connection.
        const userStoreLocal = require('../stores/userStore');
        const ncCreds = isConnectorUser ? null : await userStoreLocal.getAppPassword(userId);
        const hasNcUrl = !!(oauthCfg.nextcloudUrl || ncCreds?.url);
        if (hasNcUrl || isConnectorUser) {
            let nextcloudConnected = false;
            if (isConnectorUser) {
                nextcloudConnected = true;
            } else if (session?.oauthProvider === 'nextcloud' && session?.accessToken) {
                nextcloudConnected = true;
            } else if (ncCreds?.username && ncCreds?.password) {
                nextcloudConnected = true;
            }
            if (nextcloudConnected) {
                if (isAppOn('nextcloud')) addTools(NEXTCLOUD_TOOLS);
                if (isAppOn('nextcloud-calendar')) addTools(NEXTCLOUD_CALENDAR_TOOLS);
                if (isAppOn('nextcloud-contacts')) addTools(NEXTCLOUD_CONTACTS_TOOLS);
                if (isAppOn('nextcloud-deck')) addTools(NEXTCLOUD_DECK_TOOLS);
                if (isAppOn('nextcloud-notifications')) addTools(NEXTCLOUD_NOTIFICATIONS_TOOLS);
                if (isAppOn('nextcloud-talk')) addTools(NEXTCLOUD_TALK_TOOLS);
                if (isAppOn('nextcloud-tasks')) addTools(NEXTCLOUD_TASKS_TOOLS);
                if (isAppOn('nextcloud-notes')) addTools(NEXTCLOUD_NOTES_TOOLS);
                if (isAppOn('nextcloud-mail')) addTools(NEXTCLOUD_MAIL_TOOLS);
                if (isAppOn('nextcloud-activity')) addTools(NEXTCLOUD_ACTIVITY_TOOLS);
                if (isAppOn('nextcloud-status')) addTools(NEXTCLOUD_STATUS_TOOLS);
            }
        }
    } catch (e) { /* ignore — credentials missing or store unavailable */ }

    // Ticket Assistant — gated only by the per-app toggle. The tools check
    // org membership at execute-time so we don't need to enforce it here;
    // the surface is org-scoped, not OAuth-token-gated. Non-admin users get
    // the read/AI tools but the create/delete connection tools are filtered
    // out so the LLM doesn't propose actions that will return Forbidden.
    if (isAppOn('ticket-assistant')) {
        const taTools = TICKET_ASSISTANT_TOOLS;
        if (isAdmin) {
            addTools(taTools);
        } else {
            const safe = taTools.filter(t => {
                const n = t?.function?.name || '';
                return n !== 'ticket_assistant_create_connection' && n !== 'ticket_assistant_delete_connection';
            });
            addTools(safe);
        }
    }

    // Transcription — requires existing Mistral API key
    const hasMistralKey = !!(await configStore.getSecret('mistral_api_key'));
    if (hasMistralKey && isAppOn('transcription')) {
        addTools(TRANSCRIPTION_TOOLS);
    }

    // Webpages (automation-flavoured surface). Gated on the per-user
    // "webpages" beta feature — automations only see these tools when the
    // user can already use webpages in Studio. Direct chat injects its own
    // webpage tools separately and ignores this surface; the names overlap
    // but the dispatch paths are distinct (direct chat checks
    // isBuilderTool/isDbTool first; the automation runner goes through
    // toolDispatcher → isWebpageAutomationTool).
    if (!userSimpleMode && isAppOn('webpages')) {
        try {
            const ok = await userHasBetaFeature(userId, 'webpages', session);
            if (ok) addTools(WEBPAGE_AUTOMATION_TOOLS);
        } catch (_) { /* beta lookup failed — fail closed */ }
    }

    // Dutch legal sources — gated only on the `dutch_legal_sources` beta
    // feature. No API key, no OAuth, no per-app toggle: enabling the feature
    // for an org is the full activation. The matching system-managed KB is
    // gated separately in routes/knowledgeBases.js + knowledgeSearch.js.
    if (!userSimpleMode) {
        try {
            const ok = await userHasBetaFeature(userId, 'dutch_legal_sources', session);
            if (ok) {
                addTools(RECHTSPRAAK_TOOLS);
                addTools(EURLEX_TOOLS);
                addTools(KAMERSTUKKEN_TOOLS);
                addTools(BEKENDMAKINGEN_TOOLS);
                addTools(TUCHTRECHT_TOOLS);
            }
        } catch (_) { /* beta lookup failed — fail closed */ }
    }

    // MCP servers are integrations (id `mcp:<serverId>`). Gate them by the same
    // effective.integration set computed above — single path, no duplication.
    await appendMcpTools(tools, { effectiveIntegrations });

    // Org-scoped custom integrations (AI Integration Builder, id
    // `custom:<uuid>`) — same effective-set gate; the dark-ship feature flag
    // is enforced inside the helper.
    await appendCustomIntegrationTools(tools, { effectiveIntegrations, orgId: userOrgId });

    // Agent-callable routines (automations with trigger.kind === 'agent_call').
    // Each active one the user owns becomes a function tool the model can call
    // from direct chat or a configured agent. Gated by the same 'automations'
    // capability the scheduler checks — fail closed if the org lacks it or the
    // lookup throws, so we never surface routines on installs without routines.
    try {
        const { hasCapability } = require('./entitlements');
        const resolveOrgId = (userOrgId && userOrgId !== '__system__') ? userOrgId : null;
        if (await hasCapability('automations', { userId, orgId: resolveOrgId })) {
            const { getAgentCallableToolsForUser } = require('../automation/agentCallableTools');
            const agentTools = await getAgentCallableToolsForUser(userId);
            for (const t of agentTools) {
                if (!tools.find(x => x?.function?.name === t?.function?.name)) tools.push(t);
            }
        }
    } catch (e) {
        console.warn('[IntegrationTools] Failed to load agent-callable routines:', e.message);
    }

    // Reusable Steps (kind='block') the user published and marked "available in
    // chat". Owner-only in v1 (mirrors agent_call), so the Step runs under the
    // caller's own identity. Same 'automations' capability gate.
    try {
        const { hasCapability } = require('./entitlements');
        const resolveOrgId = (userOrgId && userOrgId !== '__system__') ? userOrgId : null;
        if (await hasCapability('automations', { userId, orgId: resolveOrgId })) {
            const { getStepToolsForUser } = require('../automation/agentCallableTools');
            const stepTools = await getStepToolsForUser(userId);
            for (const t of stepTools) {
                if (!tools.find(x => x?.function?.name === t?.function?.name)) tools.push(t);
            }
        }
    } catch (e) {
        console.warn('[IntegrationTools] Failed to load Step tools:', e.message);
    }

    return { tools, n8nOrgId };
}

/**
 * Append connected MCP-server tools to a tool list, gated by the caller's
 * effective integration set. Shared by getIntegrationTools (running user) and
 * agentRuntime/agentTools (agent owner) so the gating lives in ONE place.
 *
 *   effectiveIntegrations : Set<string> of granted integration ids, or null.
 *     null ⇒ fail-closed (no MCP tools) — the resolver was unavailable/degraded.
 *   Each MCP server `mcp:<id>` must be present in the set to expose its tools.
 *   (No tier/umbrella gate — MCP servers are plain integrations.)
 */
async function appendMcpTools(tools, { effectiveIntegrations }) {
    if (!effectiveIntegrations) return; // fail closed
    try {
        const mcpManager = require('./mcpManager');
        const mcpTools = await mcpManager.getAllToolsAsOpenAI();
        for (const t of mcpTools) {
            const serverId = t._mcp?.serverId;
            if (!serverId) continue;                                  // unidentifiable ⇒ fail closed
            if (!effectiveIntegrations.has(`mcp:${serverId}`)) continue;
            if (!tools.find(x => x.function?.name === t.function?.name)) tools.push(t);
        }
    } catch (e) {
        console.warn('[IntegrationTools] MCP injection failed:', e.message);
    }
}

/**
 * Append org-scoped custom-integration tools (AI Integration Builder) to a
 * tool list, gated by the caller's effective integration set. Shared by
 * getIntegrationTools (running user) and agentRuntime/agentTools (agent
 * owner) so the gating lives in ONE place.
 *
 *   effectiveIntegrations : Set<string> of granted capability ids, or null.
 *     null ⇒ fail-closed (no custom tools) — the resolver was unavailable/degraded.
 *   orgId : the user's OWN org — custom integrations are org-scoped, so a
 *     missing org (or the '__system__' super-admin scope) means none exist.
 *   Each integration `custom:<uuid>` must be present in the set to expose its
 *   tools_cache entries (already OpenAI-format with cint_-prefixed names,
 *   frozen at activation — including any `_cint` metadata they carry).
 *   The dark-ship feature flag is re-checked here so flipping it off removes
 *   injection without touching callers.
 */
async function appendCustomIntegrationTools(tools, { effectiveIntegrations, orgId }) {
    if (!effectiveIntegrations) return; // fail closed
    if (!orgId || orgId === '__system__') return; // org-scoped feature — no org, no tools
    try {
        const { isCustomIntegrationsEnabled } = require('./customIntegrations/featureFlag');
        if (!(await isCustomIntegrationsEnabled())) return; // feature ships dark
        const store = require('../stores/orgCustomIntegrationStore');
        const rows = await store.listActiveForOrg(orgId);
        for (const row of Array.isArray(rows) ? rows : []) {
            if (!row || !row.id) continue;                            // unidentifiable ⇒ fail closed
            if (!effectiveIntegrations.has(`custom:${row.id}`)) continue;
            for (const entry of Array.isArray(row.toolsCache) ? row.toolsCache : []) {
                const name = entry?.function?.name;
                if (!name) continue;                                  // unidentifiable ⇒ fail closed
                if (!tools.find(x => x.function?.name === name)) tools.push(entry);
            }
        }
    } catch (e) {
        console.warn('[IntegrationTools] Custom integration injection failed:', e.message);
    }
}

/**
 * Build human-readable integration hints for the system prompt.
 * @param {Array} tools - Tool definitions array
 * @returns {string} Integration hint string to append to system prompt
 */
async function buildToolHint(tools, userId = null) {
    if (tools.length === 0) return '';

    const integrations = [];
    if (tools.some(t => t.function.name.startsWith('gmail_'))) integrations.push('Gmail (search, read, compose, send, and reply to emails — the user approves before anything is sent)');
    if (tools.some(t => t.function.name.startsWith('calendar_'))) integrations.push('Google Calendar (list, search, create, update, delete events)');
    if (tools.some(t => t.function.name.startsWith('drive_'))) integrations.push('Google Drive (search, list, manage files and folders)');
    if (tools.some(t => t.function.name.startsWith('docs_'))) integrations.push('Google Docs (create, read, append, replace text in documents)');
    if (tools.some(t => t.function.name.startsWith('contacts_'))) integrations.push('Google Contacts (search, list, create, update contacts — create/update require user approval)');
    if (tools.some(t => t.function.name.startsWith('keep_'))) integrations.push('Google Keep (list, get, create, delete notes — create/delete require user approval, enterprise Workspace only)');
    if (tools.some(t => t.function.name.startsWith('groups_'))) integrations.push('Google Groups (list conversations in a group, read full conversation threads, reply to group conversations — replies require user approval before sending)');
    if (tools.some(t => t.function.name.startsWith('youtrack_'))) integrations.push('YouTrack (search, create, update issues)');
    if (tools.some(t => t.function.name.startsWith('afas_'))) integrations.push('AFAS Profit (discover GetConnectors with afas_list_connectors, inspect fields with afas_describe_connector, then read data with afas_query; read-only)');
    if (tools.some(t => t.function.name.startsWith('nmbrs_'))) integrations.push('NMBRS payroll/HR (read-only: list debtors → companies → employees with nmbrs_list_*, then read an employee\'s contracts, salaries, wage components and payslips)');
    if (tools.some(t => t.function.name.startsWith('signrequest_'))) integrations.push('SignRequest (send documents for e-signature, check signing status, list documents, cancel requests)');
    if (tools.some(t => t.function.name.startsWith('fireflies_'))) integrations.push('Fireflies (meeting transcripts)');
    if (tools.some(t => t.function.name.startsWith('gamma_'))) integrations.push('Gamma (create presentations/documents/webpages/social posts, generate from templates using gammaId or a pasted gamma.app/docs URL, poll generation status, list themes/folders; create tools start asynchronous jobs and return generationId first, then use gamma_get_generation_status to retrieve gammaUrl/exportUrl; existing Gammas cannot be read by URL or edited in place via the public API. If the user asks to create/remix a new Gamma from a URL, call gamma_create_from_template instead of saying the URL cannot be used)');
    if (tools.some(t => t.function.name.startsWith('n8n_run_'))) {
        const n8nNames = tools.filter(t => t.function.name.startsWith('n8n_run_')).map(t => t.function.description || t.function.name);
        integrations.push(`n8n Workflows (${n8nNames.join(', ')})`);
    }
    if (tools.some(t => t.function.name.startsWith('n8n_workflow_') || t.function.name.startsWith('n8n_execution_'))) {
        const hasWrite = tools.some(t => ['n8n_workflow_create','n8n_workflow_update','n8n_workflow_patch','n8n_workflow_delete','n8n_workflow_execute','n8n_workflow_activate','n8n_workflow_deactivate'].includes(t.function.name));
        if (hasWrite) {
            integrations.push(
                'n8n Workflow Management (list, get, nodes_find, create, patch, activate, execute, debug executions). RULES: '
                + '(1) ALWAYS call n8n_workflow_list first to discover IDs — never guess a workflow_id. '
                + '(2) For targeted edits use n8n_workflow_patch with node_operations {action,node_name,node_data} — NOT wholesale update. '
                + '(3) For searching nodes use n8n_workflow_nodes_find instead of pulling the full workflow. '
                + '(4) nodes/connections/parameters are real JSON arrays/objects, never stringified. '
                + '(5) Do NOT send `settings` in a patch unless explicitly changing one — the server preserves/sanitises existing settings automatically. '
                + '(6) To add documentation to the canvas, use sticky notes: type "n8n-nodes-base.stickyNote" with parameters.content — no connections needed. '
                + '(7) Always confirm with the user before n8n_workflow_delete or n8n_workflow_activate. '
                + '(8) On failure, debug via n8n_execution_list → n8n_execution_get_detail for per-node errors.'
            );
        } else {
            integrations.push('n8n Workflow Inspection (list, get, nodes_find, execution_list, execution_get_detail — read-only). To modify workflows you need the "Modify n8n Workflows" permission.');
        }
    }
    if (tools.some(t => t.function.name === 'generate_image')) integrations.push('Image generation');
    if (tools.some(t => t.function.name === 'generate_music')) integrations.push('Music generation (instrumental AI music via Lyria)');
    if (tools.some(t => t.function.name === 'generate_video')) integrations.push('Video generation (short AI video clips via Veo 3.1 — takes 1-3 minutes)');
    if (tools.some(t => t.function.name === 'agent_search')) integrations.push('Agent Search (AI-powered web search with reranking)');
    if (tools.some(t => t.function.name.startsWith('workspace_') || t.function.name.startsWith('notebook_'))) integrations.push('Notebook (read and write a persistent rich-text document alongside the conversation)');
    if (tools.some(t => t.function.name === 'kb_search')) integrations.push('Knowledge Base Search (look up internal documentation when the user asks a specific question — do NOT search for greetings or small-talk)');
    if (tools.some(t => t.function.name.startsWith('rechtspraak_'))) integrations.push('Rechtspraak.nl (Nederlandse jurisprudentie via Open Data: zoek arresten/uitspraken op rechtsgebied + instantie + datumbereik via rechtspraak_search, haal volledige tekst per ECLI op via rechtspraak_get)');
    if (tools.some(t => t.function.name.startsWith('eurlex_'))) integrations.push('EUR-Lex (EU-recht en HvJEU-arresten in het Nederlands: eurlex_search op trefwoord + doc_type, eurlex_get per CELEX)');
    if (tools.some(t => t.function.name.startsWith('kamerstukken_') || t.function.name === 'kamerstuk_get')) integrations.push('Tweede Kamer Open Data — kamerstukken (memorie van toelichting, amendementen, kamervragen, brieven regering) voor wetsgeschiedenis: kamerstukken_search op trefwoord + soort + vergaderjaar, kamerstuk_get haalt de tekst van een specifiek stuk op via GUID');
    if (tools.some(t => t.function.name.startsWith('bekendmakingen_') || t.function.name === 'bekendmaking_get')) integrations.push('Officiële Bekendmakingen — Staatsblad (vastgestelde wetten/AMvB), Staatscourant (regelingen, AP-besluiten, AVV-CAO\'s), Tractatenblad (verdragen): bekendmakingen_search op trefwoord + publicatie + datum, bekendmaking_get per identifier (bv. stcrt-2024-1234)');
    if (tools.some(t => t.function.name.startsWith('tuchtrecht_'))) integrations.push('Tuchtrecht — Nederlandse tuchtuitspraken voor advocaten (Raad/Hof van Discipline), notarissen (Kamer voor het notariaat), accountants (Accountantskamer), gerechtsdeurwaarders en BIG-beroepen (Tuchtcollege Gezondheidszorg): tuchtrecht_search op trefwoord + beroepsgroep + datum, tuchtrecht_get per ECLI');
    if (tools.some(t => t.function.name.startsWith('maps_'))) integrations.push('Google Maps (get directions between locations with route maps, search for places/businesses — IMPORTANT: after getting results, always output the map as a ```map-embed code block containing JSON with embedUrl, title, and mapsLink fields so it renders as an interactive map in the chat)');
    if (tools.some(t => t.function.name.startsWith('linkedin_'))) integrations.push('LinkedIn (create posts — user approves before publishing)');
    if (tools.some(t => t.function.name.startsWith('github_'))) integrations.push('GitHub (list repos, view code, create repos, manage branches)');
    if (tools.some(t => t.function.name.startsWith('outlook_'))) {
        // Check if compose tool is present — if not, it's read-only mode
        const hasCompose = tools.some(t => t.function.name === 'outlook_compose');
        if (hasCompose) {
            integrations.push('Outlook Mail (search, list recent, read, compose, send, and reply to emails — the user approves before anything is sent)');
        } else {
            integrations.push('Outlook Mail (search, list recent, and read emails only — read-only access, no sending capability)');
        }
    }
    if (tools.some(t => t.function.name.startsWith('ms_calendar_'))) integrations.push('Microsoft Calendar (list, search, create, update, delete events — create/update/delete require user approval)');
    if (tools.some(t => t.function.name.startsWith('onedrive_'))) integrations.push('OneDrive (search, list, manage files and folders)');
    if (tools.some(t => t.function.name.startsWith('ms_contacts_'))) integrations.push('Microsoft Contacts (search, list, create, update contacts — create/update require user approval)');
    if (tools.some(t => t.function.name === 'transcribe_audio')) integrations.push('Meeting Transcription (transcribe uploaded audio files with speaker diarization using Voxtral AI — supports up to 3 hours of audio, Dutch and other languages)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_calendar_'))) integrations.push('Nextcloud Calendar (list calendars, list/search/get events, create/update/delete events via CalDAV — create/update/delete require user approval)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_contacts_'))) integrations.push('Nextcloud Contacts (list address books, list/search/get contacts, create/update/delete contacts via CardDAV — create/update/delete require user approval)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_deck_'))) integrations.push('Nextcloud Deck (list boards/stacks/cards, search cards, create/update/move/archive/delete cards, manage labels, add comments — create/update/move require user approval, delete always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_notifications_'))) integrations.push('Nextcloud Notifications (list pending notifications, dismiss one or all — dismiss-all always requires user confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_talk_'))) integrations.push('Nextcloud Talk (list conversations, list/search messages, post messages with optional reply, react with emoji, mark rooms read, create rooms — sending messages always requires user approval, deletion always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_tasks_'))) integrations.push('Nextcloud Tasks (VTODO via CalDAV — list lists, list/search/get tasks, create, update, mark complete/incomplete, delete — create/update require user approval, delete always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_notes_'))) integrations.push('Nextcloud Notes (list/search/get notes, create/update/delete notes, list categories — create/update require user approval, delete always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_activity_'))) integrations.push('Nextcloud Activity (read-only feed of recent file changes, shares, comments, mentions, calendar invites — useful for "what happened recently?" questions)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_status_'))) integrations.push('Nextcloud User Status (get / set / clear the user\'s availability and custom message — setting status requires user approval, except when auto-deriving from a calendar event the user explicitly asked about)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_') && !t.function.name.startsWith('nextcloud_calendar_') && !t.function.name.startsWith('nextcloud_contacts_') && !t.function.name.startsWith('nextcloud_deck_') && !t.function.name.startsWith('nextcloud_notifications_') && !t.function.name.startsWith('nextcloud_talk_') && !t.function.name.startsWith('nextcloud_tasks_') && !t.function.name.startsWith('nextcloud_notes_') && !t.function.name.startsWith('nextcloud_activity_') && !t.function.name.startsWith('nextcloud_status_'))) integrations.push('Nextcloud Files (list/search/read/upload/delete files, create folders, share with public links / users / groups / email, manage shares, file comments, system tags, trash bin recovery, file version history via WebDAV — destructive ops require user approval, permanent deletes always require confirmation)');

    // MCP (Model Context Protocol) tools — dynamically discovered from connected external servers
    const mcpTools = tools.filter(t => t.function?.name?.startsWith('mcp_'));
    console.log(`[MCP-DEBUG] buildToolHint: ${tools.length} total tools received, ${mcpTools.length} are MCP tools`);
    if (mcpTools.length > 0) {
        // Group by server: mcp_{serverId}_{toolName}
        const serverMap = {};
        for (const t of mcpTools) {
            const parts = t.function.name.split('_');
            // mcp_{serverId}_{rest...} — server ID is the second segment
            const serverId = parts[1] || 'unknown';
            if (!serverMap[serverId]) serverMap[serverId] = [];
            serverMap[serverId].push(t.function.description || t.function.name);
        }
        console.log(`[MCP-DEBUG] buildToolHint: MCP servers found: ${Object.keys(serverMap).join(', ')}`);
        for (const [serverId, toolDescs] of Object.entries(serverMap)) {
            const label = serverId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            integrations.push(`${label} via MCP (${toolDescs.length} tools: ${toolDescs.slice(0, 5).join(', ')}${toolDescs.length > 5 ? `, ... and ${toolDescs.length - 5} more` : ''})`);
        }
    }

    // Custom org integrations (AI Integration Builder) — cint_<slug>_<tool>.
    // Cheap by construction: skipped entirely when no cint_ tools made it into
    // the list, one getBySlug lookup per distinct integration otherwise.
    // Fail-soft: a store hiccup only costs the hint line, never the tools.
    const cintTools = tools.filter(t => t.function?.name?.startsWith('cint_'));
    if (cintTools.length > 0) {
        try {
            const { parsePrefixedName } = require('../integrations/customIntegrationRunner');
            const orgCustomIntegrationStore = require('../stores/orgCustomIntegrationStore');
            const bySlug = new Map();
            for (const t of cintTools) {
                const parsed = parsePrefixedName(t.function.name);
                if (!parsed) continue;
                if (!bySlug.has(parsed.slug)) bySlug.set(parsed.slug, []);
                bySlug.get(parsed.slug).push(t.function.name);
            }
            for (const [slug, toolNames] of bySlug) {
                const row = await orgCustomIntegrationStore.getBySlug(slug);
                if (!row || !row.name) continue;
                integrations.push(`${row.name} (custom org integration: ${toolNames.join(', ')})`);
            }
        } catch (_) { /* fail soft — hint only, the tools themselves still work */ }
    }

    let hint = ' You have access to tools — use them when they would help answer the user\'s question. You can call multiple tools in parallel when appropriate.';
    if (integrations.length > 0) {
        hint += ` Your available integrations: ${integrations.join(', ')}.`;
    }
    console.log(`[MCP-DEBUG] buildToolHint final integrations: [${integrations.join(', ')}]`);

    return hint;
}

/**
 * Same permission gates as `isAppOn` inside `getIntegrationTools`, exposed
 * as a standalone helper for callers that want to know "what apps is this
 * user *allowed* to use" — distinct from "what apps are wired up with
 * credentials right now".
 *
 * Used by the automation builder's catalog: the palette shows every
 * permitted app (with a "Connect" badge when credentials are missing) so
 * users can drop the node first and authenticate after. Without this the
 * palette was credential-gated and looked empty on dev instances where
 * OAuth hadn't been completed yet.
 */
async function getUserPermittedApps({ userId, session, isAdmin } = {}) {
    if (!userId) return new Set();
    const userEnabledApps = await configStore.getConfig(`enabled_apps_user_${userId}`);
    let orgEnabledIntegrations = null;
    let userGroupDisableLists = null;
    void session; void isAdmin; // reserved — currently no super-admin bypass needed (orgActiveSet dropped from this path)
    try {
        const cat = require('./ncIntegrationCatalog');
        // ncIdSet was used only by the orgActiveSet gate (now dropped); kept require
        // for parity with getIntegrationTools and to surface load errors fast.
        void (cat.NC_INTEGRATION_ID_SET || new Set(cat.NC_INTEGRATION_IDS || []));
    } catch (_) { }
    try {
        const userStore = require('../stores/userStore');
        const currentUser = await userStore.getUser(userId);
        if (currentUser?.organizationId) {
            const org = await userStore.getOrganization(currentUser.organizationId);
            if (org?.enabledIntegrations) {
                orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
                    ? JSON.parse(org.enabledIntegrations) : org.enabledIntegrations;
            } else {
                const globalDefaults = await configStore.getConfig('default_org_integrations');
                if (globalDefaults) {
                    orgEnabledIntegrations = typeof globalDefaults === 'string'
                        ? JSON.parse(globalDefaults) : globalDefaults;
                }
            }
            // NOTE: orgActiveSet (the org-admin "active integrations" subset) is
            // intentionally NOT consulted here. That layer is a runtime override
            // for tool dispatch — when an org hasn't populated it (the default
            // on most installs incl. dev) it ends up as an empty Set which
            // erroneously hides EVERY non-NC, non-exempt app. Palette is design-
            // time discovery; runtime still enforces all gates via
            // getIntegrationTools. See plan: kijk-naar-het-ontwerp-sequential-wirth.
            const userGroupIds = Array.isArray(currentUser.groups)
                ? currentUser.groups
                : (() => { try { return JSON.parse(currentUser.groups || '[]'); } catch { return []; } })();
            if (userGroupIds.length > 0) {
                const allGroups = await userStore.getAllGroups();
                const groupById = new Map(allGroups.map(g => [g.id, g]));
                userGroupDisableLists = userGroupIds
                    .map(gid => groupById.get(gid))
                    .filter(Boolean)
                    .map(g => Array.isArray(g.disabled_integrations) ? g.disabled_integrations : []);
                if (userGroupDisableLists.every(lst => lst.length === 0)) userGroupDisableLists = null;
            }
        }
    } catch (_) { /* fail open */ }

    const isAppOn = (appId) => {
        if (userEnabledApps) {
            if (AUTO_ENABLED_APPS.includes(appId)) {
                // auto-enabled — bypass user list
            } else if (!userEnabledApps.includes(appId)) {
                return false;
            }
        }
        if (!ORG_EXEMPT_APPS.includes(appId) && orgEnabledIntegrations && !orgEnabledIntegrations.includes(appId)) return false;
        // orgActiveSet check intentionally omitted — see comment above where it's resolved.
        if (userGroupDisableLists && appId.startsWith('nextcloud') && userGroupDisableLists.every(lst => lst.includes(appId))) {
            return false;
        }
        return true;
    };

    const out = new Set();
    try {
        const { TOOL_REGISTRY } = require('../automation/toolRegistry');
        for (const entry of TOOL_REGISTRY) {
            if (isAppOn(entry.app)) out.add(entry.app);
        }
    } catch (_) { /* registry unavailable */ }
    return out;
}

module.exports = { getIntegrationTools, buildToolHint, getUserPermittedApps, appendMcpTools, appendCustomIntegrationTools };
