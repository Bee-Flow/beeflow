/**
 * Notebook Document Tools
 * Provides notebook_doc_read, notebook_doc_write, notebook_doc_replace, and notebook_add_source
 * tools for AI interaction with the TipTap-based notebook editor.
 * 
 * Unlike workspace tools (which use markdown), these operate on HTML content
 * matching TipTap's internal format.
 */

const NOTEBOOK_DOC_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'notebook_doc_read',
            description: 'Read the current content of the notebook document editor. The document is a rich-text editor (TipTap) visible to the user. Use this BEFORE any write or replace operation to see the exact current content.',
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
            name: 'notebook_doc_write',
            description: 'Write or replace the ENTIRE content of the notebook document editor. Use TipTap-compatible HTML:\n- <p>paragraph</p>\n- <h1>, <h2>, <h3> for headings\n- <strong>bold</strong>, <em>italic</em>, <u>underline</u>\n- <s>strikethrough</s>, <mark>highlight</mark>\n- <ul><li><p>bullet</p></li></ul> (list items MUST contain <p>)\n- <ol><li><p>numbered</p></li></ol>\n- <blockquote><p>quote</p></blockquote>\n- <a href="url" target="_blank" rel="noopener noreferrer">link text</a>\n- <hr> for horizontal dividers\n- <code>inline code</code>, <pre><code>code block</code></pre>\n\nWARNING: This replaces ALL document content. For partial edits, use notebook_doc_replace.',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'The full HTML content to write to the document. This replaces the entire document content. Use TipTap-compatible HTML tags for formatting.'
                    },
                    title: {
                        type: 'string',
                        description: 'Optional short description of what was written (e.g. "Summary Report", "Meeting Notes"). Shown to the user.'
                    }
                },
                required: ['content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'notebook_doc_replace',
            description: 'Replace a specific portion of the notebook document. Use this when the user asks to edit, rewrite, fix, or modify a specific section. This preserves all other content. The find_text should match the plain text content (HTML tags are stripped for matching). The replace_text should be TipTap-compatible HTML.\n\nIMPORTANT: Always call notebook_doc_read first to see exact content before replacing.',
            parameters: {
                type: 'object',
                properties: {
                    find_text: {
                        type: 'string',
                        description: 'The text to find in the document. This is matched against the plain-text content (HTML tags stripped). Must be an exact match of existing text.'
                    },
                    replace_text: {
                        type: 'string',
                        description: 'The new HTML content to replace the found text with. Use TipTap-compatible HTML for formatting. Set to empty string to delete the text.'
                    }
                },
                required: ['find_text', 'replace_text']
            }
        }
    }
];

/**
 * Tool to add web search results or other text directly as a notebook source.
 * This allows the AI to research with web search and directly pass the results as a data source.
 */
const NOTEBOOK_ADD_SOURCE_TOOL = {
    type: 'function',
    function: {
        name: 'notebook_add_source',
        description: 'Add content as a new source to the notebook. Use this to directly pass web search results, research findings, or any text content as a notebook source for future reference. The content will be indexed and available for citation in future queries. This is perfect for saving web search results as a source — pass the search results directly without re-fetching.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'A short descriptive name for the source (e.g. "Web Search: AI trends 2026", "React Documentation", "Market Analysis")'
                },
                content: {
                    type: 'string',
                    description: 'The full text content to add as a source. For web search results, pass the complete search results text including titles, content, and URLs.'
                }
            },
            required: ['name', 'content']
        }
    }
};

/**
 * Execute a notebook document tool call.
 * Unlike workspace tools, these use an in-memory document content passed via context
 * rather than database storage (the frontend is the source of truth for the editor).
 */
function executeNotebookDocTool(toolName, args, documentContent) {
    if (toolName === 'notebook_doc_read') {
        if (!documentContent || !documentContent.trim() || documentContent === '<p></p>') {
            return { content: '', message: 'The document is currently empty.' };
        }
        return { content: documentContent };
    }

    if (toolName === 'notebook_doc_write') {
        const content = args.content || '';
        const title = args.title || 'Document';
        return {
            _action: 'notebook_doc_update',
            content,
            title,
            message: `Document updated: "${title}"`
        };
    }

    if (toolName === 'notebook_doc_replace') {
        const findText = args.find_text;
        const replaceText = args.replace_text ?? '';

        if (!findText) {
            return { error: 'find_text is required for notebook_doc_replace.' };
        }

        if (!documentContent) {
            return { error: 'The document is empty. Use notebook_doc_write to create content first.' };
        }

        // Strip HTML tags for text matching
        const stripHtml = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const normalized = (t) => t.replace(/\s+/g, ' ').trim();
        const findNorm = normalized(findText);
        const plainNorm = normalized(stripHtml(documentContent));

        if (plainNorm.includes(findNorm)) {
            let newContent = documentContent;

            // Try exact match within HTML
            if (documentContent.includes(findText)) {
                newContent = documentContent.replace(findText, replaceText);
            } else {
                // Build a regex that matches the text with optional HTML tags in between
                const escapedParts = findText.split(/\s+/).map(word =>
                    word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                );
                const flexibleRegex = new RegExp(
                    escapedParts.join('(?:<[^>]*>|\\s)*'),
                    's'
                );
                const match = documentContent.match(flexibleRegex);
                if (match) {
                    newContent = documentContent.replace(match[0], replaceText);
                } else {
                    // Find the paragraph(s) containing the text
                    const paragraphs = documentContent.split(/(<\/?(?:p|h[1-3]|li|blockquote|ul|ol)(?:\s[^>]*)?>)/);
                    let found = false;
                    let startIdx = -1, endIdx = -1;
                    let accumulated = '';

                    for (let i = 0; i < paragraphs.length; i++) {
                        const stripped = stripHtml(paragraphs[i]).trim();
                        if (!stripped) continue;
                        accumulated += (accumulated ? ' ' : '') + stripped;
                        if (startIdx === -1 && normalized(accumulated).includes(findNorm.substring(0, Math.min(20, findNorm.length)))) {
                            startIdx = i;
                        }
                        if (startIdx !== -1 && normalized(accumulated).includes(findNorm)) {
                            endIdx = i;
                            found = true;
                            break;
                        }
                    }

                    if (found) {
                        const before = paragraphs.slice(0, startIdx).join('');
                        const after = paragraphs.slice(endIdx + 1).join('');
                        newContent = before + replaceText + after;
                    } else {
                        return {
                            error: `Could not find the specified text in the document. Try using notebook_doc_read first to see the current content, then retry with the exact text.`
                        };
                    }
                }
            }

            return {
                _action: 'notebook_doc_update',
                content: newContent,
                message: replaceText ? 'Document text replaced successfully.' : 'Document text removed successfully.'
            };
        }

        return {
            error: `Could not find "${findText.substring(0, 100)}..." in the document. Use notebook_doc_read first to see the exact current content.`
        };
    }

    return { error: `Unknown notebook document tool: ${toolName}` };
}

module.exports = { NOTEBOOK_DOC_TOOLS, NOTEBOOK_ADD_SOURCE_TOOL, executeNotebookDocTool };
