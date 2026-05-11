/**
 * Notebook Export Routes — server-side PDF (Playwright) & DOCX generation.
 *
 * POST /api/notebooks/:id/export/pdf   — render HTML → PDF via headless Chromium
 * POST /api/notebooks/:id/export/docx  — convert HTML → native .docx
 *
 * Both endpoints expect { content: "<html>", title: "..." } in the request body.
 * Images should already be embedded as base64 data URIs by the client.
 */

const express = require('express');
const router = express.Router();
const { buildExportHTML, cleanContentForExport } = require('../templates/exportTemplate');
const houseStyleStore = require('../stores/houseStyleStore');
const userStore = require('../stores/userStore');

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Pull the user's org id from session/user record. Returns null when unknown.
async function userOrgId(req) {
    const u = req.session?.user;
    if (u?.organizationId) return u.organizationId;
    if (!u?.id) return null;
    try {
        const full = await userStore.getUser(u.id);
        return full?.organizationId || null;
    } catch (_) {
        return null;
    }
}

/**
 * Resolve the house style to apply to an export.
 *   - explicit `houseStyleId === 'none'`  → no style
 *   - explicit `houseStyleId === '<id>'`  → that style if it belongs to user's org
 *   - otherwise                           → the org's default style (or null)
 */
async function resolveHouseStyle(req, houseStyleId) {
    if (houseStyleId === 'none') return null;
    const orgId = await userOrgId(req);
    if (!orgId) return null;
    if (houseStyleId) {
        return await houseStyleStore.getById(houseStyleId, orgId).catch(() => null);
    }
    return await houseStyleStore.getDefaultForOrg(orgId).catch(() => null);
}

/**
 * Build a CSS block + html-to-docx options object from a house style.
 * Returns sensible defaults when style is null so callers don't branch.
 */
function buildDocxStylingFromHouseStyle(style) {
    const meta = style?.styleMeta || {};
    const defaultFont = meta.defaultFont || 'Calibri';
    const defaultSize = Number(meta.defaultFontSize) || 11;
    const margins = meta.margins || { top: 1440, right: 1440, bottom: 1440, left: 1440 };
    const h1 = meta.headings?.h1 || { font: defaultFont, size: 20, bold: true, color: '#111111' };
    const h2 = meta.headings?.h2 || { font: defaultFont, size: 16, bold: true, color: '#1e293b' };
    const h3 = meta.headings?.h3 || { font: defaultFont, size: 13, bold: true, color: '#334155' };

    const css = `
        body { font-family: "${defaultFont}", Calibri, Arial, sans-serif; font-size: ${defaultSize}pt; line-height: 1.5; color: #1a1a1a; }
        h1 { font-family: "${h1.font || defaultFont}", sans-serif; font-size: ${h1.size}pt; font-weight: ${h1.bold ? 'bold' : 'normal'}; color: ${h1.color || '#111111'}; margin-top: 18pt; margin-bottom: 8pt; }
        h2 { font-family: "${h2.font || defaultFont}", sans-serif; font-size: ${h2.size}pt; font-weight: ${h2.bold ? 'bold' : 'normal'}; color: ${h2.color || '#1e293b'}; margin-top: 14pt; margin-bottom: 6pt; }
        h3 { font-family: "${h3.font || defaultFont}", sans-serif; font-size: ${h3.size}pt; font-weight: ${h3.bold ? 'bold' : 'normal'}; color: ${h3.color || '#334155'}; margin-top: 12pt; margin-bottom: 4pt; }
        p { margin-bottom: 6pt; }
        table { width: 100%; border-collapse: collapse; margin: 8pt 0; }
        th, td { border: 1pt solid #999; padding: 4pt 8pt; vertical-align: top; text-align: left; }
        th { background-color: #f0f0f0; font-weight: bold; }
        blockquote { border-left: 3pt solid ${meta.accents?.secondary || '#3b82f6'}; padding: 6pt 12pt; margin: 8pt 0; background: #f8f9fa; }
        code { font-family: Consolas, monospace; font-size: 9pt; background: #f1f5f9; padding: 1pt 3pt; }
        pre { background: #f5f5f5; padding: 10pt; font-family: Consolas, monospace; font-size: 9pt; margin: 8pt 0; border: 1pt solid #ddd; }
        pre code { background: none; padding: 0; }
        ul, ol { margin-left: 0.4in; margin-bottom: 6pt; }
        li { margin-bottom: 2pt; }
        img { max-width: 100%; }
    `;

    const opts = {
        margin: margins,
        font: defaultFont,
        fontSize: defaultSize * 2, // html-to-docx wants half-points
    };

    // Header / footer best-effort text injection. html-to-docx accepts these
    // as HTML fragments wrapped in <body>…</body>; we keep them minimal.
    if (meta.header?.text) {
        opts.header = true;
        opts.headerType = 'default';
        opts.headerHTML = `<p style="font-family:'${defaultFont}',sans-serif;font-size:${Math.max(8, defaultSize - 2)}pt;color:#555">${escapeHtml(meta.header.text)}</p>`;
    }
    if (meta.footer?.text) {
        opts.footer = true;
        opts.footerHTML = `<p style="font-family:'${defaultFont}',sans-serif;font-size:${Math.max(8, defaultSize - 2)}pt;color:#555">${escapeHtml(meta.footer.text)}</p>`;
    }

    return { css, opts };
}

// ── PDF Export (Playwright) ─────────────────────────────────────────────────

router.post('/:id/export/pdf', requireAuth, async (req, res) => {
    const { content, title = 'Notebook' } = req.body;
    if (!content) return res.status(400).json({ error: 'No content provided' });

    const author = req.session.user.name || req.session.user.email || '';

    let playwright;
    try {
        playwright = require('playwright');
    } catch (e) {
        console.error('[Export] Playwright not available, falling back to basic PDF');
        return res.status(500).json({ error: 'PDF export requires Playwright. Install with: npm install playwright && npx playwright install chromium' });
    }

    let browser = null;
    try {
        console.log(`[Export] Starting PDF export for notebook ${req.params.id}: "${title}"`);
        const startTime = Date.now();

        // Clean and wrap content in professional template
        const cleanedContent = cleanContentForExport(content);
        const exportHTML = buildExportHTML(cleanedContent, { title, author });

        // Launch headless browser
        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext();
        const page = await context.newPage();

        // Set content (base64 images are already embedded)
        await page.setContent(exportHTML, { waitUntil: 'networkidle' });

        // Wait for Google Fonts + Mermaid diagrams to render
        await page.waitForTimeout(1500);

        // Wait for mermaid diagrams to finish rendering (if any exist)
        try {
            await page.waitForFunction(() => {
                // Check if any unrendered mermaid divs remain
                const remaining = document.querySelectorAll('div[data-type="mermaid-diagram"]');
                return remaining.length === 0;
            }, { timeout: 10000 });
        } catch {
            // If mermaid rendering takes too long, continue with PDF anyway
            console.warn('[Export] Mermaid rendering timed out, proceeding with PDF');
        }

        // Generate PDF with proper settings
        const pdfBuffer = await page.pdf({
            format: 'Letter',
            margin: {
                top: '0.75in',
                right: '0.85in',
                bottom: '0.9in',
                left: '0.85in'
            },
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: `
                <div style="font-size: 8px; color: #999; width: 100%; padding: 0 0.85in; display: flex; justify-content: space-between;">
                    <span>${title.replace(/"/g, '&quot;').replace(/</g, '&lt;')}</span>
                    <span></span>
                </div>
            `,
            footerTemplate: `
                <div style="font-size: 8px; color: #bbb; width: 100%; padding: 0 0.85in; display: flex; justify-content: space-between;">
                    <span>Generated by Bee Flow</span>
                    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
                </div>
            `,
        });

        const duration = Date.now() - startTime;
        console.log(`[Export] PDF generated: ${(pdfBuffer.length / 1024).toFixed(1)} KB in ${duration}ms`);

        // Send PDF response
        const safeFilename = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'notebook';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);

    } catch (err) {
        console.error('[Export] PDF generation failed:', err);
        res.status(500).json({ error: 'PDF generation failed: ' + err.message });
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { }
        }
    }
});

// ── DOCX Export (html-to-docx) ──────────────────────────────────────────────

router.post('/:id/export/docx', requireAuth, async (req, res) => {
    const { content, title = 'Notebook', houseStyleId } = req.body;
    if (!content) return res.status(400).json({ error: 'No content provided' });

    try {
        console.log(`[Export] Starting DOCX export for notebook ${req.params.id}: "${title}"`);
        const startTime = Date.now();

        let HTMLtoDOCX;
        try {
            HTMLtoDOCX = require('html-to-docx');
            // Handle both default and named exports
            if (HTMLtoDOCX.default) HTMLtoDOCX = HTMLtoDOCX.default;
        } catch (e) {
            return res.status(500).json({ error: 'html-to-docx not installed. Run: npm install html-to-docx' });
        }

        // Resolve which house style to apply (explicit id, org default, or none).
        const houseStyle = await resolveHouseStyle(req, houseStyleId);
        const { css, opts: styleOpts } = buildDocxStylingFromHouseStyle(houseStyle);
        if (houseStyle) console.log(`[Export] Applying house style "${houseStyle.name}" (${houseStyle.id})`);

        // Clean content for Word export
        const cleanedContent = cleanContentForExport(content);

        // Debug: log font-family spans in input vs cleaned
        const inputFontMatches = (content.match(/font-family/gi) || []).length;
        const cleanedFontMatches = (cleanedContent.match(/font-family/gi) || []).length;
        console.log(`[Export] DOCX font-family spans: input=${inputFontMatches}, afterClean=${cleanedFontMatches}`);
        if (inputFontMatches > 0) {
            // Log a sample span for debugging
            const sampleMatch = content.match(/<span[^>]*style="[^"]*font-family[^"]*"[^>]*>[^<]{0,50}/i);
            console.log(`[Export] Sample font span:`, sampleMatch?.[0] || 'none found');
        }

        // Wrap in a minimal HTML structure that html-to-docx expects
        const htmlForDocx = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
    ${cleanedContent}
</body>
</html>`;

        const docxBuffer = await HTMLtoDOCX(htmlForDocx, null, {
            table: { row: { cantSplit: true } },
            footer: true,
            pageNumber: true,
            title: title,
            ...styleOpts,
        });

        const duration = Date.now() - startTime;
        const buffer = Buffer.from(docxBuffer);
        console.log(`[Export] DOCX generated: ${(buffer.length / 1024).toFixed(1)} KB in ${duration}ms`);

        const safeFilename = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'notebook';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.docx"`);
        res.setHeader('Content-Length', buffer.length);
        res.send(buffer);

    } catch (err) {
        console.error('[Export] DOCX generation failed:', err);
        res.status(500).json({ error: 'DOCX generation failed: ' + err.message });
    }
});

// ── SignRequest Export (PDF → e-Signature) ──────────────────────────────────

router.post('/:id/export/signrequest', requireAuth, async (req, res) => {
    const { content, title = 'Notebook', signers, subject, message } = req.body;
    if (!content) return res.status(400).json({ error: 'No content provided' });
    if (!signers?.length) return res.status(400).json({ error: 'At least one signer is required' });

    const userId = req.session.user.id;
    const author = req.session.user.name || req.session.user.email || '';

    let playwright;
    try {
        playwright = require('playwright');
    } catch (e) {
        return res.status(500).json({ error: 'PDF export requires Playwright. Install with: npm install playwright && npx playwright install chromium' });
    }

    let browser = null;
    try {
        console.log(`[Export] Starting SignRequest PDF export for notebook ${req.params.id}: "${title}"`);
        const startTime = Date.now();

        // Clean and wrap content in professional template
        const cleanedContent = cleanContentForExport(content);
        const exportHTML = buildExportHTML(cleanedContent, { title, author });

        // Launch headless browser
        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext();
        const page = await context.newPage();

        await page.setContent(exportHTML, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Wait for mermaid diagrams
        try {
            await page.waitForFunction(() => {
                const remaining = document.querySelectorAll('div[data-type="mermaid-diagram"]');
                return remaining.length === 0;
            }, { timeout: 10000 });
        } catch {
            console.warn('[Export] Mermaid rendering timed out, proceeding with PDF');
        }

        // Generate PDF
        const pdfBuffer = await page.pdf({
            format: 'Letter',
            margin: { top: '0.75in', right: '0.85in', bottom: '0.9in', left: '0.85in' },
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: `
                <div style="font-size: 8px; color: #999; width: 100%; padding: 0 0.85in; display: flex; justify-content: space-between;">
                    <span>${title.replace(/"/g, '&quot;').replace(/</g, '&lt;')}</span>
                    <span></span>
                </div>
            `,
            footerTemplate: `
                <div style="font-size: 8px; color: #bbb; width: 100%; padding: 0 0.85in; display: flex; justify-content: space-between;">
                    <span>Generated by Bee Flow</span>
                    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
                </div>
            `,
        });

        const pdfDuration = Date.now() - startTime;
        console.log(`[Export] PDF for SignRequest: ${(pdfBuffer.length / 1024).toFixed(1)} KB in ${pdfDuration}ms`);

        // Convert to base64 and send to SignRequest
        const pdfBase64 = pdfBuffer.toString('base64');
        const safeFilename = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'notebook';

        const { sendPdfForSigning } = require('../integrations/signrequestTools');
        const result = await sendPdfForSigning(userId, {
            pdfBase64,
            fileName: `${safeFilename}.pdf`,
            signers,
            subject,
            message,
        });

        console.log(`[Export] SignRequest sent successfully for notebook ${req.params.id}`);

        res.json({
            success: true,
            message: `Document sent for signing to ${signers.length} signer(s).`,
            documentUuid: result?.document?.uuid,
            signrequestUuid: result?.uuid,
            status: result?.document?.status,
            signers: result?.signers?.map(s => ({
                email: s.email,
                name: [s.first_name, s.last_name].filter(Boolean).join(' '),
                status: s.status_display || s.status,
            })),
        });

    } catch (err) {
        console.error('[Export] SignRequest export failed:', err);
        res.status(500).json({ error: 'SignRequest export failed: ' + err.message });
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { }
        }
    }
});

// ── Nextcloud Export (PDF → WebDAV upload) ──────────────────────────────────

router.post('/:id/export/nextcloud', requireAuth, async (req, res) => {
    const { content, title = 'Notebook', folder } = req.body;
    if (!content) return res.status(400).json({ error: 'No content provided' });

    const userId = req.session.user.id;
    const author = req.session.user.name || req.session.user.email || '';

    // Resolve Nextcloud credentials up front so we don't burn time rendering a
    // PDF only to fail at upload.
    const configStore = require('../stores/configStore');
    const userStore = require('../stores/userStore');

    const oauth = (await configStore.getConfig('oauth')) || {};
    const nextcloudUrl = (oauth.nextcloudUrl || '').replace(/\/+$/, '');
    if (!nextcloudUrl) return res.status(400).json({ error: 'Nextcloud URL not configured (admin → authentication).' });

    const creds = await userStore.getAppPassword(userId);
    if (!creds?.username || !creds?.password) {
        return res.status(400).json({ error: 'Nextcloud not connected. Add your username and app password in Settings → Connections.' });
    }

    let playwright;
    try {
        playwright = require('playwright');
    } catch (e) {
        return res.status(500).json({ error: 'PDF export requires Playwright. Install with: npm install playwright && npx playwright install chromium' });
    }

    let browser = null;
    try {
        console.log(`[Export] Starting Nextcloud upload for notebook ${req.params.id}: "${title}"`);
        const startTime = Date.now();

        const cleanedContent = cleanContentForExport(content);
        const exportHTML = buildExportHTML(cleanedContent, { title, author });

        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent(exportHTML, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        try {
            await page.waitForFunction(() => document.querySelectorAll('div[data-type="mermaid-diagram"]').length === 0, { timeout: 10000 });
        } catch {
            console.warn('[Export] Mermaid rendering timed out, proceeding with PDF');
        }
        const pdfBuffer = await page.pdf({
            format: 'Letter',
            margin: { top: '0.75in', right: '0.85in', bottom: '0.9in', left: '0.85in' },
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: `<div style="font-size: 8px; color: #999; width: 100%; padding: 0 0.85in; display: flex; justify-content: space-between;"><span>${title.replace(/"/g, '&quot;').replace(/</g, '&lt;')}</span><span></span></div>`,
            footerTemplate: `<div style="font-size: 8px; color: #bbb; width: 100%; padding: 0 0.85in; display: flex; justify-content: space-between;"><span>Generated by Bee Flow</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
        });

        console.log(`[Export] PDF rendered for Nextcloud upload: ${(pdfBuffer.length / 1024).toFixed(1)} KB in ${Date.now() - startTime}ms`);

        // ── Upload via WebDAV ──
        const auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
        const davRoot = `${nextcloudUrl}/remote.php/dav/files/${encodeURIComponent(creds.username)}`;

        // Ensure parent folder(s) exist. Nextcloud MKCOL only creates one level
        // at a time, so we walk the path and ignore "already exists" (405).
        const targetFolderRaw = (folder || '/BeeFlow/Notebooks').replace(/^\/+|\/+$/g, '');
        const folderSegments = targetFolderRaw.split('/').filter(Boolean);
        let walked = '';
        for (const seg of folderSegments) {
            walked += '/' + encodeURIComponent(seg);
            const mkRes = await fetch(`${davRoot}${walked}`, {
                method: 'MKCOL',
                headers: { 'Authorization': auth },
                signal: AbortSignal.timeout(15000),
            });
            if (mkRes.status === 401) return res.status(502).json({ error: 'Nextcloud rejected credentials. Re-save your app password.' });
            if (mkRes.status !== 201 && mkRes.status !== 405 /* already exists */) {
                const text = await mkRes.text().catch(() => '');
                console.warn(`[Export/Nextcloud] MKCOL ${walked} returned ${mkRes.status}: ${text.slice(0, 200)}`);
            }
        }

        // Avoid clobbering: if a file with the same name already exists, append a
        // timestamp suffix so users can keep multiple revisions.
        const safeBase = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'notebook';
        const fileName = `${safeBase}.pdf`;
        const targetUrl = `${davRoot}${walked}/${encodeURIComponent(fileName)}`;

        const headRes = await fetch(targetUrl, { method: 'HEAD', headers: { 'Authorization': auth }, signal: AbortSignal.timeout(10000) });
        let finalUrl = targetUrl;
        let finalName = fileName;
        if (headRes.status === 200) {
            const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
            finalName = `${safeBase} (${stamp}).pdf`;
            finalUrl = `${davRoot}${walked}/${encodeURIComponent(finalName)}`;
        }

        const putRes = await fetch(finalUrl, {
            method: 'PUT',
            headers: { 'Authorization': auth, 'Content-Type': 'application/pdf' },
            body: pdfBuffer,
            signal: AbortSignal.timeout(60000),
        });

        if (putRes.status === 401) return res.status(502).json({ error: 'Nextcloud rejected credentials.' });
        if (putRes.status !== 201 && putRes.status !== 204) {
            const text = await putRes.text().catch(() => '');
            return res.status(502).json({ error: `Upload failed (${putRes.status}): ${text.slice(0, 200)}` });
        }

        const relativePath = `/${targetFolderRaw}/${finalName}`;
        const browserUrl = `${nextcloudUrl}/apps/files/?dir=${encodeURIComponent('/' + targetFolderRaw)}`;
        console.log(`[Export] Uploaded to Nextcloud: ${relativePath}`);

        return res.json({
            success: true,
            path: relativePath,
            fileName: finalName,
            size: pdfBuffer.length,
            folderUrl: browserUrl,
        });

    } catch (err) {
        console.error('[Export] Nextcloud upload failed:', err);
        res.status(500).json({ error: 'Nextcloud upload failed: ' + err.message });
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { }
        }
    }
});

module.exports = router;
