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

    // Skip if no INIT_ vars are set
    const hasAny = adminPassword || msClientId || msClientSecret || azureEndpoint || azureApiKey || bingSearchKey;
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
                console.log('[boot-init] ✅ Bing Search key configured');
            }, 'Bing Search');
        }

        console.log('[boot-init] First-boot setup complete');
    } catch (err) {
        console.error('[boot-init] Error during setup:', err);
    }
}

module.exports = { runBootInit };
