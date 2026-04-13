/**
 * GitHub Sync Service — Core engine for syncing agent & skill configs to GitHub
 *
 * Serializes agent/skill state into structured JSON/MD files and commits them
 * to a configured GitHub repository via the GitHub Contents API.
 *
 * Repository structure:
 *   agents/<id>/agent.json          — metadata + config
 *   agents/<id>/system-prompt.md    — system prompt (human-readable)
 *   agents/<id>/starter-prompts.json
 *   agents/<id>/tools.json
 *   skills/<id>/skill.json          — metadata
 *   skills/<id>/instructions.md
 *   skills/<id>/rules.md
 *   skills/<id>/examples.md
 *   skills/<id>/workflow.md
 *   sync-manifest.json              — full index + timestamps
 */

const crypto = require('crypto');
const configStore = require('../stores/configStore');
const githubSyncStore = require('../stores/githubSyncStore');

const GITHUB_API = 'https://api.github.com';

// ── GitHub API helpers ───────────────────────────────────────────

/**
 * Get the GitHub PAT for a user.
 */
async function getToken(userId) {
    const token = await configStore.getSecret(`github_token_user_${userId}`);
    if (!token) throw new Error('GitHub not connected. Set your Personal Access Token in Settings → Integrations.');
    return token;
}

/**
 * Make an authenticated GitHub API request.
 */
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
        signal: AbortSignal.timeout(30000),
    });

    if (res.status === 401) {
        throw new Error('GitHub token expired or invalid. Update it in Settings → Integrations.');
    }
    // 404 is expected for new files (file doesn't exist yet)
    if (res.status === 404 && options._allow404) {
        return null;
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub API error (${res.status}): ${text}`);
    }
    return res.json();
}

/**
 * Get the SHA of an existing file on GitHub (needed for updates).
 * Returns null if file doesn't exist.
 */
async function getFileSha(token, owner, repo, path, branch) {
    try {
        let url = `/repos/${owner}/${repo}/contents/${path}`;
        if (branch) url += `?ref=${encodeURIComponent(branch)}`;
        const data = await ghFetch(token, url, { _allow404: true });
        return data?.sha || null;
    } catch {
        return null;
    }
}

/**
 * Create or update a file on GitHub.
 */
async function pushFile(token, owner, repo, filePath, content, message, branch = 'main') {
    const encoded = Buffer.from(content, 'utf-8').toString('base64');
    const existingSha = await getFileSha(token, owner, repo, filePath, branch);

    const body = {
        message,
        content: encoded,
        branch,
    };
    if (existingSha) body.sha = existingSha;

    const result = await ghFetch(token, `/repos/${owner}/${repo}/contents/${filePath}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    return result?.commit?.sha || null;
}

/**
 * Delete a file from GitHub.
 */
async function deleteFile(token, owner, repo, filePath, message, branch = 'main') {
    const existingSha = await getFileSha(token, owner, repo, filePath, branch);
    if (!existingSha) return null; // File doesn't exist, nothing to delete

    const result = await ghFetch(token, `/repos/${owner}/${repo}/contents/${filePath}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message,
            sha: existingSha,
            branch,
        }),
    });

    return result?.commit?.sha || null;
}

// ── Content hashing ──────────────────────────────────────────────

function contentHash(content) {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ── Agent Serialization ──────────────────────────────────────────

function serializeAgentMeta(agent) {
    return JSON.stringify({
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        model: agent.model || null,
        threadsEnabled: agent.threads_enabled !== false,
        copyEnabled: agent.copy_enabled !== false,
        workspaceEnabled: agent.workspace_enabled === true,
        embedEnabled: agent.embed_enabled === true,
        isPublished: agent.is_published === true,
        categoryId: agent.category_id || null,
        config: agent.config || {},
        updatedAt: agent.updated_at,
    }, null, 2);
}

function serializeTools(tools, toolParams) {
    return JSON.stringify({
        components: tools || [],
        params: toolParams || {},
    }, null, 2);
}

function serializeStarterPrompts(agent) {
    let prompts = agent.starter_prompts;
    if (typeof prompts === 'string') {
        try { prompts = JSON.parse(prompts); } catch { prompts = []; }
    }
    return JSON.stringify(prompts || [], null, 2);
}

// ── Skill Serialization ──────────────────────────────────────────

function serializeSkillMeta(skill) {
    return JSON.stringify({
        id: skill.id || skill.id,
        name: skill.name,
        description: skill.description || '',
        icon: skill.icon || '⚡',
        isShared: skill.isShared === true || skill.is_shared === true,
        updatedAt: skill.updatedAt || skill.updated_at,
    }, null, 2);
}

// ── Sync Operations ──────────────────────────────────────────────

/**
 * Sync a single agent to GitHub.
 * Returns { pushed: boolean, commitSha, filesUpdated }
 */
async function syncAgent(agent, tools, toolParams, token, owner, repo, branch, orgId) {
    const basePath = `agents/${agent.id}`;
    const files = {
        [`${basePath}/agent.json`]: serializeAgentMeta(agent),
        [`${basePath}/system-prompt.md`]: agent.system_prompt || '',
        [`${basePath}/starter-prompts.json`]: serializeStarterPrompts(agent),
        [`${basePath}/tools.json`]: serializeTools(tools, toolParams),
    };

    let lastCommitSha = null;
    let filesUpdated = 0;
    const combinedContent = Object.values(files).join('\n---\n');
    const newHash = contentHash(combinedContent);

    // Check if content has actually changed
    const existing = await githubSyncStore.getSyncState(orgId, 'agent', agent.id);
    if (existing && existing.last_synced_sha === newHash && existing.sync_status === 'synced') {
        return { pushed: false, commitSha: existing.github_commit_sha, filesUpdated: 0, skipped: true };
    }

    // Push each file
    for (const [filePath, content] of Object.entries(files)) {
        if (!content && content !== '') continue;
        try {
            const commitSha = await pushFile(
                token, owner, repo, filePath, content,
                `Sync agent "${agent.name}": ${filePath.split('/').pop()}`,
                branch
            );
            if (commitSha) lastCommitSha = commitSha;
            filesUpdated++;
        } catch (err) {
            console.error(`[GitHubSync] Failed to push ${filePath}:`, err.message);
            await githubSyncStore.markError(orgId, 'agent', agent.id, err.message);
            throw err;
        }
    }

    // Update sync state
    await githubSyncStore.markSynced(orgId, 'agent', agent.id, newHash, lastCommitSha);
    return { pushed: true, commitSha: lastCommitSha, filesUpdated };
}

/**
 * Sync a single skill to GitHub.
 */
async function syncSkill(skill, token, owner, repo, branch, orgId) {
    const basePath = `skills/${skill.id}`;
    const files = {
        [`${basePath}/skill.json`]: serializeSkillMeta(skill),
        [`${basePath}/instructions.md`]: skill.instructions || skill.instructions || '',
        [`${basePath}/rules.md`]: skill.rules || '',
        [`${basePath}/examples.md`]: skill.examples || '',
        [`${basePath}/workflow.md`]: skill.workflow || '',
    };

    let lastCommitSha = null;
    let filesUpdated = 0;
    const combinedContent = Object.values(files).join('\n---\n');
    const newHash = contentHash(combinedContent);

    const existing = await githubSyncStore.getSyncState(orgId, 'skill', skill.id);
    if (existing && existing.last_synced_sha === newHash && existing.sync_status === 'synced') {
        return { pushed: false, commitSha: existing.github_commit_sha, filesUpdated: 0, skipped: true };
    }

    for (const [filePath, content] of Object.entries(files)) {
        try {
            const commitSha = await pushFile(
                token, owner, repo, filePath, content,
                `Sync skill "${skill.name}": ${filePath.split('/').pop()}`,
                branch
            );
            if (commitSha) lastCommitSha = commitSha;
            filesUpdated++;
        } catch (err) {
            console.error(`[GitHubSync] Failed to push ${filePath}:`, err.message);
            await githubSyncStore.markError(orgId, 'skill', skill.id, err.message);
            throw err;
        }
    }

    await githubSyncStore.markSynced(orgId, 'skill', skill.id, newHash, lastCommitSha);
    return { pushed: true, commitSha: lastCommitSha, filesUpdated };
}

/**
 * Delete agent files from GitHub (when agent is deleted).
 */
async function deleteAgentFromGitHub(agentId, agentName, token, owner, repo, branch, orgId) {
    const basePath = `agents/${agentId}`;
    const filesToDelete = ['agent.json', 'system-prompt.md', 'starter-prompts.json', 'tools.json'];

    for (const fileName of filesToDelete) {
        try {
            await deleteFile(token, owner, repo, `${basePath}/${fileName}`,
                `Delete agent "${agentName || agentId}"`, branch);
        } catch (err) {
            // Non-fatal: file may not exist on GitHub
            console.warn(`[GitHubSync] Could not delete ${basePath}/${fileName}:`, err.message);
        }
    }

    await githubSyncStore.removeSyncState(orgId, 'agent', agentId);
}

/**
 * Full sync of all agents and skills for an organization.
 */
async function syncAll(orgId, userId) {
    const config = await githubSyncStore.getOrgSyncConfig(orgId);
    if (!config) throw new Error('GitHub sync not configured for this organization');

    const token = await getToken(userId);
    const { repoOwner, repoName, branch } = config;

    // Lazy-require to avoid circular dependencies
    const agentCrud = require('../stores/agent/agentCrud');
    const agentTools = require('../stores/agent/agentTools');
    const skillStore = require('../stores/skillStore');

    const results = { agents: { pushed: 0, skipped: 0, errors: 0 }, skills: { pushed: 0, skipped: 0, errors: 0 } };

    // Sync all agents
    const allAgents = await agentCrud.getAllAgents();
    const orgAgents = allAgents.filter(a => a.organization_id === orgId);

    for (const agent of orgAgents) {
        try {
            const tools = await agentTools.getAgentTools(agent.id);
            const toolsWithParams = await agentTools.getAgentToolsWithParams(agent.id);
            const toolParams = {};
            for (const t of toolsWithParams) {
                if (t.params) toolParams[t.componentId] = t.params;
            }

            const result = await syncAgent(agent, tools, toolParams, token, repoOwner, repoName, branch, orgId);
            if (result.skipped) results.agents.skipped++;
            else results.agents.pushed++;
        } catch (err) {
            console.error(`[GitHubSync] Agent ${agent.id} sync failed:`, err.message);
            results.agents.errors++;
        }
    }

    // Sync all skills
    // Get all org skills (use a direct query since getAvailableSkills requires userId)
    try {
        const { getAll: dbGetAll } = require('../db');
        const allSkills = await dbGetAll('SELECT * FROM skills WHERE org_id = $1', [orgId]);
        for (const skill of allSkills) {
            try {
                const result = await syncSkill(skill, token, repoOwner, repoName, branch, orgId);
                if (result.skipped) results.skills.skipped++;
                else results.skills.pushed++;
            } catch (err) {
                console.error(`[GitHubSync] Skill ${skill.id} sync failed:`, err.message);
                results.skills.errors++;
            }
        }
    } catch (err) {
        console.warn('[GitHubSync] Skills sync skipped:', err.message);
    }

    // Push sync manifest
    try {
        const manifest = {
            organization_id: orgId,
            synced_at: new Date().toISOString(),
            agents: orgAgents.map(a => ({ id: a.id, name: a.name })),
            summary: results,
        };
        await pushFile(token, repoOwner, repoName, 'sync-manifest.json',
            JSON.stringify(manifest, null, 2),
            `Sync manifest updated — ${results.agents.pushed} agents, ${results.skills.pushed} skills`,
            branch);
    } catch (err) {
        console.warn('[GitHubSync] Manifest push failed:', err.message);
    }

    // Update last full sync
    await githubSyncStore.updateLastFullSync(orgId);

    // Handle deletions
    const pendingDeletes = (await githubSyncStore.getPendingChanges(orgId))
        .filter(s => s.sync_status === 'deleted');

    for (const del of pendingDeletes) {
        try {
            if (del.resource_type === 'agent') {
                await deleteAgentFromGitHub(del.resource_id, null, token, repoOwner, repoName, branch, orgId);
            } else {
                // Skills — delete individual files
                const basePath = `skills/${del.resource_id}`;
                for (const f of ['skill.json', 'instructions.md', 'rules.md', 'examples.md', 'workflow.md']) {
                    try { await deleteFile(token, repoOwner, repoName, `${basePath}/${f}`, `Delete skill ${del.resource_id}`, branch); } catch { /* ok */ }
                }
                await githubSyncStore.removeSyncState(orgId, 'skill', del.resource_id);
            }
        } catch (err) {
            console.warn(`[GitHubSync] Delete failed for ${del.resource_type}/${del.resource_id}:`, err.message);
        }
    }

    console.log(`[GitHubSync] Full sync complete for org ${orgId}:`, results);
    return results;
}

/**
 * Push only pending changes (incremental sync).
 */
async function syncPending(orgId, userId) {
    const config = await githubSyncStore.getOrgSyncConfig(orgId);
    if (!config) throw new Error('GitHub sync not configured');

    const pending = await githubSyncStore.getPendingChanges(orgId);
    if (pending.length === 0) return { pushed: 0, message: 'Nothing to sync' };

    const token = await getToken(userId);
    const { repoOwner, repoName, branch } = config;

    const agentCrud = require('../stores/agent/agentCrud');
    const agentTools = require('../stores/agent/agentTools');

    let pushed = 0;
    let errors = 0;

    for (const item of pending) {
        try {
            if (item.sync_status === 'deleted') {
                if (item.resource_type === 'agent') {
                    await deleteAgentFromGitHub(item.resource_id, null, token, repoOwner, repoName, branch, orgId);
                } else {
                    const basePath = `skills/${item.resource_id}`;
                    for (const f of ['skill.json', 'instructions.md', 'rules.md', 'examples.md', 'workflow.md']) {
                        try { await deleteFile(token, repoOwner, repoName, `${basePath}/${f}`, `Delete skill`, branch); } catch { /* ok */ }
                    }
                    await githubSyncStore.removeSyncState(orgId, 'skill', item.resource_id);
                }
                pushed++;
                continue;
            }

            if (item.resource_type === 'agent') {
                const agent = await agentCrud.getAgent(item.resource_id);
                if (!agent) { await githubSyncStore.removeSyncState(orgId, 'agent', item.resource_id); continue; }

                const tools = await agentTools.getAgentTools(agent.id);
                const toolsWithParams = await agentTools.getAgentToolsWithParams(agent.id);
                const toolParams = {};
                for (const t of toolsWithParams) {
                    if (t.params) toolParams[t.componentId] = t.params;
                }

                await syncAgent(agent, tools, toolParams, token, repoOwner, repoName, branch, orgId);
                pushed++;
            } else if (item.resource_type === 'skill') {
                const { getAll: dbGetAll } = require('../db');
                const rows = await dbGetAll('SELECT * FROM skills WHERE id = $1', [item.resource_id]);
                if (rows.length === 0) { await githubSyncStore.removeSyncState(orgId, 'skill', item.resource_id); continue; }
                await syncSkill(rows[0], token, repoOwner, repoName, branch, orgId);
                pushed++;
            }
        } catch (err) {
            console.error(`[GitHubSync] Pending sync failed for ${item.resource_type}/${item.resource_id}:`, err.message);
            errors++;
        }
    }

    return { pushed, errors, total: pending.length };
}

module.exports = {
    syncAll,
    syncPending,
    syncAgent,
    syncSkill,
    deleteAgentFromGitHub,
    getToken,
};
