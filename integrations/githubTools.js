/**
 * GitHub Tools — AI tools for repository management
 * 
 * PAT-based (users set their token in Settings → Integrations).
 * Supports: list repos, get repo details, create repo, list branches,
 * get file content, list directory contents.
 */

const configStore = require('../stores/configStore');

const GITHUB_API = 'https://api.github.com';

const GITHUB_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'github_list_repos',
            description: 'List the user\'s GitHub repositories. Returns name, description, language, stars, updated date, and visibility for each repo.',
            parameters: {
                type: 'object',
                properties: {
                    search: {
                        type: 'string',
                        description: 'Optional search query to filter repos by name'
                    },
                    sort: {
                        type: 'string',
                        enum: ['updated', 'created', 'pushed', 'full_name'],
                        description: 'Sort field (default: updated)'
                    },
                    per_page: {
                        type: 'integer',
                        description: 'Number of repos to return (default: 10, max: 30)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'github_get_repo',
            description: 'Get details about a specific GitHub repository including description, language, stars, forks, default branch, and recent activity.',
            parameters: {
                type: 'object',
                properties: {
                    owner: { type: 'string', description: 'Repository owner (username or org)' },
                    repo: { type: 'string', description: 'Repository name' }
                },
                required: ['owner', 'repo']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'github_create_repo',
            description: 'Create a new GitHub repository for the authenticated user.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Repository name (e.g. "my-project")' },
                    description: { type: 'string', description: 'Short description of the repository' },
                    private: { type: 'boolean', description: 'Whether the repo should be private (default: false)' },
                    auto_init: { type: 'boolean', description: 'Initialize with a README (default: true)' }
                },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'github_list_branches',
            description: 'List branches in a GitHub repository.',
            parameters: {
                type: 'object',
                properties: {
                    owner: { type: 'string', description: 'Repository owner' },
                    repo: { type: 'string', description: 'Repository name' }
                },
                required: ['owner', 'repo']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'github_get_file',
            description: 'Read the content of a file from a GitHub repository. Returns the decoded text content.',
            parameters: {
                type: 'object',
                properties: {
                    owner: { type: 'string', description: 'Repository owner' },
                    repo: { type: 'string', description: 'Repository name' },
                    path: { type: 'string', description: 'File path (e.g. "src/index.js" or "README.md")' },
                    branch: { type: 'string', description: 'Branch name (default: repo default branch)' }
                },
                required: ['owner', 'repo', 'path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'github_list_contents',
            description: 'List files and folders in a directory of a GitHub repository.',
            parameters: {
                type: 'object',
                properties: {
                    owner: { type: 'string', description: 'Repository owner' },
                    repo: { type: 'string', description: 'Repository name' },
                    path: { type: 'string', description: 'Directory path (empty or "/" for root)' },
                    branch: { type: 'string', description: 'Branch name (default: repo default branch)' }
                },
                required: ['owner', 'repo']
            }
        }
    }
];

// ─── Helpers ────────────────────────────────────────────────────

async function getToken(userId) {
    const token = await configStore.getSecret(`github_token_user_${userId}`);
    if (!token) throw new Error('GitHub not connected. Set your Personal Access Token in Settings → Integrations.');
    return token;
}

async function ghFetch(token, endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API}${endpoint}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401) {
        throw new Error('GitHub token expired or invalid. Update it in Settings → Integrations.');
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub API error (${res.status}): ${text}`);
    }
    return res.json();
}

// ─── Tool Execution ─────────────────────────────────────────────

async function executeGitHubTool(toolName, args, userId) {
    const token = await getToken(userId);

    switch (toolName) {
        case 'github_list_repos': {
            const { search, sort = 'updated', per_page = 10 } = args;
            const limit = Math.min(Math.max(per_page || 10, 1), 30);

            let repos;
            if (search) {
                // Use search API for filtering
                const data = await ghFetch(token, `/search/repositories?q=${encodeURIComponent(search)}+user:@me&sort=${sort}&per_page=${limit}`);
                repos = data.items || [];
            } else {
                repos = await ghFetch(token, `/user/repos?sort=${sort}&per_page=${limit}&affiliation=owner,collaborator,organization_member`);
            }

            return repos.map(r => ({
                name: r.full_name,
                description: r.description || '',
                language: r.language || 'Unknown',
                stars: r.stargazers_count,
                visibility: r.private ? 'private' : 'public',
                updated: r.updated_at,
                default_branch: r.default_branch,
                url: r.html_url,
            }));
        }

        case 'github_get_repo': {
            const { owner, repo } = args;
            if (!owner || !repo) return { error: 'owner and repo are required' };

            const r = await ghFetch(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
            return {
                name: r.full_name,
                description: r.description || '',
                language: r.language,
                stars: r.stargazers_count,
                forks: r.forks_count,
                open_issues: r.open_issues_count,
                visibility: r.private ? 'private' : 'public',
                default_branch: r.default_branch,
                created: r.created_at,
                updated: r.updated_at,
                topics: r.topics || [],
                url: r.html_url,
                clone_url: r.clone_url,
            };
        }

        case 'github_create_repo': {
            const { name, description = '', private: isPrivate = false, auto_init = true } = args;
            if (!name) return { error: 'name is required' };

            const r = await ghFetch(token, '/user/repos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    description,
                    private: isPrivate,
                    auto_init,
                }),
            });

            return {
                success: true,
                name: r.full_name,
                url: r.html_url,
                clone_url: r.clone_url,
                visibility: r.private ? 'private' : 'public',
                message: `Repository ${r.full_name} created successfully!`,
            };
        }

        case 'github_list_branches': {
            const { owner, repo } = args;
            if (!owner || !repo) return { error: 'owner and repo are required' };

            const branches = await ghFetch(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=30`);
            return branches.map(b => ({
                name: b.name,
                protected: b.protected,
                sha: b.commit?.sha?.substring(0, 7),
            }));
        }

        case 'github_get_file': {
            const { owner, repo, path, branch } = args;
            if (!owner || !repo || !path) return { error: 'owner, repo, and path are required' };

            let url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}`;
            if (branch) url += `?ref=${encodeURIComponent(branch)}`;

            const data = await ghFetch(token, url);

            if (data.type !== 'file') {
                return { error: `${path} is a ${data.type}, not a file. Use github_list_contents to browse directories.` };
            }

            // Decode base64 content
            const content = data.encoding === 'base64'
                ? Buffer.from(data.content, 'base64').toString('utf-8')
                : data.content;

            // Truncate very large files
            const MAX_CHARS = 15000;
            const truncated = content.length > MAX_CHARS;

            return {
                path: data.path,
                size: data.size,
                sha: data.sha?.substring(0, 7),
                content: truncated ? content.substring(0, MAX_CHARS) + '\n\n... [truncated — file too large]' : content,
                truncated,
                url: data.html_url,
            };
        }

        case 'github_list_contents': {
            const { owner, repo, path = '', branch } = args;
            if (!owner || !repo) return { error: 'owner and repo are required' };

            let url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path || '')}`;
            if (branch) url += `?ref=${encodeURIComponent(branch)}`;

            const items = await ghFetch(token, url);

            if (!Array.isArray(items)) {
                return { error: 'Path is a file, not a directory. Use github_get_file to read it.' };
            }

            return items.map(item => ({
                name: item.name,
                type: item.type, // 'file' or 'dir'
                size: item.type === 'file' ? item.size : undefined,
                path: item.path,
            }));
        }

        default:
            return { error: `Unknown GitHub tool: ${toolName}` };
    }
}

function isGitHubTool(toolName) {
    return toolName.startsWith('github_');
}

module.exports = {
    GITHUB_TOOLS,
    executeGitHubTool,
    isGitHubTool,
};
