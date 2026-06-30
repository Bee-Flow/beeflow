/**
 * Webpage Export — server-side PDF rendering of a webpage via Playwright.
 *
 * POST /api/webpages/:id/export/pdf — composes the same inlined HTML the
 *   in-app preview uses (style + script inlined into the document) and
 *   pipes it through headless Chromium to a PDF.
 *
 * The composition mirrors the frontend `composeWebpageDocument` util — see
 * agent-hub/src/utils/composeWebpageDocument.js. The downloaded zip flow uses
 * a different composition (external <link> + <script> refs); see
 * agent-hub/src/utils/downloadWebpageZip.js.
 */

const express = require('express');
const router = express.Router();

const webpageStore = require('../stores/webpageStore');

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Compose a complete HTML document from the three slots, inlining the CSS
 * and JS. Mirrors the frontend `composeWebpageDocument.js` util.
 */
function composeInlinedHtml({ html, css, js }) {
    const safeHtml = html && html.trim() ? html : '<!DOCTYPE html><html><head></head><body></body></html>';
    const styleTag = css ? `<style>\n${css}\n</style>` : '';
    const scriptTag = js ? `<script>\n${js}\n<\/script>` : '';

    if (/<head[^>]*>/i.test(safeHtml)) {
        let out = safeHtml.replace(/<head([^>]*)>/i, `<head$1>\n${styleTag}`);
        if (/<\/body>/i.test(out)) {
            out = out.replace(/<\/body>/i, `${scriptTag}\n</body>`);
        } else {
            out += scriptTag;
        }
        return out;
    }
    return `<!DOCTYPE html><html><head>${styleTag}</head><body>${safeHtml}${scriptTag}</body></html>`;
}

const browserProvider = require('../services/browserProvider');

router.post('/:id/export/pdf', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const id = req.params.id;

    try {
        const wp = await webpageStore.getWebpage(id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        // PDF export inlines only the three primary slots. A react-mui project's
        // app lives in src/*.jsx extras and needs the in-browser esbuild build,
        // so it would render blank here — refuse with a clear message rather
        // than ship an empty PDF. (Supported once the server-side react bundle
        // path lands — see the refactor plan, WS-C/WS-G.)
        const { resolveFramework } = require('../integrations/webpageFramework');
        if (resolveFramework(wp) === 'react-mui') {
            return res.status(400).json({ error: 'PDF export is not available for React + Material UI pages yet. Use Download ZIP to export the app instead.' });
        }

        const files = await webpageStore.readAllSlots(userId, id);
        const exportHTML = composeInlinedHtml(files);
        const title = wp.name || 'Webpage';

        console.log(`[WebpageExport] Starting PDF export for "${title}"`);
        const startTime = Date.now();

        const pdfBuffer = await browserProvider.withContext({}, async (context) => {
            const page = await context.newPage();
            await page.setContent(exportHTML, { waitUntil: 'networkidle' });
            // Settle JS-driven content (animations, font loads, fetch-driven layouts).
            await page.waitForTimeout(800);
            return page.pdf({
                format: 'Letter',
                margin: { top: '0in', right: '0in', bottom: '0in', left: '0in' },
                printBackground: true,
            });
        });

        const duration = Date.now() - startTime;
        console.log(`[WebpageExport] PDF generated: ${(pdfBuffer.length / 1024).toFixed(1)} KB in ${duration}ms`);

        const safeFilename = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'webpage';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);
    } catch (err) {
        console.error('[WebpageExport] PDF generation failed:', err);
        res.status(500).json({ error: 'PDF generation failed: ' + err.message });
    }
});

module.exports = router;
