/**
 * Email Service — Gmail API sender using OAuth2 (configStore credentials)
 *
 * Provides a reusable `sendServiceEmail()` function for sending
 * customer-facing emails from the platform's configured service account.
 *
 * Transport is the Gmail REST API over HTTPS (port 443), NOT SMTP. Scaleway
 * (and most cloud hosts) block outbound SMTP (25/465/587) for anti-abuse, so
 * the App-Password/SMTP path timed out in production. OAuth2 + the Gmail API
 * runs entirely over 443 — the same path the Support inbox already uses
 * (see services/email/providerClients.js) — and survives node replacement.
 *
 * The admin connects a Google account once (Admin → Integrations → Email);
 * the resulting refresh-token blob is stored encrypted via configStore.setSecret
 * under `service_email_oauth_tokens`, and the connected address under the config
 * key `service_email_address`. Access tokens are auto-refreshed and written back.
 */

const configStore = require('../stores/configStore');

// ── OAuth token storage (encrypted at rest via configStore.setSecret) ────────

const OAUTH_TOKENS_KEY = 'service_email_oauth_tokens';

/** Load the stored Gmail OAuth token blob, or null if not connected. */
async function _loadOAuthTokens() {
    const raw = await configStore.getSecret(OAUTH_TOKENS_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

/** Persist (or clear, when blob is falsy) the Gmail OAuth token blob. */
async function _saveOAuthTokens(blob) {
    await configStore.setSecret(OAUTH_TOKENS_KEY, blob ? JSON.stringify(blob) : '');
}

/**
 * Get the current service email configuration (without exposing tokens).
 * `configured` is true only when a Google account is connected (refresh token
 * present) and an address is stored.
 * @returns {{ configured: boolean, address: string, displayName: string }}
 */
async function getServiceEmailConfig() {
    const address = await configStore.getConfig('service_email_address');
    const tokens = await _loadOAuthTokens();
    const displayName = await configStore.getConfig('service_email_display_name') || '';
    const configured = !!(address && tokens && tokens.refreshToken);
    console.log(`[EmailService] Config: address=${address || '(empty)'}, connected=${configured}, displayName=${displayName || '(empty)'}`);
    return { configured, address: address || '', displayName };
}

// ── OAuth connect lifecycle (drives Admin → Integrations → Email) ─────────────

/**
 * Build the Google consent URL for connecting the platform service account.
 * Reuses the shared Gmail OAuth client + gmail.send scope from providerClients.
 * @param {{ redirectUri: string, state: string }} opts
 * @returns {Promise<string>}
 */
async function buildConnectUrl({ redirectUri, state }) {
    const providerClients = require('../services/email/providerClients');
    return providerClients.buildAuthUrl('gmail', { redirectUri, state });
}

/**
 * Complete the OAuth connect: exchange the authorization code, store the token
 * blob + the connected Gmail address. The address Google reports IS the only
 * valid `From` for Gmail-API sends, so we trust it over any prior value.
 * @param {{ code: string, redirectUri: string }} opts
 * @returns {Promise<{ address: string }>}
 */
async function completeOAuthConnect({ code, redirectUri }) {
    const providerClients = require('../services/email/providerClients');
    const { tokens, emailAddress } = await providerClients.exchangeCode('gmail', { code, redirectUri });
    await _saveOAuthTokens(tokens);
    await configStore.setConfig('service_email_address', emailAddress || '');
    console.log(`[EmailService] Connected service email account: ${emailAddress}`);
    return { address: emailAddress };
}

/** Disconnect the service account — clears tokens and the stored address. */
async function disconnectServiceEmail() {
    await _saveOAuthTokens(null);
    await configStore.setConfig('service_email_address', '');
    console.log('[EmailService] Service email disconnected');
}

/**
 * Build a base64url-encoded RFC822 message for the Gmail API `messages.send`
 * `raw` field, using nodemailer's MailComposer (same approach as supportMailer).
 */
async function _buildRawMessage({ from, to, cc, bcc, replyTo, subject, text, html }) {
    const MailComposer = require('nodemailer/lib/mail-composer');
    const composer = new MailComposer({
        from, to, cc: cc || undefined, bcc: bcc || undefined, replyTo: replyTo || undefined,
        subject, text: text || undefined, html: html || undefined,
    });
    const msg = await new Promise((resolve, reject) => {
        composer.compile().build((err, m) => (err ? reject(err) : resolve(m)));
    });
    return msg.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Send an email using the configured service email account.
 * 
 * @param {Object} options
 * @param {string|string[]} options.to       - Recipient(s)
 * @param {string}          options.subject  - Email subject
 * @param {string}          [options.text]   - Plain-text body
 * @param {string}          [options.html]   - HTML body
 * @param {string}          [options.cc]     - CC recipients
 * @param {string}          [options.bcc]    - BCC recipients
 * @param {string}          [options.replyTo] - Reply-to address
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendServiceEmail({ to, subject, text, html, cc, bcc, replyTo }) {
    console.log(`[EmailService] sendServiceEmail — to=${to}, subject="${subject}"`);
    try {
        const address = await configStore.getConfig('service_email_address');
        const tokens = await _loadOAuthTokens();
        if (!address || !tokens || !tokens.refreshToken) {
            throw new Error('Service email is not connected. Connect a Google account in Admin → Integrations → Email.');
        }

        const { gmailClientFromTokens } = require('../services/email/providerClients');
        // Refreshed access tokens are written back so the next send reuses them.
        const gmail = await gmailClientFromTokens(tokens, (updated) => _saveOAuthTokens(updated));

        const fromName = (await configStore.getConfig('service_email_display_name')) || 'Service';
        // Gmail rewrites `From` to the authenticated account unless it's a verified
        // send-as alias, so `address` (the connected account) is the correct sender.
        const raw = await _buildRawMessage({
            from: `"${fromName}" <${address}>`,
            to: Array.isArray(to) ? to.join(', ') : to,
            cc, bcc, replyTo, subject, text, html,
        });

        console.log(`[EmailService] Sending via Gmail API from "${fromName}" <${address}> → ${to}`);
        const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

        console.log(`[EmailService] ✅ Email sent: ${sent.data.id} → ${to}`);
        return {
            success: true,
            messageId: sent.data.id,
        };
    } catch (error) {
        console.error(`[EmailService] ❌ Failed to send email:`, error.message);
        console.error(`[EmailService] Full error:`, error.stack || error);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * Send a branded invitation email.
 * @param {{ email: string, orgName: string, inviterName: string, inviteUrl: string, role?: string }} opts
 */
async function sendInvitationEmail({ email, orgName, inviterName, inviteUrl, role }) {
    const roleLabel = role && role !== 'user' ? role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';

    const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
    // PNG, not SVG: most mail clients (Gmail/Outlook) strip SVG. Served from agent-hub/public/.
    const logoUrl = `${clientHost}/bee-flow-logo.png`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:48px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid rgba(0,0,0,0.06);overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
        <!-- Header -->
        <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid #f0f0f0;">
          <img src="${logoUrl}" alt="BeeFlow" width="56" height="56" style="display:block;margin:0 auto 16px;border-radius:14px;" />
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">You're invited!</h1>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px 40px 36px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">
            <strong style="color:#0f172a;">${inviterName}</strong> has invited you to join
            <strong style="color:#0f172a;">${orgName}</strong> on BeeFlow${roleLabel ? ` as <strong style="color:#6b7280;">${roleLabel}</strong>` : ''}.
          </p>
          <p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#64748b;">
            Click the button below to create your account and get started.
          </p>
          <!-- CTA -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${inviteUrl}" target="_blank" style="display:inline-block;padding:14px 40px;background:#0f172a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">
                Accept Invitation
              </a>
            </td></tr>
          </table>
          <p style="margin:28px 0 0;font-size:12px;line-height:1.5;color:#94a3b8;">
            This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 40px;text-align:center;background:#fafafa;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:11px;color:#94a3b8;">
            Sent by BeeFlow · <a href="${clientHost}" style="color:#6b7280;text-decoration:none;">${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = `${inviterName} has invited you to join ${orgName} on BeeFlow${roleLabel ? ` as ${roleLabel}` : ''}.\n\nAccept your invitation: ${inviteUrl}\n\nThis invitation expires in 7 days.`;

    return sendServiceEmail({
        to: email,
        subject: `You're invited to join ${orgName} on BeeFlow`,
        text,
        html,
    });
}

/**
 * Send a branded waitlist approval email.
 * @param {{ email: string, displayName: string }} opts
 */
async function sendWaitlistApprovedEmail({ email, displayName }) {
    const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
    // PNG, not SVG: most mail clients (Gmail/Outlook) strip SVG. Served from agent-hub/public/.
    const logoUrl = `${clientHost}/bee-flow-logo.png`;
    const loginUrl = clientHost;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:48px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid rgba(0,0,0,0.06);overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
        <!-- Header -->
        <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid #f0f0f0;">
          <img src="${logoUrl}" alt="BeeFlow" width="56" height="56" style="display:block;margin:0 auto 16px;border-radius:14px;" />
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">You're approved! 🎉</h1>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px 40px 36px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">
            Hi <strong style="color:#0f172a;">${displayName}</strong>,
          </p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">
            Great news — your BeeFlow account has been approved! You can now log in and start using the platform.
          </p>
          <!-- CTA -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${loginUrl}" target="_blank" style="display:inline-block;padding:14px 40px;background:#0f172a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">
                Log In Now
              </a>
            </td></tr>
          </table>
          <p style="margin:28px 0 0;font-size:12px;line-height:1.5;color:#94a3b8;">
            If you didn't create an account on BeeFlow, you can safely ignore this email.
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 40px;text-align:center;background:#fafafa;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:11px;color:#94a3b8;">
            Sent by BeeFlow · <a href="${clientHost}" style="color:#6b7280;text-decoration:none;">${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = `Hi ${displayName},\n\nGreat news — your BeeFlow account has been approved! You can now log in and start using the platform.\n\nLog in: ${loginUrl}\n\nIf you didn't create an account on BeeFlow, you can safely ignore this email.`;

    return sendServiceEmail({
        to: email,
        subject: 'Your BeeFlow account has been approved!',
        text,
        html,
    });
}

/**
 * Send a trial-ending warning email. Stripe fires
 * `customer.subscription.trial_will_end` ~3 days before trial end. The
 * caller is responsible for idempotency (use userStore.claimNotification).
 *
 * @param {{ email: string, displayName?: string, orgName?: string, trialEndIso: string, portalUrl: string }} opts
 */
async function sendTrialEndingEmail({ email, displayName, orgName, trialEndIso, portalUrl }) {
    const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
    // PNG, not SVG: most mail clients (Gmail/Outlook) strip SVG. Served from agent-hub/public/.
    const logoUrl = `${clientHost}/bee-flow-logo.png`;
    const targetName = orgName || displayName || 'there';
    const trialEnd = trialEndIso ? new Date(trialEndIso) : null;
    const trialEndPretty = trialEnd ? trialEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : 'soon';
    const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : null;
    const daysLine = daysLeft != null ? `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : 'soon';

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:48px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid rgba(0,0,0,0.06);overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
        <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid #f0f0f0;">
          <img src="${logoUrl}" alt="BeeFlow" width="56" height="56" style="display:block;margin:0 auto 16px;border-radius:14px;" />
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Your trial ends ${daysLine}</h1>
        </td></tr>
        <tr><td style="padding:32px 40px 36px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">
            Hi <strong style="color:#0f172a;">${targetName}</strong>,
          </p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">
            Your BeeFlow trial ends on <strong style="color:#0f172a;">${trialEndPretty}</strong>. To keep your access without interruption, add a payment method now.
          </p>
          <p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#64748b;">
            If you don't add a payment method, your subscription will be cancelled automatically when the trial ends.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${portalUrl}" target="_blank" style="display:inline-block;padding:14px 40px;background:#0f172a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">
                Add Payment Method
              </a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 40px;text-align:center;background:#fafafa;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:11px;color:#94a3b8;">
            Sent by BeeFlow · <a href="${clientHost}" style="color:#6b7280;text-decoration:none;">${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = `Hi ${targetName},\n\nYour BeeFlow trial ends on ${trialEndPretty}. To keep your access without interruption, add a payment method now:\n\n${portalUrl}\n\nIf you don't add a payment method, your subscription will be cancelled automatically when the trial ends.`;

    return sendServiceEmail({
        to: email,
        subject: `Your BeeFlow trial ends ${daysLine}`,
        text,
        html,
    });
}

/**
 * Shared branded shell. Most lifecycle emails share the same chrome
 * (logo header, title, body, CTA, footer); this composer builds the HTML
 * and plaintext so individual templates only specify the copy.
 *
 * @param {{ title: string, intro?: string, body: string, ctaLabel?: string, ctaUrl?: string, footer?: string }} parts
 */
function _renderEmailShell({ title, intro, body, ctaLabel, ctaUrl, footer }) {
    const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
    // PNG, not SVG: most mail clients (Gmail/Outlook) strip SVG. Served from agent-hub/public/.
    const logoUrl = `${clientHost}/bee-flow-logo.png`;
    const cta = (ctaLabel && ctaUrl)
        ? `
        <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:14px 40px;background:#0f172a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">
                ${ctaLabel}
              </a>
            </td></tr>
        </table>`
        : '';
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:48px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid rgba(0,0,0,0.06);overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
        <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid #f0f0f0;">
          <img src="${logoUrl}" alt="BeeFlow" width="56" height="56" style="display:block;margin:0 auto 16px;border-radius:14px;" />
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">${title}</h1>
        </td></tr>
        <tr><td style="padding:32px 40px 36px;">
          ${intro ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">${intro}</p>` : ''}
          <div style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#334155;">${body}</div>
          ${cta}
          ${footer ? `<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#94a3b8;">${footer}</p>` : ''}
        </td></tr>
        <tr><td style="padding:20px 40px;text-align:center;background:#fafafa;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:11px;color:#94a3b8;">
            Sent by BeeFlow · <a href="${clientHost}" style="color:#6b7280;text-decoration:none;">${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
    return html;
}

// ── Configurable template helpers (verification + welcome) ──────────────
// Admin-authored templates are structured PLAIN-TEXT fields rendered into the
// branded shell. We treat all field content as plain text: substitute the
// {{variables}}, HTML-escape the result, then (for the body) turn newlines
// into <br>. This keeps user-supplied values (name/orgName) and any stray
// markup from breaking the HTML.

function _escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Replace {{var}} tokens with raw values from `vars` (unknown tokens → ''). */
function _substituteVars(str, vars = {}) {
    return String(str == null ? '' : str).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : ''
    );
}

/** Render a plain-text template field to safe HTML (substitute → escape → <br>). */
function _renderField(str, vars, { multiline = false } = {}) {
    const escaped = _escapeHtml(_substituteVars(str, vars));
    return multiline ? escaped.replace(/\n/g, '<br>') : escaped;
}

/**
 * Build a {subject, html, text} email from a configurable, locale-aware
 * template. Shared by the send functions and the admin preview/test endpoint
 * (no-send path). The CTA URL is taken from vars.verifyUrl / vars.loginUrl.
 *
 * @param {'verification'|'welcome'} templateId
 * @param {string} locale
 * @param {Object} vars  e.g. { name, orgName, verifyUrl } or { name, orgName, loginUrl }
 */
/**
 * Build {subject, html, text} from an already-resolved template object
 * ({subject,title,intro,body,ctaLabel}) and substitution vars. Used by the
 * send functions and by the admin live-preview endpoint (which passes
 * in-progress, unsaved fields).
 */
function renderEmailFromTemplate(tpl, vars = {}) {
    const ctaUrl = vars.verifyUrl || vars.loginUrl || null;
    const html = _renderEmailShell({
        title: _renderField(tpl.title, vars),
        intro: tpl.intro ? _renderField(tpl.intro, vars) : '',
        body: _renderField(tpl.body, vars, { multiline: true }),
        ctaLabel: tpl.ctaLabel ? _renderField(tpl.ctaLabel, vars) : null,
        ctaUrl,
    });

    const subject = _substituteVars(tpl.subject, vars);
    const lines = [_substituteVars(tpl.intro, vars), _substituteVars(tpl.body, vars)].filter(Boolean);
    if (ctaUrl) lines.push(`${_substituteVars(tpl.ctaLabel, vars)}: ${ctaUrl}`.trim());
    const text = lines.join('\n\n');

    return { subject, html, text };
}

async function renderEmailTemplate(templateId, locale, vars = {}) {
    const languageStore = require('../stores/languageStore');
    const tpl = await languageStore.getEffectiveEmailTemplate(templateId, locale);
    if (!tpl) throw new Error(`Unknown email template '${templateId}'`);
    return renderEmailFromTemplate(tpl, vars);
}

/**
 * Email-address verification. The raw token only ever travels in `verifyUrl`
 * (the DB stores SHA-256(token)). Sent at signup when verification is enabled.
 *
 * @param {{ email: string, displayName?: string, verifyUrl: string, orgName?: string, locale?: string }} opts
 */
async function sendVerificationEmail({ email, displayName, verifyUrl, orgName, locale }) {
    const vars = { name: displayName || 'there', verifyUrl, orgName: orgName || 'BeeFlow' };
    const { subject, html, text } = await renderEmailTemplate('verification', locale, vars);
    return sendServiceEmail({ to: email, subject, text, html });
}

/**
 * Welcome / confirmation email. Sent once an account first becomes active
 * (after verification for verified signups; on creation for trusted accounts).
 *
 * @param {{ email: string, displayName?: string, loginUrl: string, orgName?: string, locale?: string }} opts
 */
async function sendWelcomeEmail({ email, displayName, loginUrl, orgName, locale }) {
    // BFSF-230: the confirmation email doubles as an onboarding touchpoint with
    // a Learning Center link. Derived from the same client host as other links.
    const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
    const learnUrl = `${clientHost}/app`;
    const vars = { name: displayName || 'there', loginUrl, learnUrl, orgName: orgName || 'BeeFlow' };
    const { subject, html, text } = await renderEmailTemplate('welcome', locale, vars);
    return sendServiceEmail({ to: email, subject, text, html });
}

/**
 * Payment failed — first failure. Stripe automatically retries per its
 * Smart Retries schedule (typically 3, 5, 7 days). This email is the
 * "heads up" to the customer so they can update their card before retries
 * are exhausted and dunning takes the subscription past_due.
 */
async function sendPaymentFailedEmail({ email, displayName, orgName, portalUrl, attemptCount = 1 }) {
    const targetName = orgName || displayName || 'there';
    const html = _renderEmailShell({
        title: 'Payment failed',
        intro: `Hi <strong>${targetName}</strong>,`,
        body: `Your most recent BeeFlow payment didn't go through${attemptCount > 1 ? ` (attempt ${attemptCount})` : ''}. Stripe will automatically retry over the next few days, but you can update your card now to avoid a service interruption.`,
        ctaLabel: 'Update Payment Method',
        ctaUrl: portalUrl,
        footer: 'If you\'ve already updated your card, you can ignore this email.',
    });
    const text = `Hi ${targetName},\n\nYour most recent BeeFlow payment didn't go through${attemptCount > 1 ? ` (attempt ${attemptCount})` : ''}. Stripe will retry automatically. Update your card now to avoid a service interruption:\n\n${portalUrl}`;
    return sendServiceEmail({
        to: email,
        subject: 'BeeFlow: Payment failed — please update your card',
        text,
        html,
    });
}

/**
 * Dunning grace-period warning. Sent when the dunning sweeper notices an
 * org has been past_due for over half the grace window (default 7 days).
 * Last chance before the subscription flips to suspended.
 */
async function sendDunningGraceWarningEmail({ email, displayName, orgName, portalUrl, graceDaysRemaining }) {
    const targetName = orgName || displayName || 'there';
    const html = _renderEmailShell({
        title: 'Your subscription is at risk',
        intro: `Hi <strong>${targetName}</strong>,`,
        body: `Your BeeFlow account is past due. If we don\'t receive payment in the next <strong>${graceDaysRemaining} day${graceDaysRemaining === 1 ? '' : 's'}</strong>, AI access will be suspended.`,
        ctaLabel: 'Resolve Now',
        ctaUrl: portalUrl,
        footer: 'Updating your payment method instantly reactivates Stripe retries.',
    });
    const text = `Hi ${targetName},\n\nYour BeeFlow account is past due. If we don't receive payment in the next ${graceDaysRemaining} day(s), AI access will be suspended.\n\nResolve now: ${portalUrl}`;
    return sendServiceEmail({
        to: email,
        subject: `BeeFlow: ${graceDaysRemaining} day${graceDaysRemaining === 1 ? '' : 's'} until your subscription is suspended`,
        text,
        html,
    });
}

/**
 * Subscription suspended (post-dunning). Final-state email confirming AI
 * access is blocked until payment is resolved.
 */
async function sendSubscriptionSuspendedEmail({ email, displayName, orgName, portalUrl }) {
    const targetName = orgName || displayName || 'there';
    const html = _renderEmailShell({
        title: 'Subscription suspended',
        intro: `Hi <strong>${targetName}</strong>,`,
        body: 'Your BeeFlow subscription has been suspended because payment couldn\'t be collected. AI features are paused; existing chats and data remain intact. Update your payment method to reactivate.',
        ctaLabel: 'Reactivate Subscription',
        ctaUrl: portalUrl,
    });
    const text = `Hi ${targetName},\n\nYour BeeFlow subscription has been suspended because payment couldn't be collected. AI features are paused; your data is safe. Update your payment method to reactivate:\n\n${portalUrl}`;
    return sendServiceEmail({
        to: email,
        subject: 'BeeFlow: Subscription suspended',
        text,
        html,
    });
}

/**
 * GDPR Art. 33 breach notification. Sent to the recipient list resolved by
 * compliance.js (DPO + org admins). Free-form body so the compliance flow
 * can include incident-specific details (categories of data, affected user
 * count, mitigation steps) without a rigid template.
 *
 * @param {{ to: string | string[], incidentSummary: string, occurredAt: string, ackUrl?: string }} opts
 */
async function sendBreachNotificationEmail({ to, incidentSummary, occurredAt, ackUrl }) {
    const html = _renderEmailShell({
        title: 'Data incident notification',
        body: `A security incident has been recorded that may affect your organization\'s data. <br/><br/><strong>Occurred:</strong> ${occurredAt}<br/><br/>${incidentSummary}`,
        ctaLabel: ackUrl ? 'Open Incident Report' : null,
        ctaUrl: ackUrl || null,
        footer: 'This notification is sent in accordance with GDPR Art. 33 / 34. Please coordinate with your DPO before disclosing details outside your organization.',
    });
    const text = `Data incident notification.\n\nOccurred: ${occurredAt}\n\n${incidentSummary}\n\n${ackUrl ? `Open: ${ackUrl}` : ''}`;
    return sendServiceEmail({
        to,
        subject: 'BeeFlow: Data incident notification',
        text,
        html,
    });
}

/**
 * Nextcloud connector pairing — one-time verification code. Sent when a
 * Nextcloud install's admin email matches an existing Bee Flow organisation
 * (same domain). The admin types the code into the embedded Bee Flow view in
 * Nextcloud to confirm the link — no external login required. Never log or
 * return the code anywhere else; this email is the only place it appears.
 *
 * @param {{ to: string, code: string, orgName?: string, expiresAt?: string }} opts
 */
async function sendNcVerificationCodeEmail({ to, code, orgName, expiresAt }) {
    const minutes = expiresAt
        ? Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000))
        : 15;
    const orgLine = orgName
        ? `link this Nextcloud to <strong>${orgName}</strong>`
        : 'link this Nextcloud to your Bee Flow organisation';
    const html = _renderEmailShell({
        title: 'Your Nextcloud connection code',
        body: `Enter this code in the Bee Flow app inside Nextcloud to ${orgLine}:
            <div style="margin:24px 0;text-align:center;">
              <span style="display:inline-block;font-size:34px;font-weight:700;letter-spacing:10px;color:#0f172a;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 24px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;">${code}</span>
            </div>
            <p style="margin:0;font-size:13px;color:#64748b;">This code expires in ${minutes} minute${minutes === 1 ? '' : 's'}.</p>`,
        footer: 'If you didn\'t install the Bee Flow app on Nextcloud, you can safely ignore this email — no connection will be made.',
    });
    const text = `Your Bee Flow Nextcloud connection code: ${code}\n\nEnter this code in the Bee Flow app inside Nextcloud to ${orgName ? `link this Nextcloud to ${orgName}` : 'link this Nextcloud to your Bee Flow organisation'}.\n\nThis code expires in ${minutes} minute(s).\n\nIf you didn't install the Bee Flow app on Nextcloud, you can safely ignore this email.`;
    return sendServiceEmail({
        to,
        subject: `Bee Flow: your Nextcloud connection code is ${code}`,
        text,
        html,
    });
}

/**
 * Admin notification — a new subscription was started. Sent to the address
 * configured in Admin → Subscriptions → Stripe (`subscription_notify_email`),
 * once per new subscription. The webhook is responsible for idempotency
 * (userStore.claimNotification) so subscription *updates* never re-trigger.
 *
 * @param {{ to: string, scope?: string, targetName?: string, planName?: string, price?: number|string, currency?: string, interval?: string, trialDays?: number, adminUrl?: string }} opts
 */
async function sendSubscriptionStartedAdminEmail({ to, scope, targetName, planName, price, currency, interval, trialDays, adminUrl }) {
    const fmtPrice = (price !== undefined && price !== null && price !== '')
        ? `${currency || 'EUR'} ${price}${interval ? ` / ${interval === 'yearly' ? 'year' : 'month'}` : ''}`
        : '—';
    const rows = [
        ['Customer', targetName || '—'],
        ['Type', scope === 'consumer' ? 'Personal account' : 'Organisation'],
        ['Plan', planName || '—'],
        ['Price', fmtPrice],
        ...(trialDays ? [['Trial', `${trialDays} day${trialDays === 1 ? '' : 's'}`]] : []),
    ];
    const tableRows = rows.map(([k, v]) =>
        `<tr><td style="padding:6px 12px;color:#64748b;font-size:14px;">${k}</td><td style="padding:6px 12px;color:#0f172a;font-size:14px;font-weight:600;">${v}</td></tr>`
    ).join('');
    const html = _renderEmailShell({
        title: 'New subscription started',
        body: `A customer just started a new subscription on Bee Flow.
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #e2e8f0;border-radius:12px;border-collapse:separate;border-spacing:0;">${tableRows}</table>`,
        ctaLabel: adminUrl ? 'Open admin dashboard' : null,
        ctaUrl: adminUrl || null,
        footer: 'You are receiving this because a notification email is set in Admin → Subscriptions → Stripe.',
    });
    const text = `New subscription started on Bee Flow.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}${adminUrl ? `\n\nAdmin: ${adminUrl}` : ''}`;
    return sendServiceEmail({
        to,
        subject: `Bee Flow: new subscription — ${planName || 'plan'}${targetName ? ` (${targetName})` : ''}`,
        text,
        html,
    });
}

/**
 * Self-service password reset link. The raw token only ever travels in this
 * email (the DB stores SHA-256(token)). Link expires in 60 minutes.
 *
 * @param {{ email: string, displayName?: string, resetUrl: string }} opts
 */
async function sendPasswordResetEmail({ email, displayName, resetUrl }) {
    const name = displayName || 'there';
    const html = _renderEmailShell({
        title: 'Reset your password',
        intro: `Hi <strong>${name}</strong>,`,
        body: 'We received a request to reset your Bee Flow password. Click the button below to choose a new one. This link expires in 1 hour and can be used once. If you didn\'t request this, you can safely ignore this email — your password won\'t change.',
        ctaLabel: 'Reset password',
        ctaUrl: resetUrl,
        footer: 'For your security, this link expires in 60 minutes and can only be used once.',
    });
    const text = `Hi ${name},\n\nReset your Bee Flow password using the link below (expires in 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email — your password won't change.`;
    return sendServiceEmail({
        to: email,
        subject: 'Reset your Bee Flow password',
        text,
        html,
    });
}

module.exports = {
    getServiceEmailConfig,
    sendServiceEmail,
    buildConnectUrl,
    completeOAuthConnect,
    disconnectServiceEmail,
    _renderEmailShell,
    renderEmailFromTemplate,
    renderEmailTemplate,
    sendVerificationEmail,
    sendWelcomeEmail,
    sendNcVerificationCodeEmail,
    sendPasswordResetEmail,
    sendInvitationEmail,
    sendWaitlistApprovedEmail,
    sendTrialEndingEmail,
    sendPaymentFailedEmail,
    sendDunningGraceWarningEmail,
    sendSubscriptionSuspendedEmail,
    sendBreachNotificationEmail,
    sendSubscriptionStartedAdminEmail,
};
