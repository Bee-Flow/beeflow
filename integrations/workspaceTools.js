/**
 * Workspace Integration Tools
 * Provides workspace_read, workspace_write, and workspace_replace tools for AI agents.
 * Follows the same pattern as Gmail, Calendar, Sheets, etc.
 */

const WORKSPACE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'workspace_read',
            description: 'Read the current content of the conversation workspace. The workspace is a persistent document that lives alongside the chat. Use this to check what is currently in the workspace before making updates.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'workspace_write',
            description: 'Write or replace the ENTIRE content in the conversation workspace. The workspace is a persistent document that the user can view and edit alongside the chat. Use this to save long-form content like reports, code, plans, drafts, summaries, or any structured output that the user may want to review, copy, or iterate on. The content supports full Markdown formatting. The user will see the workspace panel open with your content. WARNING: This replaces ALL workspace content. For partial edits, use workspace_replace instead.',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'The full Markdown content to write to the workspace. This replaces the entire workspace content.'
                    },
                    title: {
                        type: 'string',
                        description: 'Optional short title describing what was written (e.g. "Project Plan", "Meeting Notes"). Shown to the user as a status hint.'
                    }
                },
                required: ['content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'workspace_replace',
            description: 'Replace a specific portion of the workspace content. Use this when the user has selected text or asks to edit, rewrite, remove, or modify a specific part of the workspace. This is more efficient than workspace_write because it only changes the targeted text while preserving everything else.',
            parameters: {
                type: 'object',
                properties: {
                    find_text: {
                        type: 'string',
                        description: 'The exact text to find and replace in the workspace. This should match the selected text or the portion the user wants to change. Must be an exact match of existing workspace content.'
                    },
                    replace_text: {
                        type: 'string',
                        description: 'The new text to replace the found text with. Set to empty string to delete/remove the text.'
                    }
                },
                required: ['find_text', 'replace_text']
            }
        }
    }
];

/**
 * Execute a workspace tool call.
 * @param {string} toolName - 'workspace_read', 'workspace_write', or 'workspace_replace'
 * @param {object} args - Tool arguments
 * @param {object} context - Execution context (conversationId, etc.)
 * @returns {object} Tool result
 */
async function executeWorkspaceTool(toolName, args, context) {
    const { conversationId } = context;

    if (!conversationId) {
        return { error: 'Workspace requires an active conversation. Send a message first.' };
    }

    // Lazy-load DB helpers to avoid circular deps
    const { getOne, run } = require('../db');

    // Helper: get workspace content from either agent or direct conversations
    async function getWorkspace(convId) {
        // Try agent_conversations first
        let row = await getOne('SELECT workspace_content FROM agent_conversations WHERE id = $1', [convId]);
        if (row) return { content: row.workspace_content || '', source: 'agent' };
        // Fallback to direct_conversations
        row = await getOne('SELECT workspace_content FROM direct_conversations WHERE id = $1', [convId]);
        if (row) return { content: row.workspace_content || '', source: 'direct' };
        return null;
    }

    // Helper: set workspace content in the correct table
    async function setWorkspace(convId, content) {
        // Try agent_conversations first
        const agentResult = await run('UPDATE agent_conversations SET workspace_content = $1, updated_at = NOW() WHERE id = $2', [content, convId]);
        if (agentResult.rowCount > 0) return true;
        // Fallback to direct_conversations
        const directResult = await run('UPDATE direct_conversations SET workspace_content = $1, updated_at = NOW() WHERE id = $2', [content, convId]);
        return directResult.rowCount > 0;
    }

    if (toolName === 'workspace_read') {
        try {
            const workspace = await getWorkspace(conversationId);
            const content = workspace?.content || '';
            if (!content.trim()) {
                return { content: '', message: 'The workspace is currently empty.' };
            }
            return { content };
        } catch (err) {
            console.error('[WorkspaceTool] Read failed:', err.message);
            return { error: 'Failed to read workspace content.' };
        }
    }

    if (toolName === 'workspace_write') {
        const content = args.content || '';
        const title = args.title || 'Workspace';

        try {
            await setWorkspace(conversationId, content);
            return {
                _action: 'workspace_update',
                content,
                title,
                message: `Workspace updated: "${title}"`
            };
        } catch (err) {
            console.error('[WorkspaceTool] Write failed:', err.message);
            return { error: 'Failed to write to workspace.' };
        }
    }

    if (toolName === 'workspace_replace') {
        const findText = args.find_text;
        const replaceText = args.replace_text ?? '';

        if (!findText) {
            return { error: 'find_text is required for workspace_replace.' };
        }

        try {
            const workspace = await getWorkspace(conversationId);
            const currentContent = workspace?.content || '';

            let newContent;

            // Strategy 1: Exact match
            if (currentContent.includes(findText)) {
                newContent = currentContent.replace(findText, replaceText);
            } else {
                // Strategy 2: Whitespace-normalized match
                const normalizeWs = (t) => t.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
                const findNorm = normalizeWs(findText);
                
                // Try to find the text with normalized whitespace
                const lines = currentContent.split('\n');
                let wsMatchStart = -1, wsMatchEnd = -1;
                const findNormLines = findNorm.split('\n').map(l => l.trim()).filter(Boolean);
                
                if (findNormLines.length > 0) {
                    for (let i = 0; i < lines.length; i++) {
                        const lineNorm = normalizeWs(lines[i]);
                        if (lineNorm === findNormLines[0] || lineNorm.includes(findNormLines[0]) || findNormLines[0].includes(lineNorm)) {
                            wsMatchStart = i;
                            wsMatchEnd = i;
                            let fi = 1;
                            for (let j = i + 1; j < lines.length && fi < findNormLines.length; j++) {
                                const ls = normalizeWs(lines[j]);
                                if (!ls) { wsMatchEnd = j; continue; }
                                if (ls === findNormLines[fi] || ls.includes(findNormLines[fi]) || findNormLines[fi].includes(ls)) {
                                    wsMatchEnd = j;
                                    fi++;
                                }
                            }
                            if (fi >= findNormLines.length) break; // matched all lines
                            wsMatchStart = -1; // reset if not all matched
                        }
                    }
                }

                if (wsMatchStart !== -1) {
                    const before = lines.slice(0, wsMatchStart).join('\n');
                    const after = lines.slice(wsMatchEnd + 1).join('\n');
                    newContent = [before, replaceText, after].filter(p => p !== '').join('\n');
                } else {
                    // Strategy 3: Strip-markdown matching (for rendered text → raw markdown)
                    const stripMd = (t) => t
                        .replace(/\*\*(.+?)\*\*/g, '$1')
                        .replace(/__(.+?)__/g, '$1')
                        .replace(/\*(.+?)\*/g, '$1')
                        .replace(/_(.+?)_/g, '$1')
                        .replace(/~~(.+?)~~/g, '$1')
                        .replace(/`(.+?)`/g, '$1')
                        .replace(/^#{1,6}\s+/gm, '')
                        .replace(/^\s*[-*+]\s+/gm, '')
                        .replace(/^\s*\d+\.\s+/gm, '')
                        .replace(/^\s*>\s*/gm, '')
                        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

                    const findStripped = stripMd(findText).trim();
                    let mdMatchStart = -1, mdMatchEnd = -1;
                    const findMdLines = findStripped.split('\n').map(l => l.trim()).filter(Boolean);

                    if (findMdLines.length > 0) {
                        for (let i = 0; i < lines.length; i++) {
                            const lineStripped = stripMd(lines[i]).trim();
                            if (lineStripped && (lineStripped.includes(findMdLines[0]) || findMdLines[0].includes(lineStripped))) {
                                mdMatchStart = i;
                                mdMatchEnd = i;
                                let fi = 1;
                                for (let j = i + 1; j < lines.length && fi < findMdLines.length; j++) {
                                    const ls = stripMd(lines[j]).trim();
                                    if (!ls) { mdMatchEnd = j; continue; }
                                    if (ls.includes(findMdLines[fi]) || findMdLines[fi].includes(ls)) {
                                        mdMatchEnd = j;
                                        fi++;
                                    }
                                }
                                if (fi >= findMdLines.length) break;
                                mdMatchStart = -1;
                            }
                        }
                    }

                    if (mdMatchStart !== -1) {
                        const before = lines.slice(0, mdMatchStart).join('\n');
                        const after = lines.slice(mdMatchEnd + 1).join('\n');
                        newContent = [before, replaceText, after].filter(p => p !== '').join('\n');
                    } else {
                        console.warn('[WorkspaceTool] Replace match failed. find_text:', JSON.stringify(findText.substring(0, 200)));
                        console.warn('[WorkspaceTool] Current content starts with:', JSON.stringify(currentContent.substring(0, 200)));
                        return { error: `Could not find the specified text in the workspace. The text may have been modified. Try using workspace_read first to see the current content, then retry with the exact text.` };
                    }
                }
            }
            await setWorkspace(conversationId, newContent);
            return {
                _action: 'workspace_update',
                content: newContent,
                message: replaceText ? 'Workspace text replaced successfully.' : 'Workspace text removed successfully.'
            };
        } catch (err) {
            console.error('[WorkspaceTool] Replace failed:', err.message);
            return { error: 'Failed to replace workspace content.' };
        }
    }

    return { error: `Unknown workspace tool: ${toolName}` };
}

module.exports = { WORKSPACE_TOOLS, executeWorkspaceTool };
