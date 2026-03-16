/**
 * Microsoft Contacts Tools — Built-in tools for AI to manage Outlook Contacts
 * 
 * Mirror of contactsTools.js for Microsoft 365 users.
 * Uses Microsoft Graph API v1.0 with OAuth2 tokens from session.
 */

const { graphFetch, isMicrosoftConnected } = require('./msGraphClient');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const MS_CONTACTS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'ms_contacts_search',
            description: 'Search the user\'s Microsoft/Outlook contacts by name or email address.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query — name, email, or keyword to search for'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of results to return (1-25, default 10)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_contacts_list',
            description: 'List the user\'s Microsoft/Outlook contacts. Returns name, email, phone, and company for each contact.',
            parameters: {
                type: 'object',
                properties: {
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of contacts to return (1-50, default 25)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_contacts_create',
            description: 'Create a new contact in the user\'s Microsoft/Outlook contacts. The user will see a preview before the contact is created.',
            parameters: {
                type: 'object',
                properties: {
                    givenName: {
                        type: 'string',
                        description: 'First name'
                    },
                    surname: {
                        type: 'string',
                        description: 'Last name'
                    },
                    emailAddress: {
                        type: 'string',
                        description: 'Primary email address'
                    },
                    phone: {
                        type: 'string',
                        description: 'Optional: Phone number'
                    },
                    companyName: {
                        type: 'string',
                        description: 'Optional: Company name'
                    },
                    jobTitle: {
                        type: 'string',
                        description: 'Optional: Job title'
                    }
                },
                required: ['givenName']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_contacts_update',
            description: 'Update an existing contact in Microsoft/Outlook contacts. The user will see a preview of changes before they are applied.',
            parameters: {
                type: 'object',
                properties: {
                    contactId: {
                        type: 'string',
                        description: 'The contact ID to update (from ms_contacts_search or ms_contacts_list)'
                    },
                    givenName: {
                        type: 'string',
                        description: 'New first name'
                    },
                    surname: {
                        type: 'string',
                        description: 'New last name'
                    },
                    emailAddress: {
                        type: 'string',
                        description: 'New primary email address'
                    },
                    phone: {
                        type: 'string',
                        description: 'New phone number'
                    },
                    companyName: {
                        type: 'string',
                        description: 'New company name'
                    },
                    jobTitle: {
                        type: 'string',
                        description: 'New job title'
                    }
                },
                required: ['contactId']
            }
        }
    }
];

/**
 * Format a Graph API contact into a consistent shape.
 */
function formatContact(contact) {
    const emails = contact.emailAddresses || [];
    const phones = [
        ...(contact.businessPhones || []),
        ...(contact.mobilePhone ? [contact.mobilePhone] : []),
        ...(contact.homePhones || []),
    ];

    return {
        id: contact.id,
        givenName: contact.givenName || '',
        surname: contact.surname || '',
        displayName: contact.displayName || `${contact.givenName || ''} ${contact.surname || ''}`.trim(),
        email: emails.length > 0 ? emails[0].address : '',
        allEmails: emails.map(e => e.address),
        phone: phones.length > 0 ? phones[0] : '',
        allPhones: phones,
        companyName: contact.companyName || '',
        jobTitle: contact.jobTitle || '',
    };
}

/**
 * Execute a Microsoft Contacts tool call.
 */
async function executeMsContactsTool(toolName, args, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Microsoft Contacts — user must log in with Microsoft');
    }

    if (toolName === 'ms_contacts_search') {
        const { query, maxResults = 10 } = args;
        if (!query) throw new Error('query is required');
        const top = Math.min(Math.max(parseInt(maxResults) || 10, 1), 25);

        // Use $filter with startswith on displayName, or $search
        const data = await graphFetch(
            `/me/contacts?$filter=startswith(displayName,'${encodeURIComponent(query)}') or startswith(givenName,'${encodeURIComponent(query)}') or startswith(surname,'${encodeURIComponent(query)}')&$top=${top}&$select=id,givenName,surname,displayName,emailAddresses,businessPhones,mobilePhone,homePhones,companyName,jobTitle`,
            session
        );

        return {
            contacts: (data.value || []).map(formatContact),
            total: (data.value || []).length,
            query,
        };

    } else if (toolName === 'ms_contacts_list') {
        const { maxResults = 25 } = args;
        const top = Math.min(Math.max(parseInt(maxResults) || 25, 1), 50);

        const data = await graphFetch(
            `/me/contacts?$top=${top}&$orderby=displayName&$select=id,givenName,surname,displayName,emailAddresses,businessPhones,mobilePhone,homePhones,companyName,jobTitle`,
            session
        );

        return {
            contacts: (data.value || []).map(formatContact),
            total: (data.value || []).length,
        };

    } else if (toolName === 'ms_contacts_create') {
        const { givenName, surname, emailAddress, phone, companyName, jobTitle } = args;
        if (!givenName) throw new Error('givenName is required');

        const draft = {
            action: 'create',
            _provider: 'microsoft',
            givenName,
            surname: surname || null,
            emailAddress: emailAddress || null,
            phone: phone || null,
            companyName: companyName || null,
            jobTitle: jobTitle || null,
        };

        return {
            _action: 'contacts_draft',
            _provider: 'microsoft',
            _contactsAction: 'create',
            draft,
            message: `Contact "${givenName}${surname ? ' ' + surname : ''}" prepared. Waiting for user approval to create.`,
        };

    } else if (toolName === 'ms_contacts_update') {
        const { contactId, givenName, surname, emailAddress, phone, companyName, jobTitle } = args;
        if (!contactId) throw new Error('contactId is required');

        const changes = {};
        if (givenName) changes.givenName = givenName;
        if (surname) changes.surname = surname;
        if (emailAddress) changes.emailAddress = emailAddress;
        if (phone) changes.phone = phone;
        if (companyName !== undefined) changes.companyName = companyName;
        if (jobTitle !== undefined) changes.jobTitle = jobTitle;

        return {
            _action: 'contacts_draft',
            _provider: 'microsoft',
            _contactsAction: 'update',
            draft: { action: 'update', _provider: 'microsoft', contactId, ...changes },
            message: `Contact update prepared. Waiting for user approval.`,
        };

    } else {
        throw new Error(`Unknown MS Contacts tool: ${toolName}`);
    }
}

/**
 * Execute an approved MS Contacts action via Graph API.
 */
async function executeMsContactsAction(action, draft, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Microsoft Contacts');
    }

    if (action === 'create') {
        const contact = {
            givenName: draft.givenName,
        };
        if (draft.surname) contact.surname = draft.surname;
        if (draft.emailAddress) {
            contact.emailAddresses = [{ address: draft.emailAddress, name: `${draft.givenName} ${draft.surname || ''}`.trim() }];
        }
        if (draft.phone) {
            contact.businessPhones = [draft.phone];
        }
        if (draft.companyName) contact.companyName = draft.companyName;
        if (draft.jobTitle) contact.jobTitle = draft.jobTitle;

        const result = await graphFetch('/me/contacts', session, {
            method: 'POST',
            body: JSON.stringify(contact),
        });

        return {
            success: true,
            contactId: result.id,
            displayName: result.displayName,
            message: `Contact "${result.displayName}" created successfully.`,
        };

    } else if (action === 'update') {
        const { contactId, ...changes } = draft;
        const patch = {};

        if (changes.givenName) patch.givenName = changes.givenName;
        if (changes.surname) patch.surname = changes.surname;
        if (changes.emailAddress) {
            patch.emailAddresses = [{ address: changes.emailAddress }];
        }
        if (changes.phone) {
            patch.businessPhones = [changes.phone];
        }
        if (changes.companyName !== undefined) patch.companyName = changes.companyName;
        if (changes.jobTitle !== undefined) patch.jobTitle = changes.jobTitle;

        const result = await graphFetch(`/me/contacts/${contactId}`, session, {
            method: 'PATCH',
            body: JSON.stringify(patch),
        });

        return {
            success: true,
            contactId: result.id,
            displayName: result.displayName,
            message: `Contact "${result.displayName}" updated successfully.`,
        };

    } else {
        throw new Error(`Unknown MS Contacts action: ${action}`);
    }
}

/**
 * Check if a tool name is an MS Contacts tool.
 */
function isMsContactsTool(toolName) {
    return ['ms_contacts_search', 'ms_contacts_list', 'ms_contacts_create', 'ms_contacts_update'].includes(toolName);
}

module.exports = {
    MS_CONTACTS_TOOLS,
    executeMsContactsTool,
    executeMsContactsAction,
    isMsContactsTool,
};
