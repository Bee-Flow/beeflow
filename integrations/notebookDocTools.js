/**
 * Notebook Document Tools — Markdown edition.
 *
 * The AI reads and writes the document as BeeFlow-Flavored Markdown (BFM): far
 * fewer tokens than TipTap HTML for the same rendered result, and a much more
 * robust find/replace (substring match on the markdown the AI actually sees).
 *
 * The editor remains the source of truth and still speaks HTML, so the executor
 * converts Markdown → HTML for the doc-update the client applies. This keeps the
 * client apply path (and the TipTap fallback) unchanged while capturing the
 * token win on the input side (read + system prompt + emitted edits).
 */

const { markdownToHtml, htmlToMarkdown } = require('../core/markdown');

const BFM_CHEATSHEET =
  'Use Markdown:\n' +
  '- # / ## / ### headings, **bold**, *italic*, ~~strike~~, `code`, ==highlight==\n' +
  '- lists: "- item", "1. item", task lists "- [ ] todo" / "- [x] done"\n' +
  '- > blockquote, --- divider, [text](url) links, | tables | with |---| rows\n' +
  '- ```mermaid fenced blocks for diagrams, $inline$ / $$block$$ for math\n' +
  '- images: ![alt](src){w=400 align=center wrap} (attrs optional)';

const NOTEBOOK_DOC_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'notebook_doc_read',
      description: 'Read the current notebook document as Markdown. Call this BEFORE any write or replace so you match the exact current text.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notebook_doc_write',
      description: 'Replace the ENTIRE notebook document with new Markdown content. ' + BFM_CHEATSHEET + '\nFor partial edits use notebook_doc_replace instead.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The full document as Markdown. Replaces all current content.' },
          title: { type: 'string', description: 'Optional short label of what was written (shown to the user).' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notebook_doc_replace',
      description: 'Replace a specific portion of the document, preserving everything else. find_text is matched against the document Markdown (call notebook_doc_read first). replace_text is Markdown (empty string deletes).',
      parameters: {
        type: 'object',
        properties: {
          find_text: { type: 'string', description: 'Exact Markdown/text to find (from notebook_doc_read).' },
          replace_text: { type: 'string', description: 'New Markdown to substitute. Empty string to delete.' },
        },
        required: ['find_text', 'replace_text'],
      },
    },
  },
];

// notebook_add_source is unchanged (content/metadata source ingestion).
const NOTEBOOK_ADD_SOURCE_TOOL = {
  type: 'function',
  function: {
    name: 'notebook_add_source',
    description: 'Add content as a new source to the notebook (web results, research findings, extracted invoice data). Indexed for future citation. For tax notebooks ALWAYS include the metadata financial fields — they power the dashboard stats.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short descriptive name for the source.' },
        content: { type: 'string', description: 'Full text content to add as a source.' },
        metadata: {
          type: 'object',
          description: 'Structured metadata. For tax notebooks ALWAYS populate the financial fields.',
          properties: {
            taxCategory: { type: 'string', description: '"income" or "expense"' },
            amount: { type: 'number', description: 'Amount excluding BTW/VAT' },
            btwAmount: { type: 'number', description: 'BTW/VAT amount' },
            btwRate: { type: 'number', description: 'BTW rate: 0, 9, or 21' },
            totalAmount: { type: 'number', description: 'Total including BTW' },
            vendor: { type: 'string', description: 'Vendor/customer name' },
            invoiceNumber: { type: 'string', description: 'Invoice/receipt number' },
            invoiceDate: { type: 'string', description: 'Invoice date YYYY-MM-DD' },
            isInvoice: { type: 'boolean', description: 'Whether this is an invoice' },
            sourceType: { type: 'string', description: '"gmail", "drive", "upload", or "manual"' },
            emailMessageId: { type: 'string', description: 'Gmail message ID (dedup)' },
            driveFileId: { type: 'string', description: 'Google Drive file ID (dedup)' },
          },
        },
      },
      required: ['name', 'content'],
    },
  },
};

/**
 * Execute a notebook document tool.
 * @param {string} toolName
 * @param {object} args
 * @param {string} documentContent  current document HTML (editor source of truth)
 * @param {string} [documentMd]     canonical Markdown mirror (derived if absent)
 */
function executeNotebookDocTool(toolName, args, documentContent, documentMd) {
  const docMd = (documentMd != null && documentMd !== '')
    ? documentMd
    : htmlToMarkdown(documentContent || '');

  if (toolName === 'notebook_doc_read') {
    if (!docMd || !docMd.trim()) return { content: '', format: 'markdown', message: 'The document is currently empty.' };
    return { content: docMd, format: 'markdown' };
  }

  if (toolName === 'notebook_doc_write') {
    const md = args.content || '';
    const title = args.title || 'Document';
    return { _action: 'notebook_doc_update', content: markdownToHtml(md), contentMd: md, title, message: `Document updated: "${title}"` };
  }

  if (toolName === 'notebook_doc_replace') {
    const findText = args.find_text;
    const replaceText = args.replace_text ?? '';
    if (!findText) return { error: 'find_text is required for notebook_doc_replace.' };
    if (!docMd || !docMd.trim()) return { error: 'The document is empty. Use notebook_doc_write to create content first.' };

    let newMd = null;
    if (docMd.includes(findText)) {
      newMd = docMd.replace(findText, replaceText);
    } else {
      const norm = (t) => t.replace(/\s+/g, ' ').trim();
      if (norm(docMd).includes(norm(findText))) {
        // Whitespace-flexible regex (markdown rarely has interleaving tags).
        const re = new RegExp(findText.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 's');
        const m = docMd.match(re);
        if (m) newMd = docMd.replace(m[0], replaceText);
      }
    }

    if (newMd == null) {
      const norm = (t) => t.replace(/\s+/g, ' ').trim();
      const words = norm(findText).split(' ').filter(Boolean);
      let suggestion = '';
      if (words.length >= 2) {
        const needle = words.slice(0, Math.min(4, words.length)).join(' ').toLowerCase();
        const idx = norm(docMd).toLowerCase().indexOf(needle);
        if (idx >= 0) suggestion = norm(docMd).slice(idx, idx + Math.min(160, norm(findText).length + 60));
      }
      const hint = suggestion
        ? ` The document contains something similar starting with: "${suggestion.slice(0, 160)}…" — use that exact text.`
        : ' Call notebook_doc_read first to see the exact current Markdown, then retry.';
      return { error: `Could not find "${findText.slice(0, 100)}${findText.length > 100 ? '…' : ''}" in the document.${hint}` };
    }

    return {
      _action: 'notebook_doc_update',
      content: markdownToHtml(newMd),
      contentMd: newMd,
      message: replaceText ? 'Document text replaced successfully.' : 'Document text removed successfully.',
    };
  }

  return { error: `Unknown notebook document tool: ${toolName}` };
}

module.exports = { NOTEBOOK_DOC_TOOLS, NOTEBOOK_ADD_SOURCE_TOOL, executeNotebookDocTool };
