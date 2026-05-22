const cheerio = require('cheerio');
const { URL } = require('url');

// Elements to completely remove from the DOM before conversion
const REMOVE_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'svg',
    'nav', 'footer', 'header',
    'form', 'button', 'input', 'select', 'textarea',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '.sidebar', '.menu', '.nav', '.navigation',
    '.cookie-banner', '.cookie-notice', '.popup', '.modal',
    '.advertisement', '.ad', '.ads', '.adsbygoogle',
    '.social-share', '.share-buttons', '.social-links',
    '.comments', '.comment-form',
];

/**
 * Convert an HTML element and its children to Markdown.
 */
function toMarkdown($, el, opts, baseUrl) {
    if (el.type === 'text') {
        // Collapse whitespace but preserve single spaces
        return el.data.replace(/\s+/g, ' ');
    }

    if (el.type !== 'tag') return '';

    const tag = el.tagName.toLowerCase();
    const children = (el.children || [])
        .map(child => toMarkdown($, child, opts, baseUrl))
        .join('');

    switch (tag) {
        // Headings
        case 'h1': return `\n\n# ${children.trim()}\n\n`;
        case 'h2': return `\n\n## ${children.trim()}\n\n`;
        case 'h3': return `\n\n### ${children.trim()}\n\n`;
        case 'h4': return `\n\n#### ${children.trim()}\n\n`;
        case 'h5': return `\n\n##### ${children.trim()}\n\n`;
        case 'h6': return `\n\n###### ${children.trim()}\n\n`;

        // Paragraphs & line breaks
        case 'p':
        case 'div':
        case 'section':
        case 'article':
        case 'main': {
            const text = children.trim();
            return text ? `\n\n${text}\n\n` : '';
        }
        case 'br': return '\n';
        case 'hr': return '\n\n---\n\n';

        // Inline formatting
        case 'strong':
        case 'b': {
            const text = children.trim();
            return text ? `**${text}**` : '';
        }
        case 'em':
        case 'i': {
            const text = children.trim();
            return text ? `*${text}*` : '';
        }
        case 'del':
        case 's': {
            const text = children.trim();
            return text ? `~~${text}~~` : '';
        }
        case 'code': {
            const text = children.trim();
            return text ? `\`${text}\`` : '';
        }

        // Links
        case 'a': {
            const href = $(el).attr('href');
            const text = children.trim();
            if (!text) return '';
            if (!opts.includeLinks || !href) return text;
            try {
                const absoluteUrl = new URL(href, baseUrl).href;
                return `[${text}](${absoluteUrl})`;
            } catch {
                return `[${text}](${href})`;
            }
        }

        // Images
        case 'img': {
            if (!opts.includeImages) return '';
            const src = $(el).attr('src');
            const alt = $(el).attr('alt') || 'image';
            if (!src) return '';
            try {
                const absoluteUrl = new URL(src, baseUrl).href;
                return `![${alt}](${absoluteUrl})`;
            } catch {
                return `![${alt}](${src})`;
            }
        }

        // Lists
        case 'ul': {
            const items = $(el).children('li').map((i, li) => {
                const text = toMarkdown($, li, opts, baseUrl).trim();
                return text ? `- ${text}` : '';
            }).get().filter(Boolean).join('\n');
            return items ? `\n\n${items}\n\n` : '';
        }
        case 'ol': {
            let idx = 0;
            const items = $(el).children('li').map((i, li) => {
                const text = toMarkdown($, li, opts, baseUrl).trim();
                if (!text) return '';
                idx++;
                return `${idx}. ${text}`;
            }).get().filter(Boolean).join('\n');
            return items ? `\n\n${items}\n\n` : '';
        }
        case 'li': return children;

        // Code blocks
        case 'pre': {
            const codeEl = $(el).find('code');
            const codeText = codeEl.length ? codeEl.text() : $(el).text();
            const langClass = (codeEl.attr('class') || '').match(/language-(\w+)/);
            const lang = langClass ? langClass[1] : '';
            return `\n\n\`\`\`${lang}\n${codeText.trim()}\n\`\`\`\n\n`;
        }

        // Blockquote
        case 'blockquote': {
            const text = children.trim();
            if (!text) return '';
            const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
            return `\n\n${quoted}\n\n`;
        }

        // Tables
        case 'table': {
            const rows = [];
            $(el).find('tr').each((i, tr) => {
                const cells = [];
                $(tr).find('th, td').each((j, cell) => {
                    cells.push(toMarkdown($, cell, opts, baseUrl).trim().replace(/\|/g, '\\|'));
                });
                rows.push(cells);
            });
            if (rows.length === 0) return '';

            const colCount = Math.max(...rows.map(r => r.length));
            rows.forEach(row => {
                while (row.length < colCount) row.push('');
            });

            let md = '\n\n';
            md += `| ${rows[0].join(' | ')} |\n`;
            md += `| ${rows[0].map(() => '---').join(' | ')} |\n`;
            for (let i = 1; i < rows.length; i++) {
                md += `| ${rows[i].join(' | ')} |\n`;
            }
            return md + '\n';
        }
        case 'th':
        case 'td': return children;

        // Figures
        case 'figure': {
            const caption = $(el).find('figcaption').text().trim();
            const imgMd = $(el).find('img').map((i, img) => toMarkdown($, img, opts, baseUrl)).get().join('');
            return imgMd + (caption ? `\n*${caption}*` : '');
        }

        // Default: just pass through children
        default:
            return children;
    }
}

/**
 * Clean up the generated markdown:
 * - Collapse multiple blank lines to max 2
 * - Trim leading/trailing whitespace
 */
function cleanMarkdown(md) {
    return md
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\s+/gm, line => {
            return line;
        })
        .trim();
}

/**
 * Convert HTML string to Markdown.
 *
 * @param {string} html - Raw HTML content
 * @param {string} baseUrl - Base URL for resolving relative links
 * @param {Object} [options] - Conversion options
 * @param {boolean} [options.includeLinks=true] - Include hyperlinks
 * @param {boolean} [options.includeImages=false] - Include images
 * @returns {{ markdown: string, title: string }}
 */
function htmlToMarkdown(html, baseUrl, options = {}) {
    const $ = cheerio.load(html);
    const includeLinks = options.includeLinks !== false;
    const includeImages = options.includeImages === true;

    // Extract title before removing elements
    const title = $('title').first().text().trim() || '';

    // Remove non-content elements
    $(REMOVE_SELECTORS.join(', ')).remove();

    // Find main content area
    let contentRoot = $('article').first();
    if (!contentRoot.length) contentRoot = $('main').first();
    if (!contentRoot.length) contentRoot = $('[role="main"]').first();
    if (!contentRoot.length) contentRoot = $('body').first();

    const opts = { includeLinks, includeImages };
    const rawMarkdown = contentRoot.contents().map((i, el) =>
        toMarkdown($, el, opts, baseUrl)
    ).get().join('');

    const markdown = cleanMarkdown(rawMarkdown);

    return { markdown, title };
}

module.exports = { htmlToMarkdown, cleanMarkdown };
