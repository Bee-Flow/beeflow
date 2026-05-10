/**
 * KB provider resolver.
 *
 * Returns 'local' or 'remote' based on:
 *   1. Admin config `kb_provider` (explicit override).
 *   2. `use_azure_doc_processing` flag (legacy synonym for 'local').
 *   3. SEARCH_SERVICE_URL — when set we default to 'remote' so existing
 *      installs keep working; otherwise default to 'local' so fresh
 *      installs work without a GPU service.
 */

const configStore = require('../../stores/configStore');

async function resolveKbProvider() {
    const explicit = await configStore.getConfig('kb_provider');
    if (explicit === 'local' || explicit === 'remote') return explicit;

    const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
    if (useAzure) return 'local';

    return process.env.SEARCH_SERVICE_URL ? 'remote' : 'local';
}

module.exports = { resolveKbProvider };
