/**
 * WhatsApp Integration Routes
 * 
 * Handles: QR code generation, connection status, send messages, list chats
 */

const express = require('express');
const router = express.Router();
const whatsappSession = require('../../integrations/whatsappSession');

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Connection Status ───────────────────────────────────────────

router.get('/status', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const status = whatsappSession.getStatus(userId);
        res.json({ 
            status,
            connected: status === 'connected',
            hasSavedSession: whatsappSession.hasSavedSession(userId),
        });
    } catch (e) {
        console.error('[WhatsApp] Status error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Generate QR Code / Start Connection ─────────────────────────

router.post('/connect', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const currentStatus = whatsappSession.getStatus(userId);
        if (currentStatus === 'connected') {
            return res.json({ status: 'already_connected' });
        }

        // Start session — QR will be available via /qr endpoint
        await whatsappSession.createSession(userId, null, null, null);
        
        // Wait a moment for QR to generate
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const status = whatsappSession.getStatus(userId);
        const qrDataUrl = whatsappSession.getQRDataUrl(userId);
        
        res.json({
            status,
            qrDataUrl: qrDataUrl || null,
        });
    } catch (e) {
        console.error('[WhatsApp] Connect error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Get QR Code ─────────────────────────────────────────────────

router.get('/qr', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const status = whatsappSession.getStatus(userId);
        const qrDataUrl = whatsappSession.getQRDataUrl(userId);
        
        res.json({
            status,
            qrDataUrl: qrDataUrl || null,
            connected: status === 'connected',
        });
    } catch (e) {
        console.error('[WhatsApp] QR error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Disconnect ──────────────────────────────────────────────────

router.post('/disconnect', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        await whatsappSession.disconnect(userId);
        res.json({ success: true, status: 'disconnected' });
    } catch (e) {
        console.error('[WhatsApp] Disconnect error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── List Chats ──────────────────────────────────────────────────

router.get('/chats', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    try {
        const socket = whatsappSession.getSocket(userId);
        if (!socket) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }

        const chats = await whatsappSession.getChats(userId);
        res.json({ chats });
    } catch (e) {
        console.error('[WhatsApp] Chats error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Get Messages from a Chat ────────────────────────────────────

router.get('/messages/:jid', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { jid } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    
    try {
        const result = await whatsappSession.getMessages(userId, jid, limit);
        res.json(result);
    } catch (e) {
        console.error('[WhatsApp] Messages error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── Send Message ────────────────────────────────────────────────

router.post('/send', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" and "message" fields' });
    }

    try {
        const result = await whatsappSession.sendMessage(userId, to, message);
        console.log(`[WhatsApp] Message sent by user ${userId} to ${to}`);
        res.json(result);
    } catch (e) {
        console.error('[WhatsApp] Send error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
