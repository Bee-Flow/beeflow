/**
 * Gmail Integration Routes
 * 
 * Provides endpoints for browsing and reading Gmail messages
 * for use as chat attachments (read-only).
 * 
 * Uses the official `googleapis` SDK with per-user OAuth2 tokens.
 */

const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { loadConfig } = require('../../auth/permissions');

/**
 * Create an authenticated Gmail client from session tokens.
 */
async function createGmailClient(req) {
    const config = await loadConfig();
    const providerConfig = config.providers?.google || {};

    if (!providerConfig.clientId || !providerConfig.clientSecret) {
        throw new Error('Google OAuth not configured. Set up Google SSO in Admin → Security.');
    }

    const accessToken = req.session?.accessToken;
    const refreshToken = req.session?.refreshToken;

    if (!accessToken) {
        throw new Error('NOT_CONNECTED');
    }

    const oauth2Client = new google.auth.OAuth2(
        providerConfig.clientId,
        providerConfig.clientSecret
    );

    oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken
    });

    // Auto-refresh handler: update session when tokens refresh
    oauth2Client.on('tokens', (tokens) => {
        if (tokens.access_token) {
            req.session.accessToken = tokens.access_token;
        }
        if (tokens.refresh_token) {
            req.session.refreshToken = tokens.refresh_token;
        }
        req.session.save?.();
    });

    return google.gmail({ version: 'v1', auth: oauth2Client });
}

/**
 * Decode base64url-encoded email body parts.
 */
function decodeBase64Url(data) {
    if (!data) return '';
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Extract the text body from a Gmail message payload.
 */
function extractTextBody(payload) {
    if (!payload) return '';

    // Simple single-part message
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
        return decodeBase64Url(payload.body.data);
    }

    // Multipart message — look for text/plain first, then text/html
    if (payload.parts) {
        // First pass: look for text/plain
        for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
                return decodeBase64Url(part.body.data);
            }
        }
        // Second pass: look for text/html and strip tags
        for (const part of payload.parts) {
            if (part.mimeType === 'text/html' && part.body?.data) {
                const html = decodeBase64Url(part.body.data);
                return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            }
        }
        // Recurse into nested multipart
        for (const part of payload.parts) {
            if (part.parts) {
                const text = extractTextBody(part);
                if (text) return text;
            }
        }
    }

    return '';
}

/**
 * Get a header value from a Gmail message.
 */
function getHeader(headers, name) {
    const h = headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h?.value || '';
}

// ─── Status Check ────────────────────────────────────────────────

router.get('/status', async (req, res) => {
    const isConnected = !!(req.session?.accessToken && req.session?.oauthProvider === 'google');
    const config = await loadConfig();
    const isConfigured = !!(config.providers?.google?.clientId && config.providers?.google?.clientSecret);

    res.json({
        connected: isConnected,
        configured: isConfigured,
        user: isConnected ? req.session.user : null,
    });
});

// ─── List / Search Messages ──────────────────────────────────────

router.get('/messages', async (req, res) => {
    try {
        const gmail = await createGmailClient(req);
        const { query, pageToken, pageSize = 20, label = 'INBOX' } = req.query;

        // Build the Gmail search query
        let q = '';
        if (query) {
            q = query;
        }

        const response = await gmail.users.messages.list({
            userId: 'me',
            q: q || undefined,
            labelIds: label ? [label] : undefined,
            maxResults: Math.min(parseInt(pageSize) || 20, 50),
            pageToken: pageToken || undefined,
        });

        const messageIds = response.data.messages || [];

        // Fetch metadata for each message (batch-style, parallel)
        const messages = await Promise.all(
            messageIds.map(async (msg) => {
                try {
                    const detail = await gmail.users.messages.get({
                        userId: 'me',
                        id: msg.id,
                        format: 'metadata',
                        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
                    });

                    const headers = detail.data.payload?.headers || [];
                    return {
                        id: detail.data.id,
                        threadId: detail.data.threadId,
                        snippet: detail.data.snippet || '',
                        from: getHeader(headers, 'From'),
                        to: getHeader(headers, 'To'),
                        subject: getHeader(headers, 'Subject') || '(no subject)',
                        date: getHeader(headers, 'Date'),
                        labelIds: detail.data.labelIds || [],
                        isUnread: (detail.data.labelIds || []).includes('UNREAD'),
                    };
                } catch (err) {
                    console.error(`[Gmail] Failed to get message ${msg.id}:`, err.message);
                    return null;
                }
            })
        );

        res.json({
            messages: messages.filter(Boolean),
            nextPageToken: response.data.nextPageToken || null,
            resultSizeEstimate: response.data.resultSizeEstimate || 0,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Gmail', code: 'NOT_CONNECTED' });
        }
        console.error('[Gmail] List messages error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Get Full Message Content ────────────────────────────────────

router.get('/messages/:messageId', async (req, res) => {
    try {
        const gmail = await createGmailClient(req);
        const { messageId } = req.params;

        const detail = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
        });

        const headers = detail.data.payload?.headers || [];
        const body = extractTextBody(detail.data.payload);

        // Truncate very large emails
        const MAX_CHARS = 50000;
        const truncated = body.length > MAX_CHARS;
        const finalBody = truncated
            ? body.substring(0, MAX_CHARS) + '\n\n[... truncated, email too large ...]'
            : body;

        res.json({
            id: detail.data.id,
            threadId: detail.data.threadId,
            from: getHeader(headers, 'From'),
            to: getHeader(headers, 'To'),
            subject: getHeader(headers, 'Subject') || '(no subject)',
            date: getHeader(headers, 'Date'),
            body: finalBody,
            snippet: detail.data.snippet || '',
            truncated,
            charCount: body.length,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Gmail', code: 'NOT_CONNECTED' });
        }
        console.error('[Gmail] Get message error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Send Email (User Approved) ──────────────────────────────────

router.post('/send', async (req, res) => {
    try {
        const gmail = await createGmailClient(req);
        const { to, cc, bcc, subject, body, replyToMessageId, threadId, inReplyTo, references } = req.body;

        if (!to || !subject || !body) {
            return res.status(400).json({ error: 'to, subject, and body are required' });
        }

        // Get the user's email for the From header
        const userEmail = req.session?.user?.email || '';

        // MIME-encode subject for non-ASCII characters (RFC 2047)
        const hasNonAscii = /[^\x00-\x7F]/.test(subject);
        const encodedSubject = hasNonAscii
            ? `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
            : subject;

        // Build RFC 2822 email message
        const headers = [
            `To: ${to}`,
            `From: ${userEmail}`,
            `Subject: ${encodedSubject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
        ];

        // Add CC and BCC headers
        if (cc) headers.push(`Cc: ${cc}`);
        if (bcc) headers.push(`Bcc: ${bcc}`);

        // Add threading headers for replies
        if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
        if (references) headers.push(`References: ${references} ${inReplyTo || ''}`);

        const encodedBody = Buffer.from(body, 'utf-8').toString('base64');
        const rawMessage = headers.join('\r\n') + '\r\n\r\n' + encodedBody;

        // Encode to base64url
        const encodedMessage = Buffer.from(rawMessage)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        const sendParams = {
            userId: 'me',
            requestBody: {
                raw: encodedMessage,
            },
        };

        // Thread the reply if we have a threadId
        if (threadId) {
            sendParams.requestBody.threadId = threadId;
        }

        const result = await gmail.users.messages.send(sendParams);

        console.log(`[Gmail] Email sent successfully: ${result.data.id} to ${to}`);
        res.json({
            success: true,
            messageId: result.data.id,
            threadId: result.data.threadId,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Gmail', code: 'NOT_CONNECTED' });
        }
        console.error('[Gmail] Send email error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Save as Gmail Draft ─────────────────────────────────────────

router.post('/draft', async (req, res) => {
    try {
        const gmail = await createGmailClient(req);
        const { to, cc, bcc, subject, body, replyToMessageId, threadId, inReplyTo, references } = req.body;

        if (!to || !subject || !body) {
            return res.status(400).json({ error: 'to, subject, and body are required' });
        }

        // Get the user's email for the From header
        const userEmail = req.session?.user?.email || '';

        // MIME-encode subject for non-ASCII characters (RFC 2047)
        const hasNonAscii = /[^\x00-\x7F]/.test(subject);
        const encodedSubject = hasNonAscii
            ? `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
            : subject;

        // Build RFC 2822 email message
        const headers = [
            `To: ${to}`,
            `From: ${userEmail}`,
            `Subject: ${encodedSubject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
        ];

        // Add CC and BCC headers
        if (cc) headers.push(`Cc: ${cc}`);
        if (bcc) headers.push(`Bcc: ${bcc}`);

        // Add threading headers for replies
        if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
        if (references) headers.push(`References: ${references} ${inReplyTo || ''}`);

        const encodedBody = Buffer.from(body, 'utf-8').toString('base64');
        const rawMessage = headers.join('\r\n') + '\r\n\r\n' + encodedBody;

        // Encode to base64url
        const encodedMessage = Buffer.from(rawMessage)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        const draftParams = {
            userId: 'me',
            requestBody: {
                message: {
                    raw: encodedMessage,
                },
            },
        };

        // Thread the reply if we have a threadId
        if (threadId) {
            draftParams.requestBody.message.threadId = threadId;
        }

        const result = await gmail.users.drafts.create(draftParams);

        console.log(`[Gmail] Draft saved successfully: ${result.data.id} for ${to}`);
        res.json({
            success: true,
            draftId: result.data.id,
            messageId: result.data.message?.id,
            gmailLink: `https://mail.google.com/mail/u/0/#drafts?compose=${result.data.message?.id || result.data.id}`,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Gmail', code: 'NOT_CONNECTED' });
        }
        console.error('[Gmail] Save draft error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Tone of Voice Analysis ──────────────────────────────────────

router.post('/analyze-tone', async (req, res) => {
    try {
        const gmail = await createGmailClient(req);
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        // Fetch last 30 sent emails
        console.log('[Gmail] Fetching last 30 sent emails for tone analysis...');
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: 'in:sent',
            maxResults: 30,
        });

        const messageIds = response.data.messages || [];
        if (messageIds.length < 5) {
            return res.status(400).json({
                error: 'Not enough sent emails found. At least 5 sent emails are needed to analyze your writing style.'
            });
        }

        // Fetch full body of each email
        const emails = [];
        for (const msg of messageIds) {
            try {
                const detail = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full',
                });
                const headers = detail.data.payload?.headers || [];
                const body = extractTextBody(detail.data.payload);
                if (body && body.trim().length > 20) {
                    emails.push({
                        to: getHeader(headers, 'To'),
                        subject: getHeader(headers, 'Subject') || '(no subject)',
                        body: body.slice(0, 2000), // Cap each email to avoid token overflow
                    });
                }
            } catch (err) {
                // Skip failed fetches
            }
        }

        if (emails.length < 3) {
            return res.status(400).json({
                error: 'Could not extract enough email content for analysis.'
            });
        }

        console.log(`[Gmail] Extracted ${emails.length} sent emails for tone analysis`);

        // Build the analysis prompt
        const emailSamples = emails.map((e, i) =>
            `--- Email ${i + 1} ---\nTo: ${e.to}\nSubject: ${e.subject}\n\n${e.body}`
        ).join('\n\n');

        const analysisPrompt = `Analyze the following ${emails.length} sent emails written by the user. Create a detailed, actionable writing style profile.

CRITICAL: First, detect the MAIN LANGUAGE of these emails. Your ENTIRE response MUST be written in that language. If Dutch, write in Dutch. If German, write in German. No exceptions.

Create the profile as DIRECT INSTRUCTIONS an AI must follow when writing emails as this person. Be extremely specific and include real examples from the emails.

Structure your profile with these sections:
1. **Taal/Language**: Primary language, any code-switching patterns
2. **Toon & Stijl/Tone & Style**: Formal/informal level, personality in writing
3. **Begroetingen/Greetings**: List their EXACT greeting patterns (copy from emails, e.g. "Hoi [naam]," or "Hey," or "Hi [naam],")
4. **Afsluitingen/Sign-offs**: List their EXACT sign-off patterns (copy from emails, e.g. "Gr, [naam]" or "Cheers,")
5. **Zinsstructuur/Sentence structure**: Short/long, bullet points, paragraph style
6. **Kenmerkende uitdrukkingen/Characteristic phrases**: List EXACT phrases they frequently use (copy verbatim from emails)
7. **Interpunctie & emoji/Punctuation & emoji**: Exclamation marks, ellipses, emoji usage
8. **Lengte/Length**: Typical email length
9. **Communicatiestijl/Communication approach**: Direct vs contextual, action-oriented vs conversational

Use imperative instructions: "Gebruik...", "Begin met...", "Sluit af met..." (or equivalent in the detected language).
Include CONCRETE examples from the actual emails wherever possible.

Here are the emails:

${emailSamples}`;

        // Call LLM for analysis
        const llmClient = require('../../core/llmClient');
        const { resolveModelForTierName } = require('../../core/modelResolver');

        // Resolve user's org for EU-mode
        let userOrgId = null;
        try {
            const { resolveUserOrgIds } = require('../../auth');
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds && orgIds.size > 0) userOrgId = Array.from(orgIds)[0];
            if (!userOrgId) {
                const userStore = require('../../stores/userStore');
                const dbUser = await userStore.getUser(userId);
                if (dbUser?.organizationId) userOrgId = dbUser.organizationId;
            }
        } catch (_) {}

        // Get the deep thinking tier model (with fallback to writing, then fast)
        let modelId = await resolveModelForTierName('deep', { userOrgId });
        if (!modelId || modelId === 'gemini-2.0-flash-lite') {
            modelId = await resolveModelForTierName('writing', { userOrgId });
        }
        if (!modelId) {
            return res.status(500).json({
                error: 'No model configured. Please configure a model in Settings → AI Models.'
            });
        }

        console.log(`[Gmail] Running tone analysis with model: ${modelId}`);
        const result = await llmClient.chat(modelId, [
            { role: 'system', content: 'You are an expert linguist and communication analyst. Analyze writing samples to create a precise, actionable writing style profile. Be specific — include real examples, exact phrases, and concrete patterns. Write everything in the same language as the emails.' },
            { role: 'user', content: analysisPrompt },
        ], {
            maxTokens: 2500,
            temperature: 0.3,
        });

        const profile = (result.content || '').trim();
        if (!profile) {
            return res.status(500).json({ error: 'Failed to generate writing style profile' });
        }

        // Save to configStore
        await configStore.setConfig(`email_tone_profile_user_${userId}`, profile);
        console.log(`[Gmail] Tone profile saved for user ${userId} (${profile.length} chars)`);

        res.json({
            success: true,
            profile,
            emailsAnalyzed: emails.length,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Gmail', code: 'NOT_CONNECTED' });
        }
        console.error('[Gmail] Tone analysis error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.get('/tone-profile', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const configStore = require('../../stores/configStore');
        const profile = await configStore.getConfig(`email_tone_profile_user_${userId}`);

        res.json({
            exists: !!profile,
            profile: profile || null,
        });
    } catch (err) {
        console.error('[Gmail] Get tone profile error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/tone-profile', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const configStore = require('../../stores/configStore');
        await configStore.deleteConfig(`email_tone_profile_user_${userId}`);

        res.json({ success: true });
    } catch (err) {
        console.error('[Gmail] Delete tone profile error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.put('/tone-profile', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const { profile } = req.body;
        if (!profile || typeof profile !== 'string') {
            return res.status(400).json({ error: 'Profile text is required' });
        }

        const configStore = require('../../stores/configStore');
        await configStore.setConfig(`email_tone_profile_user_${userId}`, profile.trim());
        console.log(`[Gmail] Tone profile manually updated for user ${userId} (${profile.trim().length} chars)`);

        res.json({ success: true, profile: profile.trim() });
    } catch (err) {
        console.error('[Gmail] Update tone profile error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
