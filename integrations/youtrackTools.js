/**
 * YouTrack Tools — Built-in tools for AI to search, read, create, and comment on issues
 * 
 * These tools are injected into the LLM tool set when a YouTrack URL + token are configured,
 * allowing the AI to interact with YouTrack issue tracking.
 * Uses raw REST API — no npm dependencies.
 */

const configStore = require('../stores/configStore');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const YOUTRACK_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'youtrack_search_issues',
            description: 'Search YouTrack issues using YouTrack query syntax. IMPORTANT: Always call youtrack_list_projects first to discover available project short names before searching. Common query patterns: "project: {shortName}" to list issues in a project, "project: {shortName} state: Open" for open issues, "project: {shortName} sort by: updated desc" for recent activity, "#Unresolved" for all unresolved issues. You can combine filters like "project: {shortName} assignee: {name} state: Open".',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'YouTrack search query. Use project short names from youtrack_list_projects. Examples: "project: ABC", "project: ABC state: Open", "#Unresolved sort by: updated desc"'
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of results (1-50, default 10)'
                    },
                    skip: {
                        type: 'integer',
                        description: 'Pagination offset (default 0)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_get_issue',
            description: 'Get full details of a specific YouTrack issue by its readable ID. Returns summary, description, state, assignee, reporter, comments, tags, and custom fields. Use issue IDs obtained from youtrack_search_issues results.',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable issue ID from search results (format: SHORTNAME-NUMBER)'
                    }
                },
                required: ['issueId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_create_issue',
            description: 'Create a new issue in YouTrack. IMPORTANT: First call youtrack_list_projects to get the project database ID (the "id" field, not the shortName). Pass that ID as projectId.',
            parameters: {
                type: 'object',
                properties: {
                    projectId: {
                        type: 'string',
                        description: 'The project database ID from youtrack_list_projects results (the "id" field)'
                    },
                    summary: {
                        type: 'string',
                        description: 'Short title of the issue'
                    },
                    description: {
                        type: 'string',
                        description: 'Detailed description of the issue (Markdown supported)'
                    }
                },
                required: ['projectId', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_add_comment',
            description: 'Add a comment to an existing YouTrack issue. Use issue IDs obtained from youtrack_search_issues results.',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable issue ID from search results (format: SHORTNAME-NUMBER)'
                    },
                    text: {
                        type: 'string',
                        description: 'Comment text (Markdown supported)'
                    }
                },
                required: ['issueId', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_update_issue',
            description: 'Update a YouTrack issue by executing a command. Use this to change state, priority, assignee, type, or other fields. IMPORTANT: State names are project-specific — do NOT guess uncommon state names. Common state values that usually work: "Open", "In Progress", "Fixed", "Closed", "Verified". Common priority values: "Show-stopper", "Critical", "Major", "Normal", "Minor". If a command fails, try a simpler state name. You can combine commands: "state Fixed priority Normal".',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable issue ID (format: SHORTNAME-NUMBER)'
                    },
                    command: {
                        type: 'string',
                        description: 'YouTrack command. Use simple state names: "state Open", "state In Progress", "state Fixed", "state Closed". For priority: "priority Critical". For assignee: "assignee John". Combine: "state Fixed priority Normal".'
                    },
                    comment: {
                        type: 'string',
                        description: 'Optional comment to add along with the command'
                    }
                },
                required: ['issueId', 'command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_list_projects',
            description: 'List all available YouTrack projects with their database IDs, short names, and full names. ALWAYS call this first before using any other YouTrack tool — you need project short names for searching and project IDs for creating issues.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    }
];

// ─── API Client ────────────────────────────────────────────────

async function youtrackRequest(baseUrl, token, method, path, body = null) {
    const url = `${baseUrl.replace(/\/+$/, '')}/api${path}`;

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`YouTrack API error (${response.status}): ${text}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }
    return null;
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeYouTrackTool(toolName, args, userId) {
    if (!userId) return { error: 'User context required for YouTrack.' };
    const baseUrl = await configStore.getSecret(`youtrack_url_user_${userId}`);
    const token = await configStore.getSecret(`youtrack_token_user_${userId}`);

    if (!baseUrl || !token) {
        return { error: 'YouTrack not configured. Add your YouTrack URL and token in Settings.' };
    }

    if (toolName === 'youtrack_search_issues') {
        const limit = Math.min(Math.max(parseInt(args.limit) || 10, 1), 50);
        const skip = parseInt(args.skip) || 0;
        const query = args.query || '';

        const params = new URLSearchParams({
            query,
            fields: 'idReadable,summary,description,created,updated,resolved,reporter(login,fullName),customFields(name,value(name))',
            $top: String(limit),
            $skip: String(skip),
        });

        console.log(`[YouTrack] Searching issues: "${query}"`);
        const issues = await youtrackRequest(baseUrl, token, 'GET', `/issues?${params}`);

        if (!issues || issues.length === 0) {
            return { results: [], count: 0, message: 'No issues found matching your query.' };
        }

        return {
            results: issues.map(i => {
                // Extract state and assignee from custom fields
                const state = i.customFields?.find(f => f.name === 'State')?.value?.name || null;
                const assignee = i.customFields?.find(f => f.name === 'Assignee')?.value?.name || null;
                const priority = i.customFields?.find(f => f.name === 'Priority')?.value?.name || null;

                return {
                    id: i.idReadable,
                    summary: i.summary,
                    state,
                    assignee,
                    priority,
                    reporter: i.reporter?.fullName || i.reporter?.login || null,
                    created: i.created ? new Date(i.created).toISOString() : null,
                    updated: i.updated ? new Date(i.updated).toISOString() : null,
                };
            }),
            count: issues.length,
            message: `Found ${issues.length} issue(s).`,
        };

    } else if (toolName === 'youtrack_get_issue') {
        const { issueId } = args;
        if (!issueId) return { error: 'issueId is required' };

        const params = new URLSearchParams({
            fields: 'idReadable,summary,description,created,updated,resolved,reporter(login,fullName),comments(id,text,author(login,fullName),created),tags(name),customFields(name,value(name))',
        });

        console.log(`[YouTrack] Getting issue: ${issueId}`);
        const issue = await youtrackRequest(baseUrl, token, 'GET', `/issues/${issueId}?${params}`);

        if (!issue) return { error: `Issue not found: ${issueId}` };

        const state = issue.customFields?.find(f => f.name === 'State')?.value?.name || null;
        const assignee = issue.customFields?.find(f => f.name === 'Assignee')?.value?.name || null;
        const priority = issue.customFields?.find(f => f.name === 'Priority')?.value?.name || null;
        const type = issue.customFields?.find(f => f.name === 'Type')?.value?.name || null;

        return {
            id: issue.idReadable,
            summary: issue.summary,
            description: issue.description || '',
            state,
            assignee,
            priority,
            type,
            reporter: issue.reporter?.fullName || issue.reporter?.login || null,
            created: issue.created ? new Date(issue.created).toISOString() : null,
            updated: issue.updated ? new Date(issue.updated).toISOString() : null,
            tags: (issue.tags || []).map(t => t.name),
            comments: (issue.comments || []).map(c => ({
                author: c.author?.fullName || c.author?.login || 'Unknown',
                text: c.text,
                created: c.created ? new Date(c.created).toISOString() : null,
            })),
        };

    } else if (toolName === 'youtrack_create_issue') {
        const { projectId, summary, description } = args;
        if (!projectId) return { error: 'projectId is required' };
        if (!summary) return { error: 'summary is required' };

        console.log(`[YouTrack] Creating issue in ${projectId}: "${summary}"`);

        const params = new URLSearchParams({
            fields: 'idReadable,summary',
        });

        const issue = await youtrackRequest(baseUrl, token, 'POST', `/issues?${params}`, {
            summary,
            description: description || '',
            project: { id: projectId },
        });

        // If project was provided as shortName, try alternative format
        if (!issue) {
            return { error: 'Failed to create issue. Make sure the project ID is correct (use youtrack_list_projects).' };
        }

        return {
            id: issue.idReadable || issue.id,
            summary: issue.summary,
            message: `Issue created: ${issue.idReadable || issue.id} — "${issue.summary}"`,
        };

    } else if (toolName === 'youtrack_add_comment') {
        const { issueId, text } = args;
        if (!issueId) return { error: 'issueId is required' };
        if (!text) return { error: 'text is required' };

        console.log(`[YouTrack] Adding comment to ${issueId}`);
        await youtrackRequest(baseUrl, token, 'POST', `/issues/${issueId}/comments`, { text });

        return { message: `Comment added to ${issueId}.` };

    } else if (toolName === 'youtrack_list_projects') {
        const params = new URLSearchParams({
            fields: 'id,name,shortName,description',
            $top: '50',
        });

        console.log('[YouTrack] Listing projects');
        const projects = await youtrackRequest(baseUrl, token, 'GET', `/admin/projects?${params}`);

        if (!projects || projects.length === 0) {
            return { results: [], count: 0, message: 'No projects found.' };
        }

        return {
            results: projects.map(p => ({
                id: p.id,
                shortName: p.shortName,
                name: p.name,
                description: p.description || '',
            })),
            count: projects.length,
            message: `Found ${projects.length} project(s).`,
        };

    } else if (toolName === 'youtrack_update_issue') {
        const { issueId, command, comment } = args;
        if (!issueId) return { error: 'issueId is required' };
        if (!command) return { error: 'command is required' };

        console.log(`[YouTrack] Executing command on ${issueId}: "${command}"`);

        const body = {
            query: command,
            issues: [{ idReadable: issueId }],
        };
        if (comment) body.comment = comment;

        await youtrackRequest(baseUrl, token, 'POST', '/commands', body);

        return { message: `Command "${command}" executed on ${issueId}.` };

    } else {
        return { error: `Unknown YouTrack tool: ${toolName}` };
    }
}

function isYouTrackTool(toolName) {
    return [
        'youtrack_search_issues',
        'youtrack_get_issue',
        'youtrack_create_issue',
        'youtrack_add_comment',
        'youtrack_update_issue',
        'youtrack_list_projects',
    ].includes(toolName);
}

module.exports = {
    YOUTRACK_TOOLS,
    executeYouTrackTool,
    isYouTrackTool,
};
