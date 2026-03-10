/**
 * WhatsApp Session Manager
 * 
 * Manages per-user WhatsApp connections using Baileys (multi-device).
 * Sessions are persisted on disk so users don't need to re-scan QR codes
 * after server restarts.
 * 
 * Captures messages, chats, and contacts via Baileys events for the AI to read.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const SESSION_BASE_DIR = path.join(__dirname, '..', 'data', 'whatsapp-sessions');

// Ensure base dir exists
if (!fs.existsSync(SESSION_BASE_DIR)) {
    fs.mkdirSync(SESSION_BASE_DIR, { recursive: true });
}

// Minimal pino-compatible silent logger for Baileys
const silentLogger = {
    level: 'silent',
    child: () => silentLogger,
    info: () => {}, warn: () => {}, error: (...args) => console.error('[WhatsApp]', ...args),
    debug: () => {}, trace: () => {}, fatal: () => {},
};

// In-memory store of active sockets per user
const activeSessions = new Map(); // userId -> { socket, status, qr, qrDataUrl, eventCallbacks, messageLog, chatMap, contactMap }

/**
 * Get session directory for a user
 */
function getSessionDir(userId) {
    return path.join(SESSION_BASE_DIR, userId);
}

/**
 * Get or create a WhatsApp session for a user.
 * Returns the socket if already connected.
 */
async function createSession(userId, onQR, onConnected, onDisconnected) {
    // If already connected, return existing
    const existing = activeSessions.get(userId);
    if (existing && existing.status === 'connected' && existing.socket) {
        return existing.socket;
    }

    const sessionDir = getSessionDir(userId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['BeeFlow', 'Chrome', '120.0'],
        logger: silentLogger,
        syncFullHistory: true, // Sync full history including personal chats
        getMessage: async (key) => {
            // Required for history sync — look up messages from our log
            const session = activeSessions.get(userId);
            if (!session) return undefined;
            const msg = session.messageLog.find(m => m.id === key.id && m.jid === key.remoteJid);
            return msg ? { conversation: msg.text } : undefined;
        },
    });

    const sessionData = {
        socket,
        status: 'connecting',
        qr: null,
        qrDataUrl: null,
        eventCallbacks: { onQR, onConnected, onDisconnected },
        messageLog: [],       // All captured messages
        chatMap: new Map(),   // jid -> { name, isGroup, unreadCount, lastTimestamp }
        contactMap: new Map(), // jid -> { name, phone, ... }
    };
    activeSessions.set(userId, sessionData);

    // ── Capture real-time messages ──
    socket.ev.on('messages.upsert', ({ messages: msgs, type }) => {
        for (const msg of msgs) {
            if (!msg.message) continue; // skip protocol messages
            const text = msg.message.conversation
                || msg.message.extendedTextMessage?.text
                || msg.message.imageMessage?.caption
                || msg.message.videoMessage?.caption
                || msg.message.documentMessage?.title
                || msg.message.contactMessage?.displayName
                || (msg.message.locationMessage ? '[location]' : null)
                || (msg.message.stickerMessage ? '[sticker]' : null)
                || (msg.message.audioMessage ? '[audio]' : null)
                || (msg.message.reactionMessage ? `[reaction: ${msg.message.reactionMessage.text}]` : null)
                || '[media]';
            
            const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();

            // Avoid duplicates
            const exists = sessionData.messageLog.some(m => m.id === msg.key.id && m.jid === msg.key.remoteJid);
            if (!exists) {
                sessionData.messageLog.push({
                    jid: msg.key.remoteJid,
                    fromMe: msg.key.fromMe,
                    participant: msg.key.participant || null,
                    pushName: msg.pushName || null,
                    text,
                    timestamp: ts,
                    type,
                    id: msg.key.id,
                });
            }

            // Track chat metadata
            const chatJid = msg.key.remoteJid;
            if (chatJid && chatJid !== 'status@broadcast') {
                updateChatEntry(sessionData, chatJid, {
                    pushName: msg.pushName,
                    timestamp: ts,
                    isIncoming: !msg.key.fromMe && type === 'notify',
                });
            }
        }

        // Keep only last 1000 messages in memory
        if (sessionData.messageLog.length > 1000) {
            sessionData.messageLog = sessionData.messageLog.slice(-1000);
        }
    });

    // ── Capture historical messages (synced on connection) ──
    socket.ev.on('messaging-history.set', ({ messages: msgs, chats: historicalChats, contacts: historicalContacts, isLatest }) => {
        console.log(`[WhatsApp] History sync for ${userId}: ${msgs?.length || 0} messages, ${historicalChats?.length || 0} chats, ${historicalContacts?.length || 0} contacts (isLatest: ${isLatest})`);

        // Process historical chats
        if (historicalChats) {
            for (const chat of historicalChats) {
                const jid = chat.id;
                if (!jid || jid === 'status@broadcast') continue;
                const isGroup = jid.endsWith('@g.us');
                const existing = sessionData.chatMap.get(jid) || {
                    jid,
                    name: chat.name || jid.replace('@s.whatsapp.net', '').replace('@g.us', ''),
                    isGroup,
                    unreadCount: 0,
                    lastTimestamp: 0,
                };
                if (chat.name) existing.name = chat.name;
                if (chat.unreadCount) existing.unreadCount = chat.unreadCount;
                if (chat.conversationTimestamp) {
                    const ts = Number(chat.conversationTimestamp) * 1000;
                    existing.lastTimestamp = Math.max(existing.lastTimestamp, ts);
                }
                sessionData.chatMap.set(jid, existing);
            }
        }

        // Process historical contacts
        if (historicalContacts) {
            for (const contact of historicalContacts) {
                if (contact.id) {
                    sessionData.contactMap.set(contact.id, {
                        name: contact.name || contact.notify || contact.verifiedName || '',
                        phone: contact.id.replace('@s.whatsapp.net', ''),
                    });
                    // Also update chatMap name if we have a contact name
                    const chatEntry = sessionData.chatMap.get(contact.id);
                    if (chatEntry && (contact.name || contact.notify || contact.verifiedName)) {
                        chatEntry.name = contact.name || contact.notify || contact.verifiedName;
                    }
                }
            }
        }

        // Process historical messages
        if (msgs) {
            for (const msg of msgs) {
                if (!msg.message) continue;
                const text = msg.message.conversation
                    || msg.message.extendedTextMessage?.text
                    || msg.message.imageMessage?.caption
                    || msg.message.videoMessage?.caption
                    || '[media]';
                
                const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();
                const exists = sessionData.messageLog.some(m => m.id === msg.key.id && m.jid === msg.key.remoteJid);
                if (!exists) {
                    sessionData.messageLog.push({
                        jid: msg.key.remoteJid,
                        fromMe: msg.key.fromMe,
                        participant: msg.key.participant || null,
                        pushName: msg.pushName || null,
                        text,
                        timestamp: ts,
                        type: 'history',
                        id: msg.key.id,
                    });
                }
            }

            // Sort by timestamp and keep last 1000
            sessionData.messageLog.sort((a, b) => a.timestamp - b.timestamp);
            if (sessionData.messageLog.length > 1000) {
                sessionData.messageLog = sessionData.messageLog.slice(-1000);
            }
        }
    });

    // ── Track chat list updates ──
    socket.ev.on('chats.upsert', (chats) => {
        for (const chat of chats) {
            const jid = chat.id;
            if (!jid || jid === 'status@broadcast') continue;
            const isGroup = jid.endsWith('@g.us');
            const existing = sessionData.chatMap.get(jid) || {
                jid,
                name: chat.name || jid.replace('@s.whatsapp.net', '').replace('@g.us', ''),
                isGroup,
                unreadCount: 0,
                lastTimestamp: 0,
            };
            if (chat.name) existing.name = chat.name;
            if (chat.unreadCount !== undefined) existing.unreadCount = chat.unreadCount;
            if (chat.conversationTimestamp) {
                existing.lastTimestamp = Math.max(existing.lastTimestamp, Number(chat.conversationTimestamp) * 1000);
            }
            sessionData.chatMap.set(jid, existing);
        }
    });

    socket.ev.on('chats.update', (updates) => {
        for (const update of updates) {
            const jid = update.id;
            if (!jid) continue;
            const existing = sessionData.chatMap.get(jid);
            if (existing) {
                if (update.name) existing.name = update.name;
                if (update.unreadCount !== undefined) existing.unreadCount = update.unreadCount;
                if (update.conversationTimestamp) {
                    existing.lastTimestamp = Math.max(existing.lastTimestamp, Number(update.conversationTimestamp) * 1000);
                }
            }
        }
    });

    // ── Track contacts ──
    socket.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
            if (!contact.id) continue;
            const name = contact.name || contact.notify || contact.verifiedName || '';
            sessionData.contactMap.set(contact.id, {
                name,
                phone: contact.id.replace('@s.whatsapp.net', ''),
            });
            // Update chat name from contact info
            const chatEntry = sessionData.chatMap.get(contact.id);
            if (chatEntry && name) {
                chatEntry.name = name;
            }
        }
    });

    socket.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
            if (!update.id) continue;
            const existing = sessionData.contactMap.get(update.id);
            if (existing) {
                if (update.name || update.notify || update.verifiedName) {
                    existing.name = update.name || update.notify || update.verifiedName;
                    // Also update chatMap
                    const chatEntry = sessionData.chatMap.get(update.id);
                    if (chatEntry) chatEntry.name = existing.name;
                }
            }
        }
    });

    // ── Handle QR code and connection ──
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[WhatsApp] QR code generated for user ${userId}`);
            sessionData.qr = qr;
            try {
                sessionData.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
            } catch (err) {
                console.error('[WhatsApp] QR generation error:', err.message);
            }
            sessionData.status = 'qr_ready';
            if (onQR) onQR(qr, sessionData.qrDataUrl);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`[WhatsApp] Connection closed for user ${userId}, status: ${statusCode}, reconnect: ${shouldReconnect}`);

            if (shouldReconnect) {
                sessionData.status = 'reconnecting';
                setTimeout(() => {
                    createSession(userId, onQR, onConnected, onDisconnected);
                }, 3000);
            } else {
                sessionData.status = 'disconnected';
                activeSessions.delete(userId);
                try {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                } catch (e) { /* ignore */ }
                if (onDisconnected) onDisconnected('logged_out');
            }
        }

        if (connection === 'open') {
            console.log(`[WhatsApp] Connected for user ${userId}`);
            sessionData.status = 'connected';
            sessionData.qr = null;
            sessionData.qrDataUrl = null;
            if (onConnected) onConnected();
        }
    });

    // Save credentials on update
    socket.ev.on('creds.update', saveCreds);

    return socket;
}

/**
 * Helper to update a chat entry in the chatMap
 */
function updateChatEntry(sessionData, chatJid, { pushName, timestamp, isIncoming }) {
    const isGroup = chatJid.endsWith('@g.us');
    const existing = sessionData.chatMap.get(chatJid) || {
        jid: chatJid,
        name: chatJid.replace('@s.whatsapp.net', '').replace('@g.us', ''),
        isGroup,
        unreadCount: 0,
        lastTimestamp: 0,
    };
    // For personal chats, use pushName or contact name
    if (pushName && !isGroup) {
        existing.name = pushName;
    }
    // Also try contact map for a better name
    const contact = sessionData.contactMap.get(chatJid);
    if (contact?.name && !isGroup) {
        existing.name = contact.name;
    }
    existing.lastTimestamp = Math.max(existing.lastTimestamp, timestamp || 0);
    if (isIncoming) existing.unreadCount++;
    sessionData.chatMap.set(chatJid, existing);
}

/**
 * Get the status of a user's WhatsApp session.
 */
function getStatus(userId) {
    const session = activeSessions.get(userId);
    if (!session) {
        const sessionDir = getSessionDir(userId);
        if (fs.existsSync(path.join(sessionDir, 'creds.json'))) {
            return 'saved';
        }
        return 'disconnected';
    }
    return session.status;
}

/**
 * Get the QR code data URL for a user's pending session.
 */
function getQRDataUrl(userId) {
    const session = activeSessions.get(userId);
    return session?.qrDataUrl || null;
}

/**
 * Get the active socket for a user. Returns null if not connected.
 */
function getSocket(userId) {
    const session = activeSessions.get(userId);
    if (session && session.status === 'connected') {
        return session.socket;
    }
    return null;
}

/**
 * Disconnect a user's WhatsApp session.
 */
async function disconnect(userId) {
    const session = activeSessions.get(userId);
    if (session?.socket) {
        try {
            await session.socket.logout();
        } catch (e) {
            try { session.socket.end(); } catch (e2) { /* ignore */ }
        }
    }
    activeSessions.delete(userId);
    const sessionDir = getSessionDir(userId);
    try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
}

/**
 * Send a text message to a WhatsApp contact.
 */
async function sendMessage(userId, jid, text) {
    const socket = getSocket(userId);
    if (!socket) throw new Error('WhatsApp not connected');
    const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
    await socket.sendMessage(formattedJid, { text });
    return { success: true, to: formattedJid };
}

/**
 * Get recent chats for a user using chatMap, contacts, and groups.
 */
async function getChats(userId) {
    const session = activeSessions.get(userId);
    if (!session || session.status !== 'connected') throw new Error('WhatsApp not connected');

    const chats = [];
    const seenJids = new Set();

    // Use chatMap (populated from messages.upsert, chats.upsert, chats.update, and history sync)
    for (const [jid, chat] of session.chatMap) {
        seenJids.add(jid);
        // Resolve best name from contact map
        const contactName = session.contactMap.get(jid)?.name;
        chats.push({
            ...chat,
            name: contactName || chat.name,
        });
    }

    // Also include contacts that haven't had recent messages but are in the contact map
    for (const [jid, contact] of session.contactMap) {
        if (!seenJids.has(jid) && jid.endsWith('@s.whatsapp.net') && contact.name) {
            seenJids.add(jid);
            chats.push({
                jid,
                name: contact.name,
                isGroup: false,
                unreadCount: 0,
                lastTimestamp: 0,
            });
        }
    }

    // Fetch groups
    try {
        const groups = await session.socket.groupFetchAllParticipating?.() || {};
        for (const [jid, group] of Object.entries(groups)) {
            if (!seenJids.has(jid)) {
                seenJids.add(jid);
                chats.push({
                    jid,
                    name: group.subject || jid,
                    isGroup: true,
                    unreadCount: 0,
                    lastTimestamp: 0,
                });
            }
            // Update name for groups already in chats
            const existing = chats.find(c => c.jid === jid);
            if (existing && group.subject) existing.name = group.subject;
        }
    } catch (e) { /* groups might not be available yet */ }

    return chats;
}

/**
 * Get messages from a specific chat using the in-memory message log.
 */
async function getMessages(userId, jid, limit = 20) {
    const session = activeSessions.get(userId);
    if (!session || session.status !== 'connected') throw new Error('WhatsApp not connected');

    const formattedJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;

    // Get messages from our message log
    const chatMessages = session.messageLog
        .filter(m => m.jid === formattedJid)
        .slice(-limit)
        .map(m => ({
            id: m.id,
            from: m.fromMe ? 'me' : (m.pushName || session.contactMap.get(m.participant || formattedJid)?.name || m.participant || formattedJid),
            text: m.text,
            timestamp: m.timestamp,
            fromMe: m.fromMe,
        }));

    // Get contact/chat name for context
    const contactName = session.contactMap.get(formattedJid)?.name
        || session.chatMap.get(formattedJid)?.name
        || formattedJid;

    return {
        jid: formattedJid,
        chatName: contactName,
        messages: chatMessages,
        count: chatMessages.length,
        note: chatMessages.length === 0
            ? 'No messages cached yet. Messages are captured from history sync and real-time. If the chat exists but has no messages here, try sending a message first.'
            : undefined,
    };
}

/**
 * Try to restore a saved session (auto-reconnect on server start).
 */
async function restoreSession(userId) {
    const sessionDir = getSessionDir(userId);
    if (!fs.existsSync(path.join(sessionDir, 'creds.json'))) {
        return false;
    }
    try {
        await createSession(userId, null, null, null);
        return true;
    } catch (e) {
        console.error(`[WhatsApp] Failed to restore session for user ${userId}:`, e.message);
        return false;
    }
}

/**
 * Check if a user has a saved session (credentials exist).
 */
function hasSavedSession(userId) {
    const sessionDir = getSessionDir(userId);
    return fs.existsSync(path.join(sessionDir, 'creds.json'));
}

module.exports = {
    createSession,
    getStatus,
    getQRDataUrl,
    getSocket,
    disconnect,
    sendMessage,
    getChats,
    getMessages,
    restoreSession,
    hasSavedSession,
};
