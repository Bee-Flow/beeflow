/**
 * Slides Export Routes — server-side PDF generation via Playwright.
 *
 * POST /api/slides/:id/export/pdf  — render slides as HTML → PDF (landscape, one per page)
 *
 * Mirrors notebookExport.js but renders slides in landscape layout.
 */

const express = require('express');
const router = express.Router();

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ── PDF Export (Playwright) ─────────────────────────────────────────────────

router.post('/:id/export/pdf', requireAuth, async (req, res) => {
    const { slides, title = 'Slides', theme = 'corporate' } = req.body;
    if (!slides || !Array.isArray(slides) || slides.length === 0) {
        return res.status(400).json({ error: 'No slides provided' });
    }

    let playwright;
    try {
        playwright = require('playwright');
    } catch (e) {
        return res.status(500).json({ error: 'PDF export requires Playwright. Install with: npm install playwright && npx playwright install chromium' });
    }

    let browser = null;
    try {
        console.log(`[SlidesExport] Starting PDF export: "${title}" (${slides.length} slides)`);
        const startTime = Date.now();

        // Build HTML for all slides
        const slidesHtml = slides.map((slide, idx) => {
            const bg = slide.background || getThemeBackground(theme, slide.layout);
            const elements = (slide.elements || []).map(el => {
                const pos = el.position || {};
                const style = el.style || {};
                const themeColors = getThemeColors(theme);

                let elStyle = `
                    position: absolute;
                    left: ${pos.x || 0}%;
                    top: ${pos.y || 0}%;
                    width: ${pos.width || 80}%;
                    height: ${pos.height || 20}%;
                    font-size: ${style.fontSize || '18px'};
                    font-weight: ${style.fontWeight || 'normal'};
                    text-align: ${style.textAlign || 'left'};
                    color: ${style.color || themeColors.text};
                    line-height: 1.4;
                    overflow: hidden;
                    word-wrap: break-word;
                `;

                if (el.type === 'image') {
                    return `<div style="${elStyle}"><img src="${el.content}" style="max-width:100%;max-height:100%;object-fit:contain;" /></div>`;
                }
                return `<div style="${elStyle}">${el.content || ''}</div>`;
            }).join('\n');

            return `
                <div class="slide" style="
                    width: 1280px; height: 720px; position: relative;
                    background: ${bg}; overflow: hidden;
                    page-break-after: always; box-sizing: border-box;
                ">
                    ${elements}
                    <div style="position:absolute; bottom:12px; right:20px; font-size:11px; color:rgba(0,0,0,0.3);">${idx + 1}</div>
                </div>
            `;
        }).join('\n');

        const exportHTML = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', -apple-system, sans-serif; }
        .slide {
            margin: 0;
            padding: 0;
        }
        .slide ul, .slide ol { padding-left: 1.5em; }
        .slide li { margin-bottom: 0.3em; }
        @media print {
            .slide { page-break-after: always; }
        }
    </style>
</head>
<body>
    ${slidesHtml}
</body>
</html>`;

        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent(exportHTML, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        const pdfBuffer = await page.pdf({
            width: '1280px',
            height: '720px',
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            printBackground: true,
            landscape: true,
        });

        const duration = Date.now() - startTime;
        console.log(`[SlidesExport] PDF generated: ${(pdfBuffer.length / 1024).toFixed(1)} KB in ${duration}ms`);

        const safeFilename = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'slides';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);
    } catch (err) {
        console.error('[SlidesExport] PDF generation failed:', err);
        res.status(500).json({ error: 'PDF generation failed: ' + err.message });
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { }
        }
    }
});

// ── Theme helpers ───────────────────────────────────────────────────────────

function getThemeColors(theme) {
    const themes = {
        corporate: { text: '#1a1a2e', textLight: '#64748b', bg: '#ffffff', primary: '#1e3a5f', accent: '#4a90d9' },
        dark: { text: '#e2e8f0', textLight: '#94a3b8', bg: '#0f172a', primary: '#6366f1', accent: '#a78bfa' },
        creative: { text: '#1a1a2e', textLight: '#6b7280', bg: '#ffffff', primary: '#ec4899', accent: '#f59e0b' },
        minimal: { text: '#111827', textLight: '#9ca3af', bg: '#ffffff', primary: '#374151', accent: '#6b7280' },
        gradient: { text: '#ffffff', textLight: '#e0e0e0', bg: '#1a1a2e', primary: '#6366f1', accent: '#ec4899' },
        academic: { text: '#1e293b', textLight: '#64748b', bg: '#fefce8', primary: '#92400e', accent: '#b45309' },
        tech: { text: '#e2e8f0', textLight: '#94a3b8', bg: '#0a0a0a', primary: '#22d3ee', accent: '#10b981' },
        nature: { text: '#1a1a2e', textLight: '#6b7280', bg: '#f0fdf4', primary: '#15803d', accent: '#65a30d' },
    };
    return themes[theme] || themes.corporate;
}

function getThemeBackground(theme, layout) {
    const colors = getThemeColors(theme);
    if (layout === 'title' || layout === 'section') {
        const gradients = {
            corporate: 'linear-gradient(135deg, #1e3a5f 0%, #2d5a8e 100%)',
            dark: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)',
            creative: 'linear-gradient(135deg, #ec4899 0%, #f59e0b 100%)',
            minimal: '#f9fafb',
            gradient: 'linear-gradient(135deg, #6366f1 0%, #ec4899 50%, #f59e0b 100%)',
            academic: 'linear-gradient(135deg, #92400e 0%, #b45309 100%)',
            tech: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
            nature: 'linear-gradient(135deg, #15803d 0%, #65a30d 100%)',
        };
        return gradients[theme] || gradients.corporate;
    }
    return colors.bg;
}

module.exports = router;
