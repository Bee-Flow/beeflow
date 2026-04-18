/**
 * Boot Initializer — First-boot setup from INIT_* environment variables
 * 
 * When the install wizard deploys BeeFlow, it passes secrets as INIT_* env vars
 * in docker-compose. On first boot, this module reads them and configures the
 * server directly using internal APIs — no HTTP calls, no auth, no timing issues.
 * 
 * Environment variables:
 *   INIT_ADMIN_PASSWORD       — Creates admin account with this password
 *   INIT_MS_CLIENT_ID         — Microsoft SSO Application (Client) ID
 *   INIT_MS_CLIENT_SECRET     — Microsoft SSO Client Secret
 *   INIT_MS_TENANT_ID         — Microsoft SSO Tenant ID (default: 'common')
 *   INIT_AZURE_ENDPOINT       — Azure OpenAI endpoint URL
 *   INIT_AZURE_API_KEY        — Azure OpenAI API key
 *   INIT_AZURE_API_VERSION    — Azure OpenAI API version
 *   INIT_AZURE_MODELS         — Azure OpenAI deployment models (comma-separated)
 *   INIT_BING_SEARCH_KEY      — Bing Search API key
 *   INIT_BING_SEARCH_MARKET   — Bing Search market (e.g. en-US, nl-NL)
 *   INIT_SEARCH_PROVIDER      — Search provider: 'bing' | 'agent-search' | ''
 *   INIT_SERPER_API_KEY       — Serper.dev API key (for agent-search web search)
 *   INIT_AI_PROVIDER          — Generic AI provider: 'openai' | 'google' | 'mistral' | 'claude'
 *   INIT_GENERIC_API_KEY      — API key for the generic AI provider above
 *   INIT_CHAT_MODEL_TIERS     — JSON: { fast, standard, thinking, writer, pro } each { modelId }
 *   INIT_OFFICE_APPS_ENABLED  — 'true' | 'false' — enables Office 365 integration
 */

const bcrypt = require('bcryptjs');

async function runBootInit() {
    const adminPassword = process.env.INIT_ADMIN_PASSWORD;
    const msClientId = process.env.INIT_MS_CLIENT_ID;
    const msClientSecret = process.env.INIT_MS_CLIENT_SECRET;
    const msTenantId = process.env.INIT_MS_TENANT_ID;
    const azureEndpoint = process.env.INIT_AZURE_ENDPOINT;
    const azureApiKey = process.env.INIT_AZURE_API_KEY;
    const azureApiVersion = process.env.INIT_AZURE_API_VERSION;
    const azureModels = process.env.INIT_AZURE_MODELS;
    const bingSearchKey = process.env.INIT_BING_SEARCH_KEY;
    const bingSearchMarket = process.env.INIT_BING_SEARCH_MARKET;
    const searchProvider = process.env.INIT_SEARCH_PROVIDER;
    const serperApiKey = process.env.INIT_SERPER_API_KEY;
    const aiProvider = process.env.INIT_AI_PROVIDER;
    const genericApiKey = process.env.INIT_GENERIC_API_KEY;
    const chatModelTiersRaw = process.env.INIT_CHAT_MODEL_TIERS;
    const officeAppsEnabled = process.env.INIT_OFFICE_APPS_ENABLED;

    // Skip if no INIT_ vars are set
    const hasAny = adminPassword || msClientId || msClientSecret || azureEndpoint || azureApiKey
        || bingSearchKey || serperApiKey || aiProvider || genericApiKey || chatModelTiersRaw
        || searchProvider;
    if (!hasAny) return;

    console.log('[boot-init] Found INIT_* environment variables, running first-boot setup...');

    // Wait a moment for DB stores to initialize their tables
    await new Promise(r => setTimeout(r, 3000));

    // Retry wrapper (DB might still be initializing)
    const retry = async (fn, label, attempts = 3) => {
        for (let i = 0; i < attempts; i++) {
            try { return await fn(); }
            catch (err) {
                console.warn(`[boot-init] ${label} attempt ${i + 1} failed:`, err.message);
                if (i < attempts - 1) await new Promise(r => setTimeout(r, 2000));
                else throw err;
            }
        }
    };

    try {
        const { loadConfig, saveConfig } = require('./auth/permissions');
        const configStore = require('./stores/configStore');
        const userStore = require('./stores/userStore');
        const { saveAIConfig } = require('./core/aiAgent');

        // ── 1. Admin account ────────────────────────────────────────
        if (adminPassword) {
            await retry(async () => {
                const config = await loadConfig();
                if (!config.admin.passwordHash) {
                    config.admin.passwordHash = await bcrypt.hash(adminPassword, 12);
                    if (saveConfig(config)) {
                        console.log('[boot-init] ✅ Admin password set');

                        // Create admin user in the users table
                        const existing = await userStore.getUser('admin');
                        if (!existing) {
                            await userStore.createUser({
                                id: 'admin',
                                username: 'admin',
                                displayName: 'Administrator',
                                passwordHash: config.admin.passwordHash,
                                role: 'admin',
                                groups: []
                            });
                            console.log('[boot-init] ✅ Admin user row created');
                        }
                    } else {
                        console.error('[boot-init] ❌ Failed to save admin password');
                    }
                } else {
                    console.log('[boot-init] Admin password already set, skipping');
                }
            }, 'Admin account');
        }

        // ── 2. Microsoft SSO ────────────────────────────────────────
        if (msClientId || msClientSecret) {
            await retry(async () => {
                const config = await loadConfig();
                config.providers = config.providers || {};
                config.providers.microsoft = config.providers.microsoft || {};
                if (msClientId) config.providers.microsoft.clientId = msClientId;
                if (msClientSecret) config.providers.microsoft.clientSecret = msClientSecret;
                config.providers.microsoft.tenantId = msTenantId || 'common';

                if (saveConfig(config)) {
                    console.log('[boot-init] ✅ Microsoft SSO configured');
                } else {
                    console.error('[boot-init] ❌ Failed to save Microsoft SSO config');
                }
            }, 'Microsoft SSO');
        }

        // ── 3. Azure OpenAI ─────────────────────────────────────────
        if (azureEndpoint || azureApiKey) {
            await retry(async () => {
                await saveAIConfig({
                    azureEndpoint: azureEndpoint || undefined,
                    azureApiKey: azureApiKey || undefined,
                    azureApiVersion: azureApiVersion || undefined,
                });
                if (azureModels) {
                    await configStore.setConfig('azure_models', azureModels);
                }
                console.log('[boot-init] ✅ Azure OpenAI configured');
            }, 'Azure OpenAI');
        }

        // ── 4. Bing Search ──────────────────────────────────────────
        if (bingSearchKey) {
            await retry(async () => {
                await configStore.setSecret('bing_search_key', bingSearchKey);
                if (bingSearchMarket) await configStore.setConfig('bing_search_market', bingSearchMarket);
                console.log('[boot-init] ✅ Bing Search configured');
            }, 'Bing Search');
        }

        // ── 5. Search provider + Serper ─────────────────────────────
        if (searchProvider) {
            await retry(async () => {
                await configStore.setConfig('search_provider', searchProvider);
                console.log(`[boot-init] ✅ Search provider set to: ${searchProvider}`);
            }, 'Search Provider');
        }
        if (serperApiKey) {
            await retry(async () => {
                await configStore.setSecret('serper_api_key', serperApiKey);
                console.log('[boot-init] ✅ Serper API key saved');
            }, 'Serper API Key');
        }

        // ── 6. Generic AI provider key ──────────────────────────────
        // Maps aiProvider ('openai', 'google', 'mistral', 'claude') to
        // the configStore secret key used by the server.
        if (aiProvider && genericApiKey) {
            const secretKeyMap = {
                openai:  'openai_api_key',
                google:  'google_api_key',
                mistral: 'mistral_api_key',
                claude:  'claude_api_key',
            };
            const secretKey = secretKeyMap[aiProvider];
            if (secretKey) {
                await retry(async () => {
                    await configStore.setSecret(secretKey, genericApiKey);
                    console.log(`[boot-init] ✅ ${aiProvider} API key saved`);
                }, `${aiProvider} API Key`);
            } else {
                console.warn(`[boot-init] Unknown AI provider: ${aiProvider}`);
            }
        }

        // ── 7. Model tier configuration ─────────────────────────────
        // Tiers are stored in configStore ('chat_model_tiers') as:
        // { fast: { modelId }, standard: { modelId }, thinking: { modelId }, writer: { modelId }, pro: { modelId } }
        if (chatModelTiersRaw) {
            await retry(async () => {
                const incoming = JSON.parse(chatModelTiersRaw);
                const existing = await configStore.getConfig('chat_model_tiers') || {};
                const merged = {
                    fast:     { modelId: '', label: 'Fast',          ...(existing.fast     || {}), ...(incoming.fast     || {}) },
                    standard: { modelId: '', label: 'Standard (Direct)', ...(existing.standard || {}), ...(incoming.standard || {}) },
                    thinking: { modelId: '', label: 'Thinking',      ...(existing.thinking || {}), ...(incoming.thinking || {}) },
                    writer:   { modelId: '', label: 'Writer',        ...(existing.writer   || {}), ...(incoming.writer   || {}) },
                    pro:      { modelId: '', label: 'Deep Thinking',  ...(existing.pro      || {}), ...(incoming.pro      || {}) },
                };
                // Remove empty modelIds so auto-selection still works
                for (const key of Object.keys(merged)) {
                    if (!merged[key].modelId) delete merged[key].modelId;
                }
                await configStore.setConfig('chat_model_tiers', merged);
                const set = Object.entries(incoming)
                    .filter(([, v]) => v?.modelId)
                    .map(([k, v]) => `${k}=${v.modelId}`)
                    .join(', ');
                console.log(`[boot-init] ✅ Model tiers configured: ${set || '(none set)'}`);
            }, 'Model Tiers');
        }

        // ── 8. Office 365 integration flag ──────────────────────────
        if (officeAppsEnabled) {
            await retry(async () => {
                await configStore.setConfig('office_apps_enabled', officeAppsEnabled === 'true' ? 'true' : '');
                console.log(`[boot-init] ✅ Office Apps: ${officeAppsEnabled}`);
            }, 'Office Apps');
        }

        console.log('[boot-init] First-boot setup complete');
    } catch (err) {
        console.error('[boot-init] Error during setup:', err);
    }
}

module.exports = { runBootInit };
