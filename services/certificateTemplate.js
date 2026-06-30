// Self-contained HTML for a Bee Flow AI certificate. All CSS inline, no external
// fetches — rendered to PNG/PDF by certificateRenderer.js via Playwright.
//
// Palette is strictly honey/amber + ink (NO purple/violet/indigo anywhere):
//   cream #FFFDF7 · honey wash #FFF3D6 · amber #F59E0B · deep honey #B45309 ·
//   gold foil #D4A017 · ink #1A1A1A · grey #6B7280.

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    } catch (_) { return ''; }
}

// A small hand-drawn honeycomb + bee mark (crisp at any size, ~1KB).
const LOGO = `
<svg width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polygon points="30,4 52,17 52,43 30,56 8,43 8,17" fill="#FEF3C7" stroke="#D4A017" stroke-width="2.5"/>
  <ellipse cx="30" cy="33" rx="11" ry="8" fill="#1A1A1A"/>
  <path d="M30 25c-6 0-11 3.6-11 8s5 8 11 8 11-3.6 11-8-5-8-11-8z" fill="#F59E0B"/>
  <rect x="19" y="29.5" width="22" height="2.6" fill="#1A1A1A"/>
  <rect x="20.5" y="35" width="19" height="2.6" fill="#1A1A1A"/>
  <ellipse cx="22" cy="22" rx="6" ry="4" fill="#FFFFFF" stroke="#D4A017" stroke-width="1" opacity="0.92" transform="rotate(-25 22 22)"/>
  <ellipse cx="38" cy="22" rx="6" ry="4" fill="#FFFFFF" stroke="#D4A017" stroke-width="1" opacity="0.92" transform="rotate(25 38 22)"/>
</svg>`;

/**
 * @param {object} record  issued certificate record (recipientName, orgName,
 *                         title, level, courses[], serial, issuedAt)
 * @param {object} opts    { verifyUrl?: string|null, variant: 'share'|'print' }
 */
function buildCertificateHtml(record, opts = {}) {
    const { verifyUrl = null, variant = 'share' } = opts;
    const courses = Array.isArray(record.courses) ? record.courses : [];
    const isPrint = variant === 'print';

    const courseItems = courses.map((c) => `
        <li>
          <span class="hex"></span>
          <span>${esc(c.title)}</span>
        </li>`).join('');

    const verifyBlock = verifyUrl
        ? `<div class="verify">Verify at <strong>${esc(verifyUrl)}</strong></div>`
        : '';

    // Share = fixed 1200×630 (og:image / LinkedIn). Print = A4 landscape.
    const pageCss = isPrint
        ? `@page { size: A4 landscape; margin: 0; } html,body { width: 297mm; height: 210mm; }`
        : `html,body { width: 1200px; height: 630px; }`;

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${pageCss}
  body {
    font-family: Georgia, 'Times New Roman', serif;
    background: radial-gradient(circle at 50% 0%, #FFF3D6 0%, #FFFDF7 60%);
    color: #1A1A1A; display: flex; align-items: center; justify-content: center;
  }
  .frame {
    position: relative; width: 92%; height: 86%;
    border: 3px solid #D4A017; border-radius: 14px;
    box-shadow: inset 0 0 0 6px #FFFDF7, inset 0 0 0 8px #F3DFA8;
    padding: ${isPrint ? '46px 64px' : '30px 56px'};
    display: flex; flex-direction: column; overflow: hidden;
  }
  /* honeycomb watermark */
  .frame::after {
    content: ''; position: absolute; inset: 0; opacity: 0.05; pointer-events: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='100' viewBox='0 0 56 100'%3E%3Cg fill='none' stroke='%23B45309' stroke-width='2'%3E%3Cpolygon points='28,2 54,17 54,49 28,64 2,49 2,17'/%3E%3C/g%3E%3C/svg%3E");
  }
  .top { display: flex; align-items: center; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand .name { font-size: 26px; font-weight: 700; letter-spacing: .3px; }
  .kicker { font-family: Helvetica, Arial, sans-serif; font-size: 12px; letter-spacing: 3px; text-transform: uppercase; color: #B45309; }
  .title { margin-top: ${isPrint ? '26px' : '14px'}; }
  .title h1 { font-size: ${isPrint ? '40px' : '34px'}; color: #B45309; font-weight: 700; }
  .chip { display: inline-block; margin-top: 8px; font-family: Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 700;
          letter-spacing: 1px; text-transform: uppercase; color: #92400E; background: #FDE9C2; border: 1px solid #E9C877; padding: 4px 12px; border-radius: 999px; }
  .recipient { margin-top: ${isPrint ? '26px' : '16px'}; }
  .recipient .lead { font-style: italic; color: #6B7280; font-size: 15px; }
  .recipient .name { font-size: ${isPrint ? '46px' : '40px'}; font-weight: 700; color: #1A1A1A; line-height: 1.1; margin-top: 4px; }
  .recipient .org { color: #6B7280; font-size: 15px; margin-top: 4px; }
  .body { margin-top: ${isPrint ? '20px' : '12px'}; }
  .body .lead { color: #6B7280; font-size: 14px; font-family: Helvetica, Arial, sans-serif; }
  ul.courses { list-style: none; display: flex; flex-wrap: wrap; gap: 6px 26px; margin-top: 8px; }
  ul.courses li { display: flex; align-items: center; gap: 8px; font-size: 15px; font-family: Helvetica, Arial, sans-serif; }
  .hex { width: 10px; height: 11px; flex: 0 0 auto; background: #F59E0B;
         clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%); }
  .foot { margin-top: auto; display: flex; align-items: flex-end; justify-content: space-between; font-family: Helvetica, Arial, sans-serif; }
  .foot .meta { font-size: 12.5px; color: #6B7280; line-height: 1.5; }
  .foot .meta strong { color: #1A1A1A; }
  .foot .issuer { text-align: right; font-size: 11px; color: #6B7280; line-height: 1.5; max-width: 320px; }
  .foot .issuer .sig { font-family: Georgia, serif; font-style: italic; font-size: 18px; color: #1A1A1A; border-top: 1.5px solid #1A1A1A; padding-top: 4px; margin-bottom: 6px; display: inline-block; }
  .verify { margin-top: 6px; font-size: 11px; color: #92400E; }
</style></head>
<body>
  <div class="frame">
    <div class="top">
      <div class="brand">${LOGO}<span class="name">Bee&nbsp;Flow</span></div>
      <div class="kicker">Certificate&nbsp;of&nbsp;Completion</div>
    </div>

    <div class="title">
      <h1>${esc(record.title)}</h1>
      ${record.level ? `<span class="chip">${esc(record.level)}</span>` : ''}
    </div>

    <div class="recipient">
      <div class="lead">This certifies that</div>
      <div class="name">${esc(record.recipientName)}</div>
      ${record.orgName ? `<div class="org">of ${esc(record.orgName)}</div>` : ''}
    </div>

    <div class="body">
      <div class="lead">has successfully completed the following Bee Flow Academy courses:</div>
      <ul class="courses">${courseItems}</ul>
    </div>

    <div class="foot">
      <div class="meta">
        Issued <strong>${esc(fmtDate(record.issuedAt))}</strong><br/>
        Serial <strong>${esc(record.serial)}</strong>
        ${verifyBlock}
      </div>
      <div class="issuer">
        <span class="sig">Bee&nbsp;Flow</span><br/>
        Bee Flow B.V. · Bovenkerkerweg 6, 1185 XE Amstelveen<br/>
        info@beeflow.nl
      </div>
    </div>
  </div>
</body></html>`;
}

module.exports = { buildCertificateHtml };
