const fs = require('fs');
const nodemailer = require('nodemailer');

async function main() {
  const inputs = JSON.parse(fs.readFileSync(0, 'utf-8'));

  // Validate required inputs
  if (!inputs.smtpHost) throw new Error("'smtpHost' is required");
  if (!inputs.smtpPort) throw new Error("'smtpPort' is required");
  if (!inputs.smtpUsername) throw new Error("'smtpUsername' is required");
  if (!inputs.smtpPassword) throw new Error("'smtpPassword' is required");
  if (!inputs.fromEmail) throw new Error("'fromEmail' is required");
  if (!inputs.toEmails) throw new Error("'toEmails' is required");
  if (!inputs.subject) throw new Error("'subject' is required");
  if (!inputs.body) throw new Error("'body' is required");

  // Parse email lists
  const toEmails = inputs.toEmails.split(',').map(e => e.trim()).filter(e => e);
  const ccEmails = inputs.ccEmails ? inputs.ccEmails.split(',').map(e => e.trim()).filter(e => e) : [];
  const bccEmails = inputs.bccEmails ? inputs.bccEmails.split(',').map(e => e.trim()).filter(e => e) : [];
  const attachments = inputs.attachments ? inputs.attachments.split(',').map(a => a.trim()).filter(a => a) : [];

  // Validate email addresses
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(inputs.fromEmail)) throw new Error("Invalid 'fromEmail' format");
  if (toEmails.length === 0 || !toEmails.every(emailRegex.test.bind(emailRegex))) {
    throw new Error("Invalid 'toEmails' format");
  }
  if (ccEmails.length > 0 && !ccEmails.every(emailRegex.test.bind(emailRegex))) {
    throw new Error("Invalid 'ccEmails' format");
  }
  if (bccEmails.length > 0 && !bccEmails.every(emailRegex.test.bind(emailRegex))) {
    throw new Error("Invalid 'bccEmails' format");
  }

  // Create transporter
  const transporter = nodemailer.createTransport({
    host: inputs.smtpHost,
    port: inputs.smtpPort,
    secure: inputs.useTLS, // true for 465, false for other ports with STARTTLS
    auth: {
      user: inputs.smtpUsername,
      pass: inputs.smtpPassword
    }
  });

  // Prepare email options
  const mailOptions = {
    from: inputs.fromEmail,
    to: toEmails.join(', '),
    cc: ccEmails.join(', '),
    bcc: bccEmails.join(', '),
    subject: inputs.subject,
    text: inputs.isHtml ? undefined : inputs.body,
    html: inputs.isHtml ? inputs.body : undefined,
    replyTo: inputs.replyTo || undefined,
    attachments: attachments.map(path => ({ path }))
  };

  try {
    // Send email
    const info = await transporter.sendMail(mailOptions);

    // Prepare output
    const result = {
      success: true,
      messageId: info.messageId,
      acceptedRecipients: info.accepted,
      rejectedRecipients: info.rejected
    };

    console.log(JSON.stringify(result));
  } catch (error) {
    const result = {
      success: false,
      error: error.message
    };
    console.log(JSON.stringify(result));
  }
}

main().catch(e => {
  const result = {
    success: false,
    error: e.message
  };
  console.log(JSON.stringify(result));
});