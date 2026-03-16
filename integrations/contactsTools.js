/**
 * Google Contacts Tools — AI tools for managing Google Contacts
 * 
 * Uses Google People API with the existing Google OAuth session.
 * Read operations execute directly; create/update require user approval.
 */

const { google } = require('googleapis');
const { loadConfig } = require('../auth/permissions');

const CONTACTS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'contacts_search',
            description: 'Search the user\'s Google Contacts by name, email, or phone number. Returns matching contacts with their details.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query — name, email address, phone number, or company name'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of results (1-30, default 10)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'contacts_list',
            description: 'List the user\'s Google Contacts. Returns contacts sorted by name with their details.',
            parameters: {
                type: 'object',
                properties: {
                    maxResults: {
                        type: 'integer',
                        description: 'Number of contacts to return (1-50, default 20)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'contacts_create',
            description: 'Create a new Google Contact. The user will see a preview and must approve before the contact is created.',
            parameters: {
                type: 'object',
                properties: {
                    firstName: { type: 'string', description: 'First name' },
                    lastName: { type: 'string', description: 'Last name' },
                    email: { type: 'string', description: 'Email address' },
                    phone: { type: 'string', description: 'Phone number' },
                    company: { type: 'string', description: 'Company/organization name' },
                    jobTitle: { type: 'string', description: 'Job title' },
                    notes: { type: 'string', description: 'Notes about the contact' }
                },
                required: ['firstName']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'contacts_update',
            description: 'Update an existing Google Contact. The user will see a preview and must approve. Use contacts_search or contacts_list first to get the contact resourceName. Only provide fields you want to change.',
            parameters: {
                type: 'object',
                properties: {
                    resourceName: { type: 'string', description: 'Contact resource name from search/list results (e.g. "people/c1234567890")' },
                    firstName: { type: 'string', description: 'New first name' },
                    lastName: { type: 'string', description: 'New last name' },
                    email: { type: 'string', description: 'New or updated email address' },
                    phone: { type: 'string', description: 'New or updated phone number' },
                    company: { type: 'string', description: 'New company name' },
                    jobTitle: { type: 'string', description: 'New job title' },
                    notes: { type: 'string', description: 'Updated notes' }
                },
                required: ['resourceName']
            }
        }
    }
];

// ─── People API Client ─────────────────────────────────────────

async function createPeopleClient(session) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured');
    }

    const accessToken = session?.accessToken;
    if (!accessToken) {
        throw new Error('Not connected to Google — user must log in with Google');
    }

    const oauth2Client = new google.auth.OAuth2(
        providerConfig.clientId,
        providerConfig.clientSecret
    );

    oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: session?.refreshToken
    });

    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) session.accessToken = tokens.access_token;
        if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
        session.save?.();
    });

    return google.people({ version: 'v1', auth: oauth2Client });
}

// ─── Format Contact ────────────────────────────────────────────

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,biographies,metadata';

function formatContact(person) {
    const name = person.names?.[0] || {};
    const email = person.emailAddresses?.[0]?.value || null;
    const phone = person.phoneNumbers?.[0]?.value || null;
    const org = person.organizations?.[0] || {};
    const notes = person.biographies?.[0]?.value || null;

    return {
        resourceName: person.resourceName,
        firstName: name.givenName || '',
        lastName: name.familyName || '',
        displayName: name.displayName || `${name.givenName || ''} ${name.familyName || ''}`.trim(),
        email,
        phone,
        company: org.name || null,
        jobTitle: org.title || null,
        notes,
    };
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeContactsTool(toolName, args, session) {
    const people = await createPeopleClient(session);

    switch (toolName) {
        case 'contacts_search': {
            const { query, maxResults = 10 } = args;
            if (!query) return { error: 'query is required' };

            const limit = Math.min(Math.max(maxResults, 1), 30);
            console.log(`[Contacts] Searching: "${query}"`);

            const response = await people.people.searchContacts({
                query,
                readMask: PERSON_FIELDS,
                pageSize: limit,
            });

            const contacts = (response.data.results || [])
                .map(r => r.person)
                .filter(Boolean)
                .map(formatContact);

            return {
                results: contacts,
                count: contacts.length,
                query,
                message: contacts.length > 0
                    ? `Found ${contacts.length} contact(s) matching "${query}".`
                    : `No contacts found matching "${query}".`,
            };
        }

        case 'contacts_list': {
            const { maxResults = 20 } = args;
            const limit = Math.min(Math.max(maxResults, 1), 50);
            console.log(`[Contacts] Listing ${limit} contacts`);

            const response = await people.people.connections.list({
                resourceName: 'people/me',
                personFields: PERSON_FIELDS,
                pageSize: limit,
                sortOrder: 'FIRST_NAME_ASCENDING',
            });

            const contacts = (response.data.connections || []).map(formatContact);

            return {
                results: contacts,
                count: contacts.length,
                totalPeople: response.data.totalPeople || contacts.length,
                message: contacts.length > 0
                    ? `Showing ${contacts.length} contact(s) (${response.data.totalPeople || contacts.length} total).`
                    : 'No contacts found.',
            };
        }

        case 'contacts_create': {
            const { firstName, lastName, email, phone, company, jobTitle, notes } = args;
            if (!firstName) return { error: 'firstName is required' };

            const displayName = `${firstName}${lastName ? ' ' + lastName : ''}`;

            return {
                _action: 'contacts_draft',
                draft: {
                    action: 'create',
                    firstName,
                    lastName: lastName || null,
                    email: email || null,
                    phone: phone || null,
                    company: company || null,
                    jobTitle: jobTitle || null,
                    notes: notes || null,
                },
                message: `Contact prepared: "${displayName}"${email ? ` (${email})` : ''}. Waiting for user approval.`,
            };
        }

        case 'contacts_update': {
            const { resourceName, firstName, lastName, email, phone, company, jobTitle, notes } = args;
            if (!resourceName) return { error: 'resourceName is required' };

            return {
                _action: 'contacts_draft',
                draft: {
                    action: 'update',
                    resourceName,
                    firstName: firstName || null,
                    lastName: lastName || null,
                    email: email || null,
                    phone: phone || null,
                    company: company || null,
                    jobTitle: jobTitle || null,
                    notes: notes !== undefined ? notes : null,
                },
                message: `Contact update prepared. Waiting for user approval.`,
            };
        }

        default:
            throw new Error(`Unknown Contacts tool: ${toolName}`);
    }
}

// ─── Execute Action (after user approval) ──────────────────────

async function executeContactsAction(action, session) {
    const people = await createPeopleClient(session);

    if (action.action === 'create') {
        const body = { names: [{ givenName: action.firstName, familyName: action.lastName || '' }] };

        if (action.email) body.emailAddresses = [{ value: action.email }];
        if (action.phone) body.phoneNumbers = [{ value: action.phone }];
        if (action.company || action.jobTitle) {
            body.organizations = [{ name: action.company || '', title: action.jobTitle || '' }];
        }
        if (action.notes) body.biographies = [{ value: action.notes, contentType: 'TEXT_PLAIN' }];

        console.log(`[Contacts] Creating: "${action.firstName} ${action.lastName || ''}"`);
        const response = await people.people.createContact({ requestBody: body });

        return {
            success: true,
            resourceName: response.data.resourceName,
            message: `Contact "${action.firstName}${action.lastName ? ' ' + action.lastName : ''}" created!`,
        };
    }

    if (action.action === 'update') {
        // Fetch current contact to get etag
        const current = await people.people.get({
            resourceName: action.resourceName,
            personFields: PERSON_FIELDS,
        });

        const body = current.data;
        const updateMask = [];

        if (action.firstName || action.lastName) {
            body.names = body.names || [{}];
            if (action.firstName) body.names[0].givenName = action.firstName;
            if (action.lastName) body.names[0].familyName = action.lastName;
            updateMask.push('names');
        }
        if (action.email) {
            body.emailAddresses = [{ value: action.email }];
            updateMask.push('emailAddresses');
        }
        if (action.phone) {
            body.phoneNumbers = [{ value: action.phone }];
            updateMask.push('phoneNumbers');
        }
        if (action.company || action.jobTitle) {
            body.organizations = body.organizations || [{}];
            if (action.company) body.organizations[0].name = action.company;
            if (action.jobTitle) body.organizations[0].title = action.jobTitle;
            updateMask.push('organizations');
        }
        if (action.notes !== null && action.notes !== undefined) {
            body.biographies = [{ value: action.notes, contentType: 'TEXT_PLAIN' }];
            updateMask.push('biographies');
        }

        if (updateMask.length === 0) {
            return { error: 'No fields to update' };
        }

        console.log(`[Contacts] Updating: ${action.resourceName}`);
        const response = await people.people.updateContact({
            resourceName: action.resourceName,
            updatePersonFields: updateMask.join(','),
            requestBody: body,
        });

        return {
            success: true,
            resourceName: response.data.resourceName,
            message: 'Contact updated!',
        };
    }

    throw new Error(`Unknown contacts action: ${action.action}`);
}

function isContactsTool(toolName) {
    return toolName.startsWith('contacts_');
}

module.exports = {
    CONTACTS_TOOLS,
    executeContactsTool,
    executeContactsAction,
    isContactsTool,
};
