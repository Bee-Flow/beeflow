/**
 * Outlook Routes — REST API for Outlook Mail integration UI
 * 
 * Mirror of gmail.js for Microsoft 365 users.
 * Provides endpoints for the frontend email picker and send/draft actions.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../auth/permissions');
const { isMicrosoftConnected, graphFetch } = require('../../integrations/msGraphClient');
const { executeOutlookSend, executeOutlookSaveDraft } = require('../../integrations/outlookTools');

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
    const isConnected = isMicrosoftConnected(req.session);
    console.log('[Outlook] Status check — hasAccessToken:', !!req.session?.accessToken, 'oauthProvider:', req.session?.oauthProvider, 'connected:', isConnected);
    res.json({ connected: isConnected });
});

// ── List / Search Messages ──────────────────────────────────────────────────
router.get('/messages', requireAuth, async (req, res) => {
    if (!isMicrosoftConnected(req.session)) {
        return res.status(401).json({ error: 'Not connected to Outlook' });
    }

    try {
        const { search, top = '20', folder = 'inbox' } = req.query;
        const limit = Math.min(Math.max(parseInt(top) || 20, 1), 50);

        const isSentFolder = String(folder).toLowerCase() === 'sentitems';
        const orderField = isSentFolder ? 'sentDateTime' : 'receivedDateTime';

        let path = `/me/mailFolders/${folder}/messages?$top=${limit}&$orderby=${orderField} desc&$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead,hasAttachments`;

        if (search) {
            path = `/me/messages?$search="${encodeURIComponent(search)}"&$top=${limit}&$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead,hasAttachments`;
        }

        const data = await graphFetch(path, req.session);

        const messages = (data.value || []).map(msg => ({
            id: msg.id,
            from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
            to: (msg.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
            subject: msg.subject || '(no subject)',
            date: (isSentFolder ? msg.sentDateTime : msg.receivedDateTime) || msg.receivedDateTime || msg.sentDateTime || '',
            snippet: msg.bodyPreview || '',
            isRead: msg.isRead || false,
            hasAttachments: msg.hasAttachments || false,
        }));

        res.json({ messages });

    } catch (err) {
        console.error('[Outlook] Error listing messages:', err.message);
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Microsoft session expired' });
        }
        res.status(500).json({ error: err.message });
    }
});

// ── Get Single Message ──────────────────────────────────────────────────────
router.get('/messages/:id', requireAuth, async (req, res) => {
    if (!isMicrosoftConnected(req.session)) {
        return res.status(401).json({ error: 'Not connected to Outlook' });
    }

    try {
        const msg = await graphFetch(
            `/me/messages/${req.params.id}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,conversationId`,
            req.session
        );

        let body = '';
        if (msg.body?.contentType === 'text') {
            body = msg.body.content || '';
        } else {
            // Return HTML for frontend rendering
            body = msg.body?.content || '';
        }

        res.json({
            id: msg.id,
            from: msg.from?.emailAddress ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>` : '',
            to: (msg.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
            cc: (msg.ccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
            subject: msg.subject || '(no subject)',
            date: msg.receivedDateTime || '',
            body,
            bodyType: msg.body?.contentType || 'text',
            conversationId: msg.conversationId || null,
            hasAttachments: msg.hasAttachments || false,
        });

    } catch (err) {
        console.error('[Outlook] Error reading message:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Send Email (after user approval) ────────────────────────────────────────
router.post('/send', requireAuth, async (req, res) => {
    try {
        const result = await executeOutlookSend(req.body, req.session);
        res.json(result);
    } catch (err) {
        console.error('[Outlook] Error sending email:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Save as Draft ───────────────────────────────────────────────────────────
router.post('/draft', requireAuth, async (req, res) => {
    try {
        const result = await executeOutlookSaveDraft(req.body, req.session);
        res.json(result);
    } catch (err) {
        console.error('[Outlook] Error saving draft:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
