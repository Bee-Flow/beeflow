/**
 * Test Generator Service — produces Playwright test code from mixed sources.
 *
 * Sources supported (any combination, all optional):
 *   • conversation  — { type: 'conversation', conversationId }
 *   • github_file   — { type: 'github_file', owner, repo, path, ref? }
 *   • github_commit — { type: 'github_commit', owner, repo, sha? }
 *   • youtrack      — { type: 'youtrack', issueId } OR { type: 'youtrack_query', query }
 *   • text          — { type: 'text', label, body }
 *   • url           — { type: 'url', url }  (treated as a target hint, not fetched)
 *
 * Returns either:
 *   { ok: true, playwrightCode, manifest, modelUsed }
 *   { ok: false, error: 'missing_integration', integration: 'github'|'youtrack', message }
 *   { ok: false, error: 'no_sources' | 'llm_error' | 'parse_error', message }
 *
 * The service does NOT touch the DB — callers (routes) decide whether to persist
 * the result back into a suite. That keeps this module easy to unit-test with
 * mocked tool dispatchers.
 */

const fs = require('fs');
const path = require('path');

const TEST_GENERATOR_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'test-generator-prompt.md');
const DEFAULT_MAX_TOKENS = 8000;

function _loadPrompt() {
    try {
        return fs.readFileSync(TEST_GENERATOR_PROMPT_PATH, 'utf-8');
    } catch (e) {
        console.error('[TestGenerator] failed to load prompt:', e.message);
        return '';
    }
}

async function _fetchConversationSource({ conversationId }, userId) {
    if (!conversationId) return null;
    const agentConvs = require('../stores/agent/agentConversations');
    let conv;
    try {
        conv = await agentConvs.getConversationById(conversationId);
    } catch (e) {
        return { error: 'fetch_failed', detail: e.message };
    }
    if (!conv) return { error: 'not_found' };
    if (conv.user_id && conv.user_id !== userId) return { error: 'forbidden' };
    const msgs = Array.isArray(conv.messages) ? conv.messages : [];
    const transcript = msgs
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n\n')
        .slice(0, 12000);
    return {
        kind: 'conversation',
        title: conv.title || `Conversation ${conversationId}`,
        body: transcript,
    };
}

async function _fetchGithubFileSource({ owner, repo, filePath, ref }, userId) {
    const { executeGitHubTool } = require('../integrations/githubTools');
    const r = await executeGitHubTool('github_get_file', { owner, repo, path: filePath, ref }, userId);
    if (r?.error) {
        if (/no github token|not configured/i.test(r.error)) {
            return { error: 'missing_integration', integration: 'github', message: r.error };
        }
        return { error: 'fetch_failed', detail: r.error };
    }
    return {
        kind: 'github_file',
        title: `${owner}/${repo}:${filePath}${ref ? '@' + ref : ''}`,
        body: typeof r?.content === 'string' ? r.content.slice(0, 8000) : JSON.stringify(r).slice(0, 8000),
    };
}

async function _fetchGithubCommitSource({ owner, repo, sha }, userId) {
    const { executeGitHubTool } = require('../integrations/githubTools');
    const r = await executeGitHubTool('github_get_commits', { owner, repo, sha }, userId);
    if (r?.error) {
        if (/no github token|not configured/i.test(r.error)) {
            return { error: 'missing_integration', integration: 'github', message: r.error };
        }
        return { error: 'fetch_failed', detail: r.error };
    }
    return {
        kind: 'github_commits',
        title: `${owner}/${repo} commits${sha ? ' since ' + sha : ''}`,
        body: JSON.stringify(r).slice(0, 8000),
    };
}

async function _fetchYouTrackSource(src, userId) {
    const { executeYouTrackTool } = require('../integrations/youtrackTools');
    if (src.issueId) {
        const r = await executeYouTrackTool('youtrack_get_issue', { issueId: src.issueId }, userId);
        if (r?.error) {
            if (/not configured/i.test(r.error)) return { error: 'missing_integration', integration: 'youtrack', message: r.error };
            return { error: 'fetch_failed', detail: r.error };
        }
        return { kind: 'youtrack_issue', title: src.issueId, body: JSON.stringify(r).slice(0, 8000) };
    }
    if (src.query) {
        const r = await executeYouTrackTool('youtrack_search_issues', { query: src.query, top: 10 }, userId);
        if (r?.error) {
            if (/not configured/i.test(r.error)) return { error: 'missing_integration', integration: 'youtrack', message: r.error };
            return { error: 'fetch_failed', detail: r.error };
        }
        return { kind: 'youtrack_search', title: `query: ${src.query}`, body: JSON.stringify(r).slice(0, 8000) };
    }
    return { error: 'invalid_source', detail: 'youtrack source requires issueId or query' };
}

async function fetchSources(sources, userId) {
    const collected = [];
    const errors = [];
    for (const src of sources || []) {
        if (!src || !src.type) continue;
        try {
            let resolved = null;
            switch (src.type) {
                case 'conversation':
                    resolved = await _fetchConversationSource(src, userId);
                    break;
                case 'github_file':
                    resolved = await _fetchGithubFileSource({
                        owner: src.owner, repo: src.repo, filePath: src.path, ref: src.ref,
                    }, userId);
                    break;
                case 'github_commit':
                    resolved = await _fetchGithubCommitSource({
                        owner: src.owner, repo: src.repo, sha: src.sha,
                    }, userId);
                    break;
                case 'youtrack':
                    resolved = await _fetchYouTrackSource({ issueId: src.issueId }, userId);
                    break;
                case 'youtrack_query':
                    resolved = await _fetchYouTrackSource({ query: src.query }, userId);
                    break;
                case 'text':
                    resolved = { kind: 'text', title: src.label || 'Free text', body: String(src.body || '').slice(0, 8000) };
                    break;
                case 'url':
                    resolved = { kind: 'target_url', title: 'Target URL', body: String(src.url || '') };
                    break;
                default:
                    errors.push({ src, error: 'unknown_type' });
            }
            if (resolved?.error) errors.push({ src, ...resolved });
            else if (resolved) collected.push(resolved);
        } catch (e) {
            errors.push({ src, error: 'unexpected', detail: e.message });
        }
    }
    return { collected, errors };
}

function _buildUserMessage(collected, hints = {}) {
    const blocks = collected.map((s, i) => {
        return `── Source ${i + 1} (${s.kind}) — ${s.title} ──\n${s.body || ''}\n`;
    });
    const targetLine = hints.targetUrl ? `\nTarget URL (default base for tests): ${hints.targetUrl}\n` : '';
    return `Generate a Playwright test suite based on the following sources.${targetLine}\n\n${blocks.join('\n')}\n\nReturn exactly one fenced \`\`\`typescript code block containing the test file, followed by exactly one fenced \`\`\`json code block containing the coverage manifest. No prose.`;
}

function _extractCode(text) {
    if (typeof text !== 'string') return null;
    const m = text.match(/```(?:typescript|ts|javascript|js)\s*\n([\s\S]*?)```/i);
    return m ? m[1].trim() : null;
}

function _extractManifest(text) {
    if (typeof text !== 'string') return [];
    const m = text.match(/```json\s*\n([\s\S]*?)```/i);
    if (!m) return [];
    try {
        const parsed = JSON.parse(m[1]);
        return Array.isArray(parsed) ? parsed : (parsed.items || parsed.coverage || []);
    } catch (_) {
        return [];
    }
}

async function _callLLM(systemPrompt, userMessage, { signal } = {}) {
    const { getAIConfig } = require('../core/aiAgent');
    const cfg = await getAIConfig();
    if (!cfg?.url || !cfg?.apiKey) {
        return { ok: false, error: 'llm_not_configured', message: 'No default AI provider configured' };
    }
    let apiUrl = (cfg.url || '').replace(/\/+$/, '');
    if (!apiUrl.endsWith('/v1')) apiUrl = `${apiUrl}/v1`;
    let response;
    try {
        response = await fetch(`${apiUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({
                model: cfg.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage },
                ],
                temperature: 0.2,
                max_tokens: DEFAULT_MAX_TOKENS,
            }),
            signal,
        });
    } catch (e) {
        return { ok: false, error: 'llm_error', message: e.message };
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { ok: false, error: 'llm_error', message: `${response.status}: ${text.slice(0, 200)}` };
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    return { ok: true, content, modelUsed: cfg.model };
}

/**
 * Generate a Playwright test from a mixed source list.
 *
 * @param {string} userId
 * @param {Array<object>} sources
 * @param {object} [hints]
 * @returns {Promise<object>}
 */
async function generate(userId, sources, hints = {}) {
    if (!userId) throw new Error('userId required');
    if (!Array.isArray(sources) || sources.length === 0) {
        return { ok: false, error: 'no_sources', message: 'At least one source is required' };
    }

    const { collected, errors } = await fetchSources(sources, userId);

    // If a source explicitly returns missing_integration, surface that immediately
    // — the UI uses it to render a "Connect …" CTA instead of letting the LLM
    // run with a half-empty context.
    const missing = errors.find(e => e.error === 'missing_integration');
    if (missing) {
        return { ok: false, error: 'missing_integration', integration: missing.integration, message: missing.message };
    }
    if (collected.length === 0) {
        return { ok: false, error: 'no_sources', message: 'All sources failed to resolve', errors };
    }

    const systemPrompt = _loadPrompt();
    const userMessage = _buildUserMessage(collected, hints);

    const llmResult = await _callLLM(systemPrompt, userMessage);
    if (!llmResult.ok) return llmResult;

    const code = _extractCode(llmResult.content);
    if (!code) {
        return { ok: false, error: 'parse_error', message: 'No typescript code block found in LLM output', rawContent: llmResult.content?.slice(0, 500) };
    }
    const manifest = _extractManifest(llmResult.content);

    return {
        ok: true,
        playwrightCode: code,
        manifest,
        modelUsed: llmResult.modelUsed,
        sourceSummary: collected.map(s => ({ kind: s.kind, title: s.title })),
        sourceErrors: errors,
    };
}

module.exports = {
    generate,
    // exposed for testing
    _internals: { fetchSources, _buildUserMessage, _extractCode, _extractManifest },
};
