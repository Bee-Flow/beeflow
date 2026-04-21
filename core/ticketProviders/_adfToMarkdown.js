/**
 * Atlassian Document Format → Markdown, hand-rolled.
 *
 * Supports the node types that show up in ~99% of Jira ticket descriptions
 * and comments: doc, paragraph, heading, text (with marks: strong, em, code,
 * strike, link), bulletList, orderedList, listItem, codeBlock, blockquote,
 * rule, mention, emoji, table, tableRow, tableHeader, tableCell, hardBreak,
 * inlineCard, media, mediaSingle, mediaGroup (media nodes degrade to "[attachment: name]").
 *
 * Unknown nodes degrade gracefully to plain text of their content.
 *
 * Not a full ADF renderer — good enough for KB ingestion.
 */

function renderText(node) {
    let text = node.text || '';
    for (const mark of node.marks || []) {
        if (mark.type === 'strong') text = `**${text}**`;
        else if (mark.type === 'em') text = `*${text}*`;
        else if (mark.type === 'code') text = `\`${text}\``;
        else if (mark.type === 'strike') text = `~~${text}~~`;
        else if (mark.type === 'link' && mark.attrs?.href) text = `[${text}](${mark.attrs.href})`;
    }
    return text;
}

function renderInline(nodes) {
    if (!Array.isArray(nodes)) return '';
    return nodes.map(render).join('');
}

function renderList(node, ordered) {
    if (!Array.isArray(node.content)) return '';
    return node.content.map((item, i) => {
        const bullet = ordered ? `${i + 1}. ` : '- ';
        // Each listItem contains paragraphs. Render those, join with newline.
        const body = (item.content || []).map(render).join('\n').trim();
        // Re-indent multi-line list items so nested content stays in the item
        const indented = body.split('\n').map((ln, k) => (k === 0 ? ln : '  ' + ln)).join('\n');
        return bullet + indented;
    }).join('\n');
}

function renderTable(node) {
    const rows = node.content || [];
    if (!rows.length) return '';
    const cellText = (cell) => (cell.content || []).map(render).join(' ').trim().replace(/\n+/g, ' ');
    const rowCells = (row) => (row.content || []).map(cellText);
    const header = rowCells(rows[0]);
    const out = [];
    out.push('| ' + header.join(' | ') + ' |');
    out.push('| ' + header.map(() => '---').join(' | ') + ' |');
    for (let i = 1; i < rows.length; i++) {
        out.push('| ' + rowCells(rows[i]).join(' | ') + ' |');
    }
    return out.join('\n');
}

function render(node) {
    if (!node) return '';
    switch (node.type) {
        case 'doc':
            return (node.content || []).map(render).join('\n\n').trim();
        case 'paragraph':
            return renderInline(node.content);
        case 'heading':
            return '#'.repeat(Math.min(6, node.attrs?.level || 2)) + ' ' + renderInline(node.content);
        case 'text':
            return renderText(node);
        case 'hardBreak':
            return '\n';
        case 'rule':
            return '---';
        case 'blockquote':
            return (node.content || []).map(render).join('\n').split('\n').map(l => '> ' + l).join('\n');
        case 'bulletList':
            return renderList(node, false);
        case 'orderedList':
            return renderList(node, true);
        case 'listItem':
            return (node.content || []).map(render).join('\n');
        case 'codeBlock': {
            const lang = node.attrs?.language || '';
            const body = (node.content || []).map(c => c.text || '').join('');
            return '```' + lang + '\n' + body + '\n```';
        }
        case 'mention':
            return `@${node.attrs?.text || node.attrs?.displayName || node.attrs?.id || 'user'}`;
        case 'emoji':
            return node.attrs?.text || node.attrs?.shortName || '';
        case 'inlineCard':
            return node.attrs?.url ? `<${node.attrs.url}>` : '';
        case 'media':
        case 'mediaSingle':
        case 'mediaGroup': {
            const name = node.attrs?.alt || node.attrs?.id || 'attachment';
            return `[attachment: ${name}]`;
        }
        case 'table':
            return renderTable(node);
        case 'tableRow':
        case 'tableHeader':
        case 'tableCell':
            // Handled inside renderTable; if reached standalone, stringify contents.
            return (node.content || []).map(render).join(' ');
        default:
            // Unknown node — recurse into content if present.
            return (node.content || []).map(render).join('');
    }
}

function adfToMarkdown(doc) {
    if (!doc) return '';
    if (typeof doc === 'string') return doc;
    try {
        return render(doc).replace(/\n{3,}/g, '\n\n').trim();
    } catch (err) {
        return '';
    }
}

module.exports = { adfToMarkdown };
