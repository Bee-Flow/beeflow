/**
 * House Style Extractor
 *
 * Reads a Word .docx (which is a ZIP) and extracts styling that we can
 * re-apply when exporting a Notebook to .docx:
 *
 *   - default body font + size
 *   - heading 1/2/3 styling (font, size, color, bold)
 *   - page margins from the document's sectPr
 *   - optional header/footer with embedded logo (best-effort, base64)
 *   - accent colors from the theme
 *
 * Everything is best-effort. Missing fields fall back to sensible defaults
 * matching the existing Calibri/11pt baseline so the export route can build
 * a stylesheet without null checks.
 */

const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const DEFAULTS = Object.freeze({
    defaultFont: 'Calibri',
    defaultFontSize: 11,        // points
    lineSpacing: 1.5,
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, // twips
    headings: {
        h1: { font: null, size: 20, bold: true, color: '#111111' },
        h2: { font: null, size: 16, bold: true, color: '#1e293b' },
        h3: { font: null, size: 13, bold: true, color: '#334155' },
    },
    accents: { primary: '#1e293b', secondary: '#3b82f6' },
    header: null,
    footer: null,
    toneDescription: '',
});

function parser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseTagValue: false,
        parseAttributeValue: false,
        allowBooleanAttributes: true,
        trimValues: true,
    });
}

function asArray(v) {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
}

function pickFirst(node, ...names) {
    for (const n of names) {
        if (node && node[n] !== undefined) return node[n];
    }
    return undefined;
}

// styles.xml stores sizes as half-points (sz value 22 = 11pt).
function halfPointToPt(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return undefined;
    return Math.round(n / 2);
}

function parseColor(c) {
    if (!c || typeof c !== 'string') return undefined;
    if (c.toLowerCase() === 'auto') return undefined;
    if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c.toLowerCase()}`;
    return undefined;
}

function readRunProps(rPr) {
    if (!rPr) return {};
    const out = {};
    const fonts = rPr['w:rFonts'];
    if (fonts) {
        out.font = pickFirst(fonts, '@_w:ascii', '@_w:hAnsi', '@_w:cs');
    }
    const sz = rPr['w:sz'];
    if (sz) {
        out.size = halfPointToPt(sz['@_w:val']);
    }
    const color = rPr['w:color'];
    if (color) {
        out.color = parseColor(color['@_w:val']);
    }
    if (rPr['w:b'] !== undefined) {
        const val = rPr['w:b']['@_w:val'];
        out.bold = val === undefined || val === 'true' || val === '1';
    }
    return out;
}

function extractStylesXml(stylesXml) {
    const p = parser();
    const doc = p.parse(stylesXml);
    const stylesNode = doc?.['w:styles'];
    if (!stylesNode) return {};

    // Default doc settings — w:docDefaults → w:rPrDefault → w:rPr
    const defaults = stylesNode['w:docDefaults']?.['w:rPrDefault']?.['w:rPr'];
    const defaultRun = readRunProps(defaults);

    // Heading styles — look up by styleId (Heading1, Heading2, Heading3)
    const styles = asArray(stylesNode['w:style']);
    const byId = {};
    for (const s of styles) {
        const id = s['@_w:styleId'];
        if (id) byId[id] = s;
    }

    function readHeading(id) {
        const s = byId[id];
        if (!s) return null;
        // styleId Heading1 may inherit from itself via w:basedOn — for MVP we
        // only read its own rPr; the inherited body font comes from defaults.
        const props = readRunProps(s['w:rPr']);
        return Object.keys(props).length ? props : null;
    }

    return {
        defaultRun,
        h1: readHeading('Heading1') || readHeading('heading 1') || readHeading('Kop1'),
        h2: readHeading('Heading2') || readHeading('heading 2') || readHeading('Kop2'),
        h3: readHeading('Heading3') || readHeading('heading 3') || readHeading('Kop3'),
    };
}

function extractDocumentXml(documentXml) {
    const p = parser();
    const doc = p.parse(documentXml);
    const sectPr = doc?.['w:document']?.['w:body']?.['w:sectPr']
        || doc?.['w:document']?.['w:body']?.['w:p']?.[Array.isArray(doc?.['w:document']?.['w:body']?.['w:p']) ? doc?.['w:document']?.['w:body']?.['w:p'].length - 1 : 0]?.['w:pPr']?.['w:sectPr'];

    const out = { margins: null, headerRefId: null, footerRefId: null };

    if (sectPr) {
        const pgMar = sectPr['w:pgMar'];
        if (pgMar) {
            out.margins = {
                top: parseInt(pgMar['@_w:top'], 10) || DEFAULTS.margins.top,
                right: parseInt(pgMar['@_w:right'], 10) || DEFAULTS.margins.right,
                bottom: parseInt(pgMar['@_w:bottom'], 10) || DEFAULTS.margins.bottom,
                left: parseInt(pgMar['@_w:left'], 10) || DEFAULTS.margins.left,
            };
        }
        const headerRef = asArray(sectPr['w:headerReference'])[0];
        const footerRef = asArray(sectPr['w:footerReference'])[0];
        if (headerRef) out.headerRefId = headerRef['@_r:id'];
        if (footerRef) out.footerRefId = footerRef['@_r:id'];
    }

    return out;
}

function extractRelsXml(relsXml) {
    if (!relsXml) return {};
    const p = parser();
    const doc = p.parse(relsXml);
    const rels = asArray(doc?.['Relationships']?.['Relationship']);
    const out = {};
    for (const r of rels) {
        out[r['@_Id']] = { type: r['@_Type'], target: r['@_Target'] };
    }
    return out;
}

// Pull plain text from a header/footer XML — best-effort, no formatting.
function extractTextFromPart(xml) {
    if (!xml) return '';
    const p = parser();
    let doc;
    try { doc = p.parse(xml); } catch { return ''; }
    const texts = [];
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        for (const k of Object.keys(node)) {
            if (k === 'w:t') {
                const v = node[k];
                if (typeof v === 'string') texts.push(v);
                else if (v && typeof v === 'object' && v['#text']) texts.push(v['#text']);
                else asArray(v).forEach(item => {
                    if (typeof item === 'string') texts.push(item);
                    else if (item?.['#text']) texts.push(item['#text']);
                });
            } else if (typeof node[k] === 'object') {
                if (Array.isArray(node[k])) node[k].forEach(walk);
                else walk(node[k]);
            }
        }
    }
    walk(doc);
    return texts.join(' ').trim();
}

/**
 * Main entry point. Accepts a Buffer with the .docx file and returns the
 * style metadata object that's persisted in org_house_styles.style_meta.
 */
async function extract(docxBuffer) {
    const meta = JSON.parse(JSON.stringify(DEFAULTS));
    try {
        const zip = await JSZip.loadAsync(docxBuffer);

        const stylesXml    = await zip.file('word/styles.xml')?.async('string');
        const documentXml  = await zip.file('word/document.xml')?.async('string');
        const docRelsXml   = await zip.file('word/_rels/document.xml.rels')?.async('string');

        const styles = stylesXml ? extractStylesXml(stylesXml) : {};
        const docInfo = documentXml ? extractDocumentXml(documentXml) : {};
        const rels = docRelsXml ? extractRelsXml(docRelsXml) : {};

        if (styles.defaultRun?.font) meta.defaultFont = styles.defaultRun.font;
        if (styles.defaultRun?.size) meta.defaultFontSize = styles.defaultRun.size;

        for (const level of ['h1', 'h2', 'h3']) {
            if (styles[level]) {
                const h = meta.headings[level];
                if (styles[level].font)  h.font  = styles[level].font;
                if (styles[level].size)  h.size  = styles[level].size;
                if (styles[level].color) h.color = styles[level].color;
                if (styles[level].bold !== undefined) h.bold = styles[level].bold;
            }
            // Headings without their own font inherit the body font.
            if (!meta.headings[level].font) meta.headings[level].font = meta.defaultFont;
        }

        if (docInfo.margins) meta.margins = docInfo.margins;

        // Header/footer — best-effort plain text only. Real header/footer
        // injection into html-to-docx is added in a follow-up; for now we
        // record the text so the export route can fall back to text-only.
        if (docInfo.headerRefId && rels[docInfo.headerRefId]) {
            const path = `word/${rels[docInfo.headerRefId].target}`;
            const headerXml = await zip.file(path)?.async('string');
            const text = extractTextFromPart(headerXml);
            if (text) meta.header = { text };
        }
        if (docInfo.footerRefId && rels[docInfo.footerRefId]) {
            const path = `word/${rels[docInfo.footerRefId].target}`;
            const footerXml = await zip.file(path)?.async('string');
            const text = extractTextFromPart(footerXml);
            if (text) meta.footer = { text };
        }
    } catch (err) {
        console.warn('[houseStyleExtractor] extraction error:', err.message);
    }
    return meta;
}

module.exports = { extract, DEFAULTS };
