/**
 * Email Service — Gmail SMTP sender using configStore credentials
 * 
 * Provides a reusable `sendServiceEmail()` function for sending
 * customer-facing emails from the platform's configured service account.
 * 
 * Credentials are stored encrypted at rest via configStore.setSecret().
 * Requires a Gmail account with 2FA + App Password.
 */

const configStore = require('../stores/configStore');

/**
 * Get the current service email configuration (without exposing the password).
 * @returns {{ configured: boolean, address: string, displayName: string }}
 */
async function getServiceEmailConfig() {
    console.log('[EmailService] getServiceEmailConfig — looking up credentials...');
    const address = await configStore.getConfig('service_email_address');
    const password = await configStore.getSecret('service_email_password');
    const hasPassword = !!password;
    const displayName = await configStore.getConfig('service_email_display_name') || '';

    console.log(`[EmailService] Config: address=${address ? address : '(empty)'}, hasPassword=${hasPassword}, displayName=${displayName || '(empty)'}`);

    return {
        configured: !!(address && hasPassword),
        address: address || '',
        displayName,
    };
}

/**
 * Create a nodemailer transporter using the stored Gmail SMTP credentials.
 * @returns {Promise<import('nodemailer').Transporter>}
 */
async function _createTransporter() {
    console.log('[EmailService] _createTransporter — loading nodemailer...');
    let nodemailer;
    try {
        nodemailer = require('nodemailer');
        console.log('[EmailService] nodemailer loaded OK');
    } catch (e) {
        console.error('[EmailService] nodemailer require FAILED:', e.message);
        throw new Error('Email service unavailable — nodemailer package is not installed. Run: npm install nodemailer');
    }
    const address = await configStore.getConfig('service_email_address');
    const password = await configStore.getSecret('service_email_password');

    console.log(`[EmailService] Transporter: address=${address ? address : '(empty)'}, password=${password ? '***' + password.slice(-4) : '(empty/null)'}`);

    if (!address || !password) {
        const reason = !address ? 'no address' : 'no password (decrypt failed?)';
        console.error(`[EmailService] Cannot create transporter: ${reason}`);
        throw new Error(`Service email is not configured (${reason}). Re-enter credentials in Admin → Integrations → Email.`);
    }

    console.log('[EmailService] Creating SMTP transporter for smtp.gmail.com:587...');
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false, // STARTTLS
        auth: {
            user: address,
            pass: password,
        },
        connectionTimeout: 10000, // 10s to establish TCP connection
        greetingTimeout: 10000,   // 10s for SMTP greeting
        socketTimeout: 15000,     // 15s for socket inactivity
    });

    // Verify connection with a hard timeout
    try {
        console.log('[EmailService] Verifying SMTP connection (10s timeout)...');
        await Promise.race([
            transporter.verify(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(
                'SMTP connection timed out after 10s — port 587 may be blocked on this server. ' +
                'Try: sudo ufw allow out 587/tcp  OR check cloud firewall rules.'
            )), 10000)),
        ]);
        console.log('[EmailService] SMTP connection verified OK');
    } catch (verifyErr) {
        console.error('[EmailService] SMTP verify FAILED:', verifyErr.message);
        throw new Error(`SMTP connection failed: ${verifyErr.message}`);
    }

    return transporter;
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
        const transporter = await _createTransporter();
        const config = await getServiceEmailConfig();
        const fromName = config.displayName || 'Service';
        const fromAddress = config.address;

        const mailOptions = {
            from: `"${fromName}" <${fromAddress}>`,
            to: Array.isArray(to) ? to.join(', ') : to,
            subject,
            text: text || undefined,
            html: html || undefined,
            cc: cc || undefined,
            bcc: bcc || undefined,
            replyTo: replyTo || undefined,
        };

        console.log(`[EmailService] Sending from "${fromName}" <${fromAddress}> → ${to}`);
        const info = await transporter.sendMail(mailOptions);

        console.log(`[EmailService] ✅ Email sent: ${info.messageId} → ${to}`);
        return {
            success: true,
            messageId: info.messageId,
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
    const logoUrl = `${clientHost}/bee-flow-logo.svg`;

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
    const logoUrl = `${clientHost}/bee-flow-logo.svg`;
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
    const logoUrl = `${clientHost}/bee-flow-logo.svg`;
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
    const logoUrl = `${clientHost}/bee-flow-logo.svg`;
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

module.exports = {
    getServiceEmailConfig,
    sendServiceEmail,
    sendInvitationEmail,
    sendWaitlistApprovedEmail,
    sendTrialEndingEmail,
    sendPaymentFailedEmail,
    sendDunningGraceWarningEmail,
    sendSubscriptionSuspendedEmail,
    sendBreachNotificationEmail,
};
