/**
 * Notebook Tools (formerly Workspace Tools)
 * Provides notebook_read, notebook_write, notebook_replace, notebook_insert,
 * and notebook_style tools for AI agents.
 * These operate on the rich-text notebook panel that appears alongside the chat.
 * Content is stored as Markdown in the database; the TipTap editor renders it as rich text.
 */

const WORKSPACE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'notebook_read',
            description: 'Read the current Markdown content of the notebook panel. The notebook is a rich-text editor (TipTap) visible to the user alongside the chat. ALWAYS call this before notebook_replace so you have the exact current text to search for.',
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
            name: 'notebook_write',
            description: 'Write or replace the ENTIRE content of the notebook panel. Use this proactively whenever producing long-form output that the user is likely to want to save, copy, or iterate on — such as reports, plans, summaries, code files, structured documents, or meeting notes. Write content in Markdown — the notebook automatically renders it as rich text with headings, bold, lists, tables, code blocks, etc. The notebook panel opens automatically. WARNING: This replaces ALL existing content. For editing only a part of an existing document, use notebook_replace instead.',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'The full Markdown content to write to the notebook. This replaces the entire notebook content. The notebook renders it as rich text.'
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
            name: 'notebook_replace',
            description: 'Replace a specific portion of the notebook content. IMPORTANT: always call notebook_read first to get the exact current Markdown text, then copy find_text character-for-character (including all Markdown formatting such as ** # - etc.) from that output. Use this when the user asks to edit, rewrite, remove, or update a specific part of the notebook. Prefer this over notebook_write for any partial edit — it preserves everything else in the document.',
            parameters: {
                type: 'object',
                properties: {
                    find_text: {
                        type: 'string',
                        description: 'The exact Markdown text to find and replace in the notebook. This should match the selected text or the portion the user wants to change. Must be an exact match of existing notebook content.'
                    },
                    replace_text: {
                        type: 'string',
                        description: 'The new Markdown text to replace the found text with. Set to empty string to delete/remove the text.'
                    }
                },
                required: ['find_text', 'replace_text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'notebook_insert',
            description: 'Insert content at a specific position in the notebook. Use this to append sections, add content after a heading, or insert at the beginning. Preferred over notebook_write when you want to ADD content without replacing existing content.',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'The Markdown content to insert.'
                    },
                    position: {
                        type: 'string',
                        enum: ['start', 'end', 'after'],
                        description: 'Where to insert: "start" (beginning of document), "end" (append at bottom), or "after" (after the text specified in after_text).'
                    },
                    after_text: {
                        type: 'string',
                        description: 'When position is "after", the text to insert content after. Must be an exact match of existing content (e.g. a heading line like "## Section Title").'
                    }
                },
                required: ['content', 'position']
            }
        }
    }
];

/**
 * Execute a notebook tool call.
 * @param {string} toolName - 'notebook_read', 'notebook_write', 'notebook_replace',
 *                             'notebook_insert', or 'notebook_style'
 *                             (also accepts legacy 'workspace_*' names for backwards compat)
 * @param {object} args - Tool arguments
 * @param {object} context - Execution context (conversationId, etc.)
 * @returns {object} Tool result
 */
async function executeWorkspaceTool(toolName, args, context) {
    const { conversationId } = context;

    // Normalize legacy tool names
    const normalizedName = toolName
        .replace('workspace_read', 'notebook_read')
        .replace('workspace_write', 'notebook_write')
        .replace('workspace_replace', 'notebook_replace');

    if (!conversationId) {
        return { error: 'Notebook requires an active conversation. Send a message first.' };
    }

    // Lazy-load DB helpers to avoid circular deps
    const { getOne, run } = require('../db');

    // Helper: get notebook content from either agent or direct conversations
    async function getWorkspace(convId) {
        // Try agent_conversations first
        let row = await getOne('SELECT workspace_content FROM agent_conversations WHERE id = $1', [convId]);
        if (row) return { content: row.workspace_content || '', source: 'agent' };
        // Fallback to direct_conversations
        row = await getOne('SELECT workspace_content FROM direct_conversations WHERE id = $1', [convId]);
        if (row) return { content: row.workspace_content || '', source: 'direct' };
        return null;
    }

    // Helper: set notebook content in the correct table
    async function setWorkspace(convId, content) {
        // Try agent_conversations first
        const agentResult = await run('UPDATE agent_conversations SET workspace_content = $1, updated_at = NOW() WHERE id = $2', [content, convId]);
        if (agentResult.rowCount > 0) return true;
        // Fallback to direct_conversations
        const directResult = await run('UPDATE direct_conversations SET workspace_content = $1, updated_at = NOW() WHERE id = $2', [content, convId]);
        return directResult.rowCount > 0;
    }

    if (normalizedName === 'notebook_read') {
        try {
            const workspace = await getWorkspace(conversationId);
            const content = workspace?.content || '';
            if (!content.trim()) {
                return { content: '', message: 'The notebook is currently empty.' };
            }
            return { content };
        } catch (err) {
            console.error('[NotebookTool] Read failed:', err.message);
            return { error: 'Failed to read notebook content.' };
        }
    }

    if (normalizedName === 'notebook_write') {
        const content = args.content || '';
        const title = args.title || 'Notebook';

        try {
            await setWorkspace(conversationId, content);
            return {
                _action: 'workspace_update',
                content,
                title,
                message: `Notebook updated: "${title}"`
            };
        } catch (err) {
            console.error('[NotebookTool] Write failed:', err.message);
            return { error: 'Failed to write to notebook.' };
        }
    }

    if (normalizedName === 'notebook_insert') {
        const insertContent = args.content || '';
        const position = args.position || 'end';
        const afterText = args.after_text || '';

        if (!insertContent.trim()) {
            return { error: 'content is required for notebook_insert.' };
        }

        try {
            const workspace = await getWorkspace(conversationId);
            const currentContent = workspace?.content || '';
            let newContent;

            if (position === 'start') {
                newContent = insertContent + '\n\n' + currentContent;
            } else if (position === 'end') {
                newContent = currentContent + (currentContent.trim() ? '\n\n' : '') + insertContent;
            } else if (position === 'after') {
                if (!afterText) {
                    return { error: 'after_text is required when position is "after".' };
                }
                // Try exact match first
                if (currentContent.includes(afterText)) {
                    const idx = currentContent.indexOf(afterText) + afterText.length;
                    newContent = currentContent.slice(0, idx) + '\n\n' + insertContent + currentContent.slice(idx);
                } else {
                    // Try whitespace-normalized match
                    const normalizeWs = (t) => t.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
                    const afterNorm = normalizeWs(afterText);
                    const lines = currentContent.split('\n');
                    let matchEnd = -1;

                    for (let i = 0; i < lines.length; i++) {
                        if (normalizeWs(lines[i]).includes(afterNorm) || afterNorm.includes(normalizeWs(lines[i]))) {
                            matchEnd = i;
                            break;
                        }
                    }

                    if (matchEnd !== -1) {
                        const before = lines.slice(0, matchEnd + 1).join('\n');
                        const after = lines.slice(matchEnd + 1).join('\n');
                        newContent = before + '\n\n' + insertContent + (after ? '\n' + after : '');
                    } else {
                        // Fallback: append at end
                        newContent = currentContent + '\n\n' + insertContent;
                    }
                }
            } else {
                return { error: `Invalid position: ${position}. Use "start", "end", or "after".` };
            }

            await setWorkspace(conversationId, newContent);
            return {
                _action: 'workspace_update',
                content: newContent,
                message: `Content inserted at ${position}${position === 'after' ? ` "${afterText.substring(0, 50)}"` : ''}.`
            };
        } catch (err) {
            console.error('[NotebookTool] Insert failed:', err.message);
            return { error: 'Failed to insert into notebook.' };
        }
    }

    if (normalizedName === 'notebook_replace') {
        const findText = args.find_text;
        const replaceText = args.replace_text ?? '';

        if (!findText) {
            return { error: 'find_text is required for notebook_replace.' };
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
                        console.warn('[NotebookTool] Replace match failed. find_text:', JSON.stringify(findText.substring(0, 200)));
                        console.warn('[NotebookTool] Current content starts with:', JSON.stringify(currentContent.substring(0, 200)));
                        return { error: `Could not find the specified text in the notebook. The text may have been modified. Try using notebook_read first to see the current content, then retry with the exact text.` };
                    }
                }
            }
            await setWorkspace(conversationId, newContent);
            return {
                _action: 'workspace_update',
                content: newContent,
                message: replaceText ? 'Notebook text replaced successfully.' : 'Notebook text removed successfully.'
            };
        } catch (err) {
            console.error('[NotebookTool] Replace failed:', err.message);
            return { error: 'Failed to replace notebook content.' };
        }
    }

    return { error: `Unknown notebook tool: ${toolName}` };
}

module.exports = { WORKSPACE_TOOLS, executeWorkspaceTool };
