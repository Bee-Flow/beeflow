/**
 * Azure AI Document Intelligence — extract structured content from documents.
 *
 * Uses the Layout model with Markdown output for LLM-friendly extraction.
 * Supports: PDF, DOCX, XLSX, PPTX, JPEG, PNG, TIFF, BMP.
 *
 * SDK: @azure-rest/ai-document-intelligence
 * Auth: AzureKeyCredential from @azure/core-auth
 *
 * Config stored in configStore (same pattern as azurePiiDetection.js):
 *   - azure_doc_intelligence_endpoint (config)
 *   - azure_doc_intelligence_key (secret, encrypted at rest)
 */

const configStore = require('../stores/configStore');

// ── Cached client ────────────────────────────────────────────────
let _client = null;
let _clientConfig = null;

/**
 * Create or return cached Azure Document Intelligence client.
 * @returns {object|null} The client, or null if not configured.
 */
async function getClient() {
    const endpoint = await configStore.getConfig('azure_doc_intelligence_endpoint');
    const apiKey = await configStore.getSecret('azure_doc_intelligence_key');

    if (!endpoint || !apiKey) {
        return null;
    }

    const configKey = `${endpoint}:${apiKey}`;
    if (_client && _clientConfig === configKey) {
        return _client;
    }

    const DocumentIntelligence = require('@azure-rest/ai-document-intelligence').default;
    const { AzureKeyCredential } = require('@azure/core-auth');

    _client = DocumentIntelligence(endpoint, new AzureKeyCredential(apiKey));
    _clientConfig = configKey;
    return _client;
}

/**
 * Extract text from a document buffer using Azure AI Document Intelligence.
 * Returns structured Markdown content using the Layout model.
 *
 * @param {Buffer} buffer - Raw file bytes
 * @param {string} filename - Original filename (for logging)
 * @returns {Promise<string>} Extracted Markdown content
 * @throws {Error} If extraction fails or service is not configured
 */
async function extractWithAzure(buffer, filename = 'unknown') {
    const client = await getClient();
    if (!client) {
        throw new Error('Azure Document Intelligence is not configured. Set endpoint and key in admin settings.');
    }

    console.log(`[AzureDocIntelligence] Analyzing document: ${filename} (${buffer.length} bytes)`);

    const base64Source = buffer.toString('base64');

    // Use the Layout model with Markdown output
    const initialResponse = await client
        .path('/documentModels/{modelId}:analyze', 'prebuilt-layout')
        .post({
            contentType: 'application/json',
            body: {
                base64Source,
            },
            queryParameters: {
                outputContentFormat: 'markdown',
            },
        });

    if (initialResponse.status !== '202') {
        const errorBody = initialResponse.body;
        throw new Error(`Azure Document Intelligence error: ${initialResponse.status} - ${JSON.stringify(errorBody)}`);
    }

    // Poll for result
    const operationLocation = initialResponse.headers['operation-location'];
    if (!operationLocation) {
        throw new Error('Azure Document Intelligence: No operation-location header in response');
    }

    const { AzureKeyCredential } = require('@azure/core-auth');
    const endpoint = await configStore.getConfig('azure_doc_intelligence_endpoint');
    const apiKey = await configStore.getSecret('azure_doc_intelligence_key');

    const maxPolls = 60; // 60 * 2s = 2 minutes max
    const pollIntervalMs = 2000;

    for (let i = 0; i < maxPolls; i++) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        const pollResponse = await fetch(operationLocation, {
            headers: {
                'Ocp-Apim-Subscription-Key': apiKey,
            },
        });

        if (!pollResponse.ok) {
            throw new Error(`Azure Document Intelligence poll error: ${pollResponse.status}`);
        }

        const result = await pollResponse.json();

        if (result.status === 'succeeded') {
            const content = result.analyzeResult?.content || '';
            const pageCount = result.analyzeResult?.pages?.length || 0;

            if (!content.trim()) {
                console.warn(`[AzureDocIntelligence] No content extracted from ${filename} (${pageCount} pages)`);
                return '';
            }

            console.log(`[AzureDocIntelligence] Extracted ${content.length} chars from ${filename} (${pageCount} pages)`);
            return content;
        }

        if (result.status === 'failed') {
            const error = result.error || {};
            throw new Error(`Azure Document Intelligence analysis failed: ${error.code || 'unknown'} - ${error.message || 'unknown error'}`);
        }

        // status is 'running' or 'notStarted' — continue polling
    }

    throw new Error(`Azure Document Intelligence: Analysis timed out after ${maxPolls * pollIntervalMs / 1000}s for ${filename}`);
}

/**
 * Check if Azure Document Intelligence is configured.
 * @returns {Promise<boolean>}
 */
async function isAzureDocIntelligenceConfigured() {
    const endpoint = await configStore.getConfig('azure_doc_intelligence_endpoint');
    const apiKey = await configStore.getSecret('azure_doc_intelligence_key');
    return !!(endpoint && apiKey);
}

module.exports = {
    extractWithAzure,
    isAzureDocIntelligenceConfigured,
};
