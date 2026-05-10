/**
 * Provider classification — is this LLM call leaving the organisation's infrastructure?
 *
 * Used by the DLP (Data Loss Prevention) layer to decide whether to scan a prompt
 * before it goes out. The rule: if the LLM runs on the same network as BeeFlow,
 * a prompt doesn't leave the perimeter and DLP can be skipped. If it's a cloud
 * provider (OpenAI, Anthropic, Google, Azure, Mistral, …), DLP must run.
 *
 * "Internal" is determined by three signals, in order:
 *   1. Explicit provider-type (e.g. 'local', 'ollama') — always internal.
 *   2. RFC 1918 / loopback / .local / admin-whitelisted host in the URL — internal.
 *   3. Known cloud provider type or cloud URL pattern — external.
 *   4. Unknown → treated as external (fail-closed for privacy).
 */

// External provider types: everything that terminates on someone else's servers.
const EXTERNAL_TYPES = new Set([
    'openai',
    'claude',
    'anthropic',
    'google',
    'google-vertex',
    'azure',
    'mistral',
    'cohere',
    'groq',
    'together',
    'fireworks',
    'perplexity',
]);

// Explicit internal markers — admin-set provider types that name self-hosted stacks.
const INTERNAL_TYPES = new Set([
    'local',
    'ollama',
    'lmstudio',
    'vllm',
    'llamacpp',
    'llama.cpp',
    'internal',
]);

// Hostnames / URL patterns that are unambiguously cloud.
const EXTERNAL_URL_PATTERNS = [
    /\.openai\.com/i,
    /\.anthropic\.com/i,
    /\.mistral\.ai/i,
    /generativelanguage\.googleapis\.com/i,
    /aiplatform\.googleapis\.com/i,
    /\.openai\.azure\.com/i,
    /cognitiveservices\.azure\.com/i,
    /cohere\.(com|ai)/i,
    /groq\.com/i,
    /together\.xyz/i,
    /fireworks\.ai/i,
    /perplexity\.ai/i,
];

// Private-network / local-host patterns. If the URL matches one of these it's
// almost certainly self-hosted on the customer's own network.
const PRIVATE_HOST_PATTERNS = [
    /^localhost(:|$|\/)/i,
    /^127\.\d+\.\d+\.\d+/i,
    /^10\.\d+\.\d+\.\d+/i,
    /^192\.168\.\d+\.\d+/i,
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/i,
    /\.local(:|$|\/)/i,
    /\.internal(:|$|\/)/i,
    /\.lan(:|$|\/)/i,
];

function extractHost(url) {
    if (!url) return '';
    try {
        // new URL() needs a scheme. Tolerate bare hosts like "ollama:11434".
        const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
        const u = new URL(hasScheme ? url : `http://${url}`);
        return u.host;
    } catch {
        return String(url).trim();
    }
}

/**
 * Is this URL pointing at an internal / private-network host?
 */
function isPrivateHost(url, allowlistedHosts = []) {
    const host = extractHost(url);
    if (!host) return false;
    if (allowlistedHosts.some(h => host === h || host.endsWith(`.${h}`))) return true;
    return PRIVATE_HOST_PATTERNS.some(p => p.test(host));
}

/**
 * Classify a chat-provider config.
 *
 * @param {object} config
 * @param {string} [config.providerType]  e.g. 'openai', 'ollama', 'azure'
 * @param {string} [config.url]           Endpoint URL (may be absent for some types)
 * @param {string[]} [allowlistedHosts]   Admin-declared private hostnames (e.g. 'models.corp.local')
 * @returns {{ isExternal: boolean, reason: string, displayName: string }}
 */
function classifyProvider(config = {}, allowlistedHosts = []) {
    const providerType = String(config.providerType || config.type || '').toLowerCase();
    const url = config.url || '';

    const displayName = config.displayName
        || config.providerType
        || (url ? extractHost(url) : 'unknown');

    if (INTERNAL_TYPES.has(providerType)) {
        return { isExternal: false, reason: `provider_type:${providerType}`, displayName };
    }
    if (url && isPrivateHost(url, allowlistedHosts)) {
        return { isExternal: false, reason: 'private_host', displayName };
    }
    if (EXTERNAL_TYPES.has(providerType)) {
        return { isExternal: true, reason: `provider_type:${providerType}`, displayName };
    }
    if (url && EXTERNAL_URL_PATTERNS.some(p => p.test(url))) {
        return { isExternal: true, reason: 'cloud_url_pattern', displayName };
    }
    // Unknown provider + non-private URL → fail-closed, treat as external for DLP.
    return { isExternal: true, reason: 'unknown_fail_closed', displayName };
}

/**
 * Convenience boolean variant for call-sites that don't care about the reason.
 */
function isExternalProvider(config, allowlistedHosts = []) {
    return classifyProvider(config, allowlistedHosts).isExternal;
}

module.exports = {
    classifyProvider,
    isExternalProvider,
    isPrivateHost,
    // Exposed for unit tests
    _EXTERNAL_TYPES: EXTERNAL_TYPES,
    _INTERNAL_TYPES: INTERNAL_TYPES,
};
