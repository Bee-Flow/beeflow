/**
 * Export Template — builds a professional HTML document for PDF rendering.
 *
 * Wraps notebook HTML content in a print-ready layout with:
 *  - Optional cover page with title, date, author
 *  - Page headers (title) and footers (page numbers)
 *  - Clean typography, proper heading hierarchy
 *  - Print-optimized CSS (page breaks, orphans/widows)
 */

function buildExportHTML(content, { title = 'Untitled', author = '', date = '' } = {}) {
    const formattedDate = date || new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Merriweather:wght@400;700&family=Playfair+Display:wght@400;700&family=Lora:wght@400;700&family=Source+Sans+3:wght@400;600;700&family=Nunito:wght@400;600;700&family=Poppins:wght@400;500;600&family=Roboto+Mono:wght@400;500&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
<style>
    /* ── Print page setup ────────────────────────────── */
    @page {
        size: letter;
        margin: 0.75in 0.85in 0.9in 0.85in;
        @top-center { content: ""; }
        @bottom-center { content: counter(page); }
    }
    @page :first { margin-top: 0; }

    /* ── Base typography ─────────────────────────────── */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body {
        font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
        font-size: 11pt;
        line-height: 1.65;
        color: #1a1a1a;
        background: white;
        max-width: 100%;
    }

    /* ── Cover page ──────────────────────────────────── */
    .cover-page {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: flex-start;
        min-height: 100vh;
        padding: 2in 0;
        page-break-after: always;
    }
    .cover-page .cover-accent {
        width: 60px;
        height: 4px;
        background: linear-gradient(90deg, #3b82f6, #8b5cf6);
        border-radius: 2px;
        margin-bottom: 24pt;
    }
    .cover-page h1 {
        font-size: 28pt;
        font-weight: 700;
        color: #111;
        line-height: 1.2;
        margin-bottom: 12pt;
        max-width: 5.5in;
    }
    .cover-page .cover-meta {
        font-size: 11pt;
        color: #666;
        margin-top: 8pt;
    }
    .cover-page .cover-meta span { margin-right: 20pt; }
    .cover-page .cover-branding {
        margin-top: auto;
        font-size: 10pt;
        color: #999;
        letter-spacing: 0.5pt;
    }

    /* ── Header bar (repeats on each page via fixed positioning trick) ── */
    .page-header {
        position: running(header);
        font-size: 8.5pt;
        color: #999;
        border-bottom: 0.5pt solid #e5e5e5;
        padding-bottom: 4pt;
        margin-bottom: 12pt;
    }

    /* ── Document content ────────────────────────────── */
    .document-body {
        padding-top: 12pt;
    }
    .document-body p {
        margin-bottom: 8pt;
        orphans: 3;
        widows: 3;
    }
    .document-body h1 {
        font-size: 20pt;
        font-weight: 700;
        color: #111;
        margin-top: 24pt;
        margin-bottom: 10pt;
        page-break-after: avoid;
        border-bottom: 1.5pt solid #e5e7eb;
        padding-bottom: 6pt;
    }
    .document-body h2 {
        font-size: 16pt;
        font-weight: 600;
        color: #1e293b;
        margin-top: 20pt;
        margin-bottom: 8pt;
        page-break-after: avoid;
    }
    .document-body h3 {
        font-size: 13pt;
        font-weight: 600;
        color: #334155;
        margin-top: 16pt;
        margin-bottom: 6pt;
        page-break-after: avoid;
    }
    .document-body h4, .document-body h5, .document-body h6 {
        font-size: 11pt;
        font-weight: 600;
        color: #475569;
        margin-top: 12pt;
        margin-bottom: 4pt;
        page-break-after: avoid;
    }

    /* Lists */
    .document-body ul, .document-body ol {
        margin-left: 0.3in;
        margin-bottom: 8pt;
        padding-left: 0;
    }
    .document-body li {
        margin-bottom: 3pt;
        page-break-inside: avoid;
    }
    .document-body li p { margin-bottom: 2pt; }

    /* Task lists */
    .document-body ul[data-type="taskList"] {
        list-style: none;
        margin-left: 0;
    }
    .document-body li[data-checked="true"]::before { content: "☑ "; }
    .document-body li[data-checked="false"]::before { content: "☐ "; }

    /* Links */
    .document-body a {
        color: #2563eb;
        text-decoration: none;
    }

    /* Bold / italic */
    .document-body strong { font-weight: 600; }
    .document-body em { font-style: italic; }

    /* Blockquotes */
    .document-body blockquote {
        border-left: 3pt solid #3b82f6;
        margin: 12pt 0;
        padding: 8pt 14pt;
        background: #f8fafc;
        color: #334155;
        font-style: italic;
        page-break-inside: avoid;
    }
    .document-body blockquote p { margin-bottom: 4pt; }

    /* Code (inline) */
    .document-body code {
        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
        font-size: 9.5pt;
        background: #f1f5f9;
        padding: 1pt 4pt;
        border-radius: 3pt;
        color: #be185d;
    }

    /* Code blocks */
    .document-body pre {
        background: #1e293b;
        color: #e2e8f0;
        padding: 12pt 16pt;
        border-radius: 6pt;
        margin: 12pt 0;
        overflow-x: auto;
        font-size: 9pt;
        line-height: 1.5;
        page-break-inside: avoid;
    }
    .document-body pre code {
        background: none;
        padding: 0;
        color: inherit;
        font-size: inherit;
    }

    /* Tables */
    .document-body table {
        width: 100%;
        border-collapse: collapse;
        margin: 12pt 0;
        font-size: 10pt;
        page-break-inside: avoid;
    }
    .document-body th {
        background: #f1f5f9;
        font-weight: 600;
        text-align: left;
        padding: 6pt 10pt;
        border: 0.5pt solid #cbd5e1;
        color: #1e293b;
    }
    .document-body td {
        padding: 5pt 10pt;
        border: 0.5pt solid #e2e8f0;
        vertical-align: top;
    }
    .document-body tr:nth-child(even) td { background: #fafafa; }

    /* Images */
    .document-body img {
        max-width: 100%;
        height: auto;
        border-radius: 4pt;
        margin: 8pt 0;
        page-break-inside: avoid;
    }

    /* Horizontal rule */
    .document-body hr {
        border: none;
        border-top: 1pt solid #e5e7eb;
        margin: 16pt 0;
    }

    /* Mark / highlight */
    .document-body mark {
        background: #fef08a;
        padding: 0 2pt;
        border-radius: 2pt;
    }

    /* Text colors — preserve inline color styles */
    .document-body [style*="color"] { }

    /* Font families — preserve inline font-family styles from TipTap editor */
    .document-body [style*="font-family"] { }

    /* ── Footer ──────────────────────────────────────── */
    .page-footer {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        text-align: center;
        font-size: 8pt;
        color: #bbb;
        padding-top: 6pt;
        border-top: 0.5pt solid #eee;
    }
</style>
</head>
<body>
    <!-- Cover page -->
    <div class="cover-page">
        <div class="cover-accent"></div>
        <h1>${escapeHtml(title)}</h1>
        <div class="cover-meta">
            ${author ? `<span>👤 ${escapeHtml(author)}</span>` : ''}
            <span>📅 ${escapeHtml(formattedDate)}</span>
        </div>
        <div class="cover-branding">
            🐝 Generated by BeeFlow
        </div>
    </div>

    <!-- Document content -->
    <div class="document-body">
        ${content}
    </div>
</body>
</html>`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Clean notebook HTML for export — strip editor-specific markup,
 * preserve content styles (image widths, text colors, table widths).
 */
function cleanContentForExport(html) {
    let cleaned = html;

    // ── Table fixes ────────────────────────────────────────────
    // Remove column-resize-handle divs (TipTap editor artifact)
    cleaned = cleaned.replace(/<div[^>]*class="column-resize-handle"[^>]*>(<\/div>)?/gi, '');

    // Remove selectedCell class (editor selection state)
    cleaned = cleaned.replace(/\s*selectedCell/gi, '');

    // Strip <colgroup>...</colgroup> — TipTap adds these with min-width styles
    // that confuse html-to-docx and cause single-character-wide columns
    cleaned = cleaned.replace(/<colgroup[\s\S]*?<\/colgroup>/gi, '');

    // Convert TipTap data-colwidth to HTML width attributes on td/th
    // html-to-docx reads HTML width="" attributes, NOT CSS style widths
    cleaned = cleaned.replace(/<(t[dh])([^>]*?)data-colwidth="(\d+)"([^>]*?)>/gi, (match, tag, before, width, after) => {
        // Remove the data-colwidth and add HTML width attribute instead
        const cleanBefore = before.replace(/data-colwidth="\d+"\s*/gi, '');
        const cleanAfter = after.replace(/data-colwidth="\d+"\s*/gi, '');
        return `<${tag}${cleanBefore}${cleanAfter} width="${width}">`;
    });

    // Unwrap tableWrapper divs — TipTap wraps <table> in <div class="tableWrapper">
    cleaned = cleaned.replace(/<div[^>]*class="[^"]*tableWrapper[^"]*"[^>]*>/gi, '');
    // Remove closing div that was the tableWrapper
    cleaned = cleaned.replace(/(<table[\s\S]*?<\/table>)\s*<\/div>/gi, '$1');

    // Ensure table has width="100%" and border for DOCX compatibility
    cleaned = cleaned.replace(/<table(?![^>]*width=)/gi, '<table width="100%" border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse;"');

    // ── General cleanup ────────────────────────────────────────
    // Remove TipTap/ProseMirror editor-specific classes
    cleaned = cleaned.replace(/\s*class="(ProseMirror|tiptap|is-editor-empty|is-empty|has-focus|resizable-image-wrapper|resizable-image-container|notebook-image|resize-handle|resize-width-indicator)[^"]*"/gi, '');

    // Remove data attributes except data-type, data-checked (table-related ones already converted above)
    cleaned = cleaned.replace(/\s*data-(?!type|checked)[a-z-]+="[^"]*"/gi, '');

    // Remove contenteditable attributes
    cleaned = cleaned.replace(/\s*contenteditable="[^"]*"/gi, '');

    // Remove draggable attributes
    cleaned = cleaned.replace(/\s*draggable="[^"]*"/gi, '');

    // Clean up empty class attributes
    cleaned = cleaned.replace(/\s*class=""/g, '');

    // Clean up resize handle divs
    cleaned = cleaned.replace(/<div class="resize-handle[^"]*"><\/div>/gi, '');

    // Clean up width indicator divs
    cleaned = cleaned.replace(/<div class="resize-width-indicator">[^<]*<\/div>/gi, '');

    return cleaned;
}

module.exports = { buildExportHTML, cleanContentForExport, escapeHtml };
