// Render a Bee Flow certificate to PNG (LinkedIn og:image, 1200×630) or a print
// PDF (A4 landscape), reusing the shared Playwright pool (browserProvider) and the
// inline HTML template. Mirrors the webpageExport.js / webpageRender.js patterns.

const browserProvider = require('./browserProvider');
const { buildCertificateHtml } = require('./certificateTemplate');

async function renderCertificatePng(record, { verifyUrl = null } = {}) {
    const html = buildCertificateHtml(record, { verifyUrl, variant: 'share' });
    return browserProvider.withContext(
        { viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 },
        async (context) => {
            const page = await context.newPage();
            await page.setContent(html, { waitUntil: 'networkidle' });
            return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
        },
    );
}

async function renderCertificatePdf(record, { verifyUrl = null } = {}) {
    const html = buildCertificateHtml(record, { verifyUrl, variant: 'print' });
    return browserProvider.withContext({}, async (context) => {
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'networkidle' });
        return page.pdf({ format: 'A4', landscape: true, printBackground: true });
    });
}

module.exports = { renderCertificatePng, renderCertificatePdf };
