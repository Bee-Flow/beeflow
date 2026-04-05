/**
 * SignRequest Tools — Built-in tools for AI to create and track e-signature requests
 * 
 * These tools are injected into the LLM tool set when a SignRequest subdomain + token
 * are configured, allowing the AI to send documents for signing and check status.
 * Uses raw REST API — no npm dependencies.
 */

const configStore = require('../stores/configStore');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const SIGNREQUEST_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'signrequest_send_document',
            description: 'Send a document for e-signature via SignRequest. You can send a document by providing a publicly accessible URL to the file. The signers will receive an email with a link to sign the document.',
            parameters: {
                type: 'object',
                properties: {
                    fileUrl: {
                        type: 'string',
                        description: 'Public URL to the document (PDF, DOCX, etc.)'
                    },
                    signers: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                email: { type: 'string', description: 'Signer email address' },
                                first_name: { type: 'string', description: 'Signer first name' },
                                last_name: { type: 'string', description: 'Signer last name' },
                                order: { type: 'integer', description: 'Signing order (0 = all at once, 1+ = sequential)' }
                            },
                            required: ['email']
                        },
                        description: 'List of signers who need to sign the document'
                    },
                    subject: {
                        type: 'string',
                        description: 'Email subject line for the signing request'
                    },
                    message: {
                        type: 'string',
                        description: 'Message to include in the signing request email'
                    },
                    fromEmail: {
                        type: 'string',
                        description: 'Sender email address (must be a team member email)'
                    }
                },
                required: ['fileUrl', 'signers']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'signrequest_check_status',
            description: 'Check the signing status of a specific document by its UUID. Returns whether the document has been signed, declined, or is still pending.',
            parameters: {
                type: 'object',
                properties: {
                    documentUuid: {
                        type: 'string',
                        description: 'The UUID of the document to check'
                    }
                },
                required: ['documentUuid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'signrequest_list_documents',
            description: 'List recent documents and their signing status from SignRequest. Returns the most recent documents with their status, signers, and creation date.',
            parameters: {
                type: 'object',
                properties: {
                    page: {
                        type: 'integer',
                        description: 'Page number for pagination (default 1)'
                    },
                    limit: {
                        type: 'integer',
                        description: 'Number of results per page (default 10, max 50)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'signrequest_cancel',
            description: 'Cancel a pending sign request. Only works if the document has not yet been fully signed.',
            parameters: {
                type: 'object',
                properties: {
                    signrequestUuid: {
                        type: 'string',
                        description: 'The UUID of the sign request to cancel'
                    }
                },
                required: ['signrequestUuid']
            }
        }
    }
];

// ─── API Client ────────────────────────────────────────────────

async function signrequestApiRequest(subdomain, token, method, path, body = null) {
    const baseUrl = `https://${subdomain}.signrequest.com/api/v1`;
    const url = `${baseUrl}${path}`;

    const headers = {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json',
    };

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`SignRequest API error (${response.status}): ${text.slice(0, 500)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }
    return null;
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeSignRequestTool(toolName, args, userId) {
    if (!userId) return { error: 'User context required for SignRequest.' };
    const subdomain = await configStore.getSecret(`signrequest_subdomain_user_${userId}`);
    const token = await configStore.getSecret(`signrequest_token_user_${userId}`);

    if (!subdomain || !token) {
        return { error: 'SignRequest not configured. Add your SignRequest subdomain and API token in Settings → Integrations.' };
    }

    if (toolName === 'signrequest_send_document') {
        const signers = args.signers || [];
        if (signers.length === 0) return { error: 'At least one signer is required.' };

        const payload = {
            document: {
                file_from_url: args.fileUrl,
            },
            signers: signers.map(s => ({
                email: s.email,
                first_name: s.first_name || '',
                last_name: s.last_name || '',
                order: s.order || 0,
            })),
        };

        if (args.subject) payload.subject = args.subject;
        if (args.message) payload.message = args.message;
        if (args.fromEmail) payload.from_email = args.fromEmail;

        console.log(`[SignRequest] Sending document for signing to: ${signers.map(s => s.email).join(', ')}`);
        const result = await signrequestApiRequest(subdomain, token, 'POST', '/signrequest-quick-create/', payload);

        return {
            success: true,
            message: `Document sent for signing to ${signers.length} signer(s).`,
            documentUuid: result?.document?.uuid,
            signrequestUuid: result?.uuid,
            status: result?.document?.status,
            signers: result?.signers?.map(s => ({
                email: s.email,
                name: [s.first_name, s.last_name].filter(Boolean).join(' '),
                status: s.status_display || s.status,
            })),
        };
    }

    if (toolName === 'signrequest_check_status') {
        const uuid = args.documentUuid;
        if (!uuid) return { error: 'Document UUID is required.' };

        console.log(`[SignRequest] Checking document status: ${uuid}`);
        const doc = await signrequestApiRequest(subdomain, token, 'GET', `/documents/${uuid}/`);

        return {
            uuid: doc.uuid,
            name: doc.name || doc.file_name,
            status: doc.status_display || doc.status,
            createdAt: doc.created,
            signrequest: doc.signrequest ? {
                uuid: doc.signrequest.uuid,
                status: doc.signrequest.status_display || doc.signrequest.status,
                signers: doc.signrequest.signers?.map(s => ({
                    email: s.email,
                    name: [s.first_name, s.last_name].filter(Boolean).join(' '),
                    status: s.status_display || s.status,
                    signedOn: s.signed_on,
                })),
            } : null,
        };
    }

    if (toolName === 'signrequest_list_documents') {
        const page = Math.max(parseInt(args.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(args.limit) || 10, 1), 50);

        console.log(`[SignRequest] Listing documents (page ${page}, limit ${limit})`);
        const result = await signrequestApiRequest(subdomain, token, 'GET', `/documents/?page=${page}&limit=${limit}`);

        const documents = (result?.results || []).map(doc => ({
            uuid: doc.uuid,
            name: doc.name || doc.file_name,
            status: doc.status_display || doc.status,
            createdAt: doc.created,
            signerCount: doc.signrequest?.signers?.length || 0,
        }));

        return {
            documents,
            count: result?.count || documents.length,
            totalPages: result?.count ? Math.ceil(result.count / limit) : 1,
            currentPage: page,
        };
    }

    if (toolName === 'signrequest_cancel') {
        const uuid = args.signrequestUuid;
        if (!uuid) return { error: 'Sign request UUID is required.' };

        console.log(`[SignRequest] Cancelling sign request: ${uuid}`);
        await signrequestApiRequest(subdomain, token, 'POST', `/signrequests/${uuid}/cancel_signrequest/`);

        return {
            success: true,
            message: `Sign request ${uuid} has been cancelled.`,
        };
    }

    return { error: `Unknown SignRequest tool: ${toolName}` };
}

// ─── Helpers ───────────────────────────────────────────────────

function isSignRequestTool(name) {
    return name?.startsWith('signrequest_');
}

/**
 * Send a base64-encoded PDF via SignRequest quick-create.
 * Used by the notebook export endpoint (not an AI tool).
 */
async function sendPdfForSigning(userId, { pdfBase64, fileName, signers, subject, message, fromEmail }) {
    const subdomain = await configStore.getSecret(`signrequest_subdomain_user_${userId}`);
    const token = await configStore.getSecret(`signrequest_token_user_${userId}`);

    if (!subdomain || !token) {
        throw new Error('SignRequest not configured. Add your SignRequest subdomain and API token in Settings → Integrations.');
    }

    const payload = {
        document: {
            file_from_content: pdfBase64,
            file_from_content_name: fileName || 'document.pdf',
        },
        signers: signers.map(s => ({
            email: s.email,
            first_name: s.first_name || '',
            last_name: s.last_name || '',
            order: s.order || 0,
        })),
    };

    if (subject) payload.subject = subject;
    if (message) payload.message = message;
    if (fromEmail) payload.from_email = fromEmail;

    console.log(`[SignRequest] Sending PDF "${fileName}" for signing to: ${signers.map(s => s.email).join(', ')}`);
    return await signrequestApiRequest(subdomain, token, 'POST', '/signrequest-quick-create/', payload);
}

module.exports = {
    SIGNREQUEST_TOOLS,
    executeSignRequestTool,
    isSignRequestTool,
    sendPdfForSigning,
};
