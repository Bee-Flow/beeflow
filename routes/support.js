/**
 * Customer Support Routes — AI-first inbox for Bee Flow B.V. customers.
 *
 * Endpoints:
 *   POST   /threads                 — create thread (anon from marketing, or logged-in tenant)
 *   GET    /threads                 — staff inbox (gated by admin_support)
 *   GET    /threads/mine            — logged-in user's own threads
 *   GET    /threads/:id             — view thread (own thread, staff, or anon w/ token)
 *   POST   /threads/:id/messages    — append a reply
 *   PATCH  /threads/:id             — staff status/priority/assignee update
 *   GET    /threads/:id/stream      — SSE live updates for staff inbox
 *   GET    /config                  — staff: read AI agent + KB config
 *   PUT    /config                  — super-admin: update AI agent + KB config
 *
 * The AI auto-responder runs in the background after thread creation (and
 * after requester replies while AI is still in the loop).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { EventEmitter } = require('events');

const supportStore = require('../stores/supportStore');
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const notificationStore = require('../stores/notificationStore');
const { setupSSE } = require('../core/sseHelpers');
const { resolveUserOrgIds } = require('../auth');
const { runAiAutoResponder } = require('../services/supportAiResponder');
const {
    sendThreadCreatedEmail,
    sendAiReplyEmail,
    sendStaffReplyEmail,
    sendThreadResolvedEmail,
    sendOrNotifyStaff,
} = require('../utils/supportEmails');

const router = express.Router();

// ── PII-safe logging helper ──────────────────────────────────────────────
// Email + body content must NEVER appear in container logs verbatim.
// `_redact()` truncates and masks before any console.log/warn/error.
function _redactEmail(addr) {
    if (!addr || typeof addr !== 'string') return '(no-addr)';
    const at = addr.indexOf('@');
    if (at < 1) return addr.slice(0, 3) + '***';
    return addr.slice(0, Math.min(2, at)) + '***@' + addr.slice(at + 1).split('.')[0].slice(0, 1) + '***';
}
function _shortId(id) {
    return (id || '').toString().slice(0, 8);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isSuperAdmin(req) {
    return !!(req.session?.isAdmin || req.session?.user?.role === 'admin');
}

function getUserId(req) {
    return req.session?.user?.id || req.session?.userId || null;
}

function getUserDisplay(req) {
    const u = req.session?.user;
    if (!u) return null;
    return u.displayName || u.name || u.email || u.username || u.id || null;
}

async function _hasAdminSupport(req) {
    if (isSuperAdmin(req)) return true;
    const userId = getUserId(req);
    if (!userId) return false;
    try {
        const { getUserPermissions } = require('../auth/permissions');
        // getUserPermissions(userId, session) — pass IDs, not the whole req.
        // Returns an array of permission strings (or ['all'] for admins).
        const perms = await getUserPermissions(userId, req.session || null);
        if (Array.isArray(perms)) return perms.includes('admin_support') || perms.includes('all');
        if (perms instanceof Set) return perms.has('admin_support') || perms.has('all');
        return false;
    } catch (e) {
        console.warn('[Support] _hasAdminSupport check failed:', e.message);
        return false;
    }
}

function _clientHost() {
    return `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.ai'}`;
}

function _buildThreadUrl(thread, { forStaff = false } = {}) {
    const host = _clientHost();
    if (forStaff) return `${host}/app/admin?tab=support&thread=${thread.id}`;
    if (thread.requester_user_id) return `${host}/app?support=${thread.id}`;
    const token = supportStore.buildAccessToken(thread.id, thread.requester_email);
    return `${host}/support/t/${thread.id}?token=${token}`;
}

// ── SSE event bus for the staff inbox ─────────────────────────────────────
const supportEvents = new EventEmitter();
supportEvents.setMaxListeners(50);

function _emit(event, payload) {
    try { supportEvents.emit('event', { event, data: payload }); } catch {}
}

function _logListenerPressure() {
    // Warn (not crash) when the bus approaches the configured cap. Half-closed
    // SSE sockets can otherwise pile up listeners silently — node would only
    // emit a MaxListenersExceededWarning once at the threshold.
    const n = supportEvents.listenerCount('event');
    if (n > 30) {
        console.warn(`[Support] SSE listener pressure: ${n} active subscribers (cap 50)`);
    }
}

// ── Staff notify ─────────────────────────────────────────────────────────
// Notifies all super admins (role === 'admin') via in-app notification.
// configStore key `support_notify_emails` may carry extra cc emails if
// staff want a personal copy outside the in-app channel.

async function notifyStaff({ title, message, threadId, category = 'heads_up' }) {
    try {
        const users = await userStore.getAllUsers();
        const admins = (users || []).filter(u => u.role === 'admin');
        for (const u of admins) {
            try {
                await notificationStore.createNotification({
                    userId: u.id,
                    taskId: threadId,
                    category,
                    title,
                    message,
                });
            } catch (e) {
                console.warn('[Support] notifyStaff createNotification error:', e.message);
            }
        }
    } catch (e) {
        console.warn('[Support] notifyStaff lookup failed:', e.message);
    }
}

// ── Honeypot + minimum-form-age guard for anonymous submissions ──────────
function _isLikelySpam(body, source) {
    if (source !== 'marketing') return false;
    // Hidden honeypot field — bots fill it; humans don't see it.
    if (body && typeof body.website_url === 'string' && body.website_url.trim().length > 0) {
        return true;
    }
    // Minimum render age — anything submitted within 2s of render is bot-like.
    const ts = parseInt(body?.rendered_at_ms, 10);
    if (Number.isFinite(ts)) {
        if (Date.now() - ts < 2000) return true;
    }
    return false;
}

const publicCreateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many submissions from this IP. Try again in a minute.' },
});

// Read-side limiter — defends against UUID brute-force on /threads/:id. Real
// users polling a thread won't hit this; an attacker spraying UUIDs will.
const threadReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Slow down.' },
    // Don't block staff: skip the limiter when the session is authenticated
    // (the limiter only matters for anonymous token-pull traffic).
    skip: (req) => !!getUserId(req),
});

// Per-email anonymous-submit limiter — caps how often the same email can be
// used to probe whether an address is registered. Uses a small in-memory LRU.
// Note: not durable across restarts, but acceptable for an enumeration
// mitigation (an attacker that can survive restarts already has bigger
// problems).
const _emailHits = new Map(); // sha256-hash → [timestamps]
const EMAIL_LIMIT_WINDOW_MS = 60 * 1000;
const EMAIL_LIMIT_MAX = 3;
const _crypto = require('crypto');
function _hashEmail(addr) {
    return _crypto.createHash('sha256').update((addr || '').toLowerCase()).digest('hex');
}
function _emailRateLimitOk(email) {
    if (!email) return true; // logged-in user: skip
    const key = _hashEmail(email);
    const now = Date.now();
    const cutoff = now - EMAIL_LIMIT_WINDOW_MS;
    let hits = _emailHits.get(key) || [];
    hits = hits.filter(t => t > cutoff);
    if (hits.length >= EMAIL_LIMIT_MAX) {
        _emailHits.set(key, hits);
        return false;
    }
    hits.push(now);
    _emailHits.set(key, hits);
    // Crude LRU prune: drop anything stale once we breach 5k entries.
    if (_emailHits.size > 5000) {
        for (const [k, v] of _emailHits) {
            if (!v.some(t => t > cutoff)) _emailHits.delete(k);
        }
    }
    return true;
}

// ── Validate body for thread creation ────────────────────────────────────
function _validateCreateBody(body) {
    const subject = (body?.subject || '').toString().trim();
    const message = (body?.message || '').toString().trim();
    if (!subject) return { error: 'subject is required' };
    if (subject.length > 200) return { error: 'subject is too long (max 200 chars)' };
    if (!message) return { error: 'message is required' };
    if (message.length > 5000) return { error: 'message is too long (max 5000 chars)' };
    return { subject, message };
}

// ──────────────────────────────────────────────────────────────────────────
// POST /threads — create thread (anon or authenticated)
// Body: { subject, message, email?, name?, source?, website_url?, rendered_at_ms? }
// ──────────────────────────────────────────────────────────────────────────
router.post('/threads', publicCreateLimiter, async (req, res) => {
    try {
        const body = req.body || {};
        const source = body.source === 'in_app' ? 'in_app' : 'marketing';

        if (_isLikelySpam(body, source)) {
            // Silently 200 so bots get no signal.
            return res.status(200).json({ ok: true, threadId: null, spam: true });
        }

        const val = _validateCreateBody(body);
        if (val.error) return res.status(400).json({ error: val.error });

        const userId = getUserId(req);
        let orgIds = null;
        let orgId = null;
        let requesterUserId = userId;
        let requesterEmail = (body.email || '').trim().toLowerCase();
        let requesterName = (body.name || '').trim() || null;
        let requesterOrgRole = null;
        let requesterOrgName = null;

        if (userId) {
            // Logged-in tenant — bind the thread to the user's account + org +
            // role within that org. Email + display name are resolved from (in
            // order): the session user, then the user record. We never reject
            // a logged-in submission for "missing email" — the server already
            // knows who they are, even if the stored email is null (e.g. SSO
            // accounts where the username is the contact handle).
            const sessUser = req.session?.user || {};
            requesterEmail = (sessUser.email || requesterEmail || '').trim().toLowerCase();
            requesterName = requesterName
                || sessUser.displayName
                || sessUser.name
                || null;
            requesterOrgRole = sessUser.orgRole || null;
            try {
                const user = await userStore.getUser(userId);
                if (user) {
                    if (!requesterEmail) requesterEmail = (user.email || '').trim().toLowerCase();
                    if (!requesterEmail && typeof user.username === 'string' && user.username.includes('@')) {
                        requesterEmail = user.username.trim().toLowerCase();
                    }
                    if (!requesterName) {
                        requesterName = user.displayName
                            || [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
                            || user.username
                            || null;
                    }
                    requesterOrgRole = requesterOrgRole || user.orgRole || null;
                }
            } catch {}
            if (!requesterEmail) {
                requesterEmail = `user-${userId}@noemail.beeflow.local`;
            }
            orgIds = await resolveUserOrgIds(req);
            if (orgIds && orgIds.size > 0) orgId = Array.from(orgIds)[0];
            if (!orgId && sessUser.organizationId) orgId = sessUser.organizationId;
        } else {
            // Anonymous (marketing) submissions: require a real email to reply.
            if (!requesterEmail) {
                return res.status(400).json({ error: 'email is required for anonymous submissions' });
            }
            // Best-effort: if this email matches an existing user, link the
            // thread to their account + org + role. Otherwise leave it truly
            // anonymous and staff will see "Guest".
            try {
                const match = await userStore.getUserByEmail(requesterEmail);
                if (match) {
                    requesterUserId = match.id;
                    requesterOrgRole = match.orgRole || null;
                    if (!orgId) orgId = match.organizationId || null;
                    if (!requesterName) {
                        requesterName = match.displayName
                            || [match.firstName, match.lastName].filter(Boolean).join(' ').trim()
                            || match.username
                            || null;
                    }
                }
            } catch {}
        }

        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(requesterEmail)) {
            return res.status(400).json({ error: 'invalid email' });
        }

        // Look up the organisation name for the badge/chip in the inbox.
        // Snapshot it on the thread — orgs can be renamed and we want the
        // ticket history to reflect what was true at submit time.
        if (orgId) {
            try {
                const org = await userStore.getOrganization(orgId);
                if (org && org.name) requesterOrgName = org.name;
            } catch {}
        }

        // For in_app: source must match a logged-in user.
        const effectiveSource = userId ? 'in_app' : 'marketing';
        const skipOutboundEmail = requesterEmail.endsWith('@noemail.beeflow.local');

        // Per-email submit cap (anonymous only). Mitigates enumeration by
        // an attacker that varies the IP but reuses the same target email.
        if (!userId && !_emailRateLimitOk(requesterEmail)) {
            return res.status(429).json({
                error: 'Too many submissions for this email. Try again in a minute.',
            });
        }

        const thread = await supportStore.createThread({
            organizationId: orgId,
            requesterUserId,
            requesterEmail,
            requesterName,
            requesterOrgRole,
            requesterOrgName,
            source: effectiveSource,
            subject: val.subject,
            requesterIp: req.ip || req.headers['x-forwarded-for'] || null,
            requesterUa: req.headers['user-agent'] || null,
        });

        const firstMsg = await supportStore.appendMessage({
            threadId: thread.id,
            authorKind: 'requester',
            authorUserId: userId,
            authorDisplay: requesterName || requesterEmail,
            body: val.message,
        });

        // Audit trail entry for the requester's opening message.
        supportStore.recordThreadEvent({
            threadId: thread.id,
            actorUserId: requesterUserId,
            actorKind: 'requester',
            action: 'reply',
            payload: { initial: true, source: effectiveSource },
        }).catch(() => {});

        const requesterUrl = _buildThreadUrl(thread);
        const accessToken = !userId ? supportStore.buildAccessToken(thread.id, requesterEmail) : null;

        // Confirmation email — failures surface to staff via sendOrNotifyStaff.
        if (!skipOutboundEmail) {
            sendOrNotifyStaff(
                sendThreadCreatedEmail,
                { to: requesterEmail, requesterName, subject: val.subject, threadUrl: requesterUrl },
                { kind: 'thread_created', threadId: thread.id, messageId: firstMsg?.id },
            );
        }

        notifyStaff({
            title: `New support: ${val.subject}`,
            // No email in the notification body — staff opens the thread to see it.
            message: `${effectiveSource === 'marketing' ? 'Marketing site' : 'In-app'} · ${_redactEmail(requesterEmail)}`,
            threadId: thread.id,
        }).catch(() => {});

        _emit('thread_created', { threadId: thread.id });

        // Kick off the AI auto-responder fire-and-forget for both sources.
        // The marketing form polls /api/support/threads/:id?token=… every few
        // seconds to surface the AI reply when it lands — much more robust
        // than the previous "block the HTTP response for up to 15s" approach.
        Promise.resolve().then(() => runAiAutoResponder(thread.id))
            .then(result => {
                if (result && result.message) {
                    if (!skipOutboundEmail) {
                        sendOrNotifyStaff(
                            sendAiReplyEmail,
                            {
                                to: requesterEmail,
                                requesterName,
                                subject: val.subject,
                                replyBody: result.message.body,
                                threadUrl: requesterUrl,
                                escalated: result.escalated,
                            },
                            { kind: 'ai_reply', threadId: thread.id, messageId: result.message.id },
                        );
                    }
                    if (result.escalated) {
                        notifyStaff({
                            title: `AI escalated: ${val.subject}`,
                            message: result.escalateReason || 'AI handed off to staff',
                            threadId: thread.id,
                        }).catch(() => {});
                    }
                    if (userId) {
                        notificationStore.createNotification({
                            userId,
                            taskId: thread.id,
                            category: 'info',
                            title: result.escalated ? 'Bee Flow Support — a human will reply' : 'Bee Flow Support — AI replied',
                            message: val.subject,
                        }).catch(() => {});
                    }
                    _emit('thread_updated', { threadId: thread.id });
                }
            })
            .catch(e => console.error(`[Support] AI auto-responder background failure (thread=${_shortId(thread.id)}):`, e.message));

        res.status(201).json({
            ok: true,
            threadId: thread.id,
            accessToken,
            threadUrl: requesterUrl,
        });
    } catch (err) {
        console.error(`[Support] POST /threads error (from=${_redactEmail(req.body?.email)}):`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /threads — staff inbox
// ──────────────────────────────────────────────────────────────────────────
router.get('/threads', async (req, res) => {
    try {
        if (!(await _hasAdminSupport(req))) {
            return res.status(403).json({ error: 'admin_support permission required' });
        }
        const { status, q, assignee, limit, offset } = req.query;
        const statusList = status ? status.split(',').map(s => s.trim()).filter(Boolean) : null;
        const threads = await supportStore.listThreads({
            statusIn: statusList && statusList.length ? statusList : null,
            q: q || null,
            assigneeUserId: assignee || null,
            limit: limit ? parseInt(limit, 10) : 100,
            offset: offset ? parseInt(offset, 10) : 0,
        });
        const counts = await supportStore.countThreadsByStatus();
        res.json({ threads, counts });
    } catch (err) {
        console.error('[Support] GET /threads error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /threads/mine — logged-in user's own threads
// ──────────────────────────────────────────────────────────────────────────
router.get('/threads/mine', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const threads = await supportStore.listThreads({ requesterUserId: userId, limit: 50 });
        res.json({ threads });
    } catch (err) {
        console.error('[Support] GET /threads/mine error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /threads/:id — view a thread (requester, staff, or anon w/ token)
// ──────────────────────────────────────────────────────────────────────────
router.get('/threads/:id', threadReadLimiter, async (req, res) => {
    try {
        const thread = await supportStore.getThread(req.params.id);

        // Mix "not found" and "no access" into a single 404 so an attacker
        // can't distinguish "thread exists but I can't read it" from "thread
        // doesn't exist at all" — that distinction would enable UUID
        // enumeration.
        const NOT_FOUND = () => res.status(404).json({ error: 'Not found' });
        if (!thread) return NOT_FOUND();

        const userId = getUserId(req);
        const staff = await _hasAdminSupport(req);
        const isOwner = userId && thread.requester_user_id === userId;
        // Anonymous-token access stays valid even after a thread is later
        // linked to a user (via email match). Marketing-form requesters need
        // to come back via the email link without ever logging in.
        const tokenOK = req.query.token
            && supportStore.verifyAccessToken(thread.id, thread.requester_email, req.query.token);

        if (!staff && !isOwner && !tokenOK) return NOT_FOUND();

        const messages = await supportStore.getThreadMessages(thread.id, { includeInternal: staff });
        res.json({ thread, messages, viewerIsStaff: !!staff });
    } catch (err) {
        console.error(`[Support] GET /threads/:id error (id=${_shortId(req.params.id)}):`, err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// POST /threads/:id/messages — append a reply
// ──────────────────────────────────────────────────────────────────────────
router.post('/threads/:id/messages', async (req, res) => {
    try {
        const thread = await supportStore.getThread(req.params.id);
        const NOT_FOUND = () => res.status(404).json({ error: 'Not found' });
        if (!thread) return NOT_FOUND();

        const userId = getUserId(req);
        const staff = await _hasAdminSupport(req);
        const isOwner = userId && thread.requester_user_id === userId;
        const tokenOK = req.query.token
            && supportStore.verifyAccessToken(thread.id, thread.requester_email, req.query.token);

        if (!staff && !isOwner && !tokenOK) return NOT_FOUND();

        const body = (req.body?.body || '').toString().trim();
        const internalNote = !!req.body?.internalNote && staff;
        if (!body) return res.status(400).json({ error: 'body required' });
        if (body.length > 10000) return res.status(400).json({ error: 'body too long (max 10000 chars)' });

        const authorKind = staff ? 'staff' : 'requester';
        const authorDisplay = staff
            ? (getUserDisplay(req) || 'Bee Flow Support')
            : (thread.requester_name || thread.requester_email);

        const msg = await supportStore.appendMessage({
            threadId: thread.id,
            authorKind,
            authorUserId: userId,
            authorDisplay,
            body,
            internalNote,
        });

        supportStore.recordThreadEvent({
            threadId: thread.id,
            actorUserId: userId,
            actorKind: authorKind === 'staff' ? 'staff' : 'requester',
            action: internalNote ? 'internal_note' : 'reply',
            payload: { messageId: msg?.id, length: body.length },
        }).catch(() => {});

        // Side-effects ─────────────────────────────────────────────────────
        if (staff && !internalNote) {
            // Atomic transition wins concurrent first-replies: COALESCE leaves
            // any already-set first_response_at / assignee_user_id intact.
            await supportStore.firstStaffReplyTransition(thread.id, userId);

            sendOrNotifyStaff(
                sendStaffReplyEmail,
                {
                    to: thread.requester_email,
                    requesterName: thread.requester_name,
                    subject: thread.subject,
                    staffName: authorDisplay,
                    replyBody: body,
                    threadUrl: _buildThreadUrl(thread),
                },
                { kind: 'staff_reply', threadId: thread.id, messageId: msg?.id },
            );

            if (thread.requester_user_id) {
                notificationStore.createNotification({
                    userId: thread.requester_user_id,
                    taskId: thread.id,
                    category: 'info',
                    title: 'Bee Flow Support replied',
                    message: thread.subject,
                }).catch(() => {});
            }
        } else if (!staff) {
            // Requester reply → flip to awaiting_agent; if AI hasn't escalated
            // yet, give the AI one more shot.
            await supportStore.updateThread(thread.id, { status: 'awaiting_agent' });

            if (thread.assignee_user_id) {
                notificationStore.createNotification({
                    userId: thread.assignee_user_id,
                    taskId: thread.id,
                    category: 'heads_up',
                    title: 'Customer replied',
                    message: thread.subject,
                }).catch(() => {});
            } else {
                notifyStaff({
                    title: `Customer replied: ${thread.subject}`,
                    message: _redactEmail(thread.requester_email),
                    threadId: thread.id,
                }).catch(() => {});
            }

            // Re-run AI on requester follow-up, but only if the thread is
            // still AI-handled (no staff has weighed in). Failure goes via
            // the responder's internal escalate-on-error path.
            if (!thread.first_response_at && thread.ai_handled) {
                Promise.resolve().then(() => runAiAutoResponder(thread.id))
                    .then(result => {
                        if (result && result.message) {
                            sendOrNotifyStaff(
                                sendAiReplyEmail,
                                {
                                    to: thread.requester_email,
                                    requesterName: thread.requester_name,
                                    subject: thread.subject,
                                    replyBody: result.message.body,
                                    threadUrl: _buildThreadUrl(thread),
                                    escalated: result.escalated,
                                },
                                { kind: 'ai_reply', threadId: thread.id, messageId: result.message.id },
                            );
                            _emit('thread_updated', { threadId: thread.id });
                        }
                    })
                    .catch(e => console.warn(`[Support] follow-up AI failed (thread=${_shortId(thread.id)}):`, e.message));
            }
        }

        _emit('thread_updated', { threadId: thread.id });
        res.status(201).json({ ok: true, message: msg });
    } catch (err) {
        console.error(`[Support] POST /threads/:id/messages error (id=${_shortId(req.params.id)}):`, err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /threads/:id — staff status/priority/assignee + resolve
// ──────────────────────────────────────────────────────────────────────────
router.patch('/threads/:id', async (req, res) => {
    try {
        if (!(await _hasAdminSupport(req))) {
            return res.status(403).json({ error: 'admin_support permission required' });
        }
        const thread = await supportStore.getThread(req.params.id);
        if (!thread) return res.status(404).json({ error: 'thread not found' });

        const patch = {};
        const { status, priority, assignee_user_id } = req.body || {};

        if (status) {
            const allowed = ['open', 'ai_responding', 'awaiting_user', 'awaiting_agent', 'resolved', 'closed'];
            if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
            patch.status = status;
            if (status === 'resolved') patch.resolved_at = new Date().toISOString();
        }
        if (priority) {
            const allowed = ['low', 'normal', 'high', 'urgent'];
            if (!allowed.includes(priority)) return res.status(400).json({ error: 'invalid priority' });
            patch.priority = priority;
        }
        if (assignee_user_id !== undefined) {
            patch.assignee_user_id = assignee_user_id || null;
        }

        const updated = await supportStore.updateThread(thread.id, patch);

        const userId = getUserId(req);
        // Audit each field that actually changed.
        if (patch.status && patch.status !== thread.status) {
            supportStore.recordThreadEvent({
                threadId: thread.id,
                actorUserId: userId,
                actorKind: 'staff',
                action: patch.status === 'resolved' ? 'resolved' : 'status_change',
                payload: { from: thread.status, to: patch.status },
            }).catch(() => {});
        }
        if (patch.priority && patch.priority !== thread.priority) {
            supportStore.recordThreadEvent({
                threadId: thread.id,
                actorUserId: userId,
                actorKind: 'staff',
                action: 'priority_change',
                payload: { from: thread.priority, to: patch.priority },
            }).catch(() => {});
        }
        if (patch.assignee_user_id !== undefined && patch.assignee_user_id !== thread.assignee_user_id) {
            supportStore.recordThreadEvent({
                threadId: thread.id,
                actorUserId: userId,
                actorKind: 'staff',
                action: 'assignee_change',
                payload: { from: thread.assignee_user_id || null, to: patch.assignee_user_id || null },
            }).catch(() => {});
        }

        // Resolution email
        if (patch.status === 'resolved' && thread.status !== 'resolved') {
            sendOrNotifyStaff(
                sendThreadResolvedEmail,
                {
                    to: thread.requester_email,
                    requesterName: thread.requester_name,
                    subject: thread.subject,
                    threadUrl: _buildThreadUrl(thread),
                },
                { kind: 'resolved', threadId: thread.id },
            );
            if (thread.requester_user_id) {
                notificationStore.createNotification({
                    userId: thread.requester_user_id,
                    taskId: thread.id,
                    category: 'info',
                    title: 'Your support request was resolved',
                    message: thread.subject,
                }).catch(() => {});
            }
        }

        _emit('thread_updated', { threadId: thread.id });
        res.json({ ok: true, thread: updated });
    } catch (err) {
        console.error(`[Support] PATCH /threads/:id error (id=${_shortId(req.params.id)}):`, err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /threads/:id/events — staff-only audit log for a thread
// ──────────────────────────────────────────────────────────────────────────
router.get('/threads/:id/events', async (req, res) => {
    try {
        if (!(await _hasAdminSupport(req))) {
            return res.status(403).json({ error: 'admin_support permission required' });
        }
        const events = await supportStore.listThreadEvents(req.params.id, { limit: 200 });
        res.json({ events });
    } catch (err) {
        console.error(`[Support] GET /threads/:id/events error (id=${_shortId(req.params.id)}):`, err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /threads/:id/stream — SSE
// Streams thread_updated / thread_created events for live inbox refresh.
// ──────────────────────────────────────────────────────────────────────────
router.get('/stream', async (req, res) => {
    let listener = null;
    let heartbeat = null;
    let markEnded = () => {};
    // Force-cleanup so a listener never outlives the underlying socket. Wrapped
    // in try/finally below; this closure is the single cleanup site.
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try { if (heartbeat) clearInterval(heartbeat); } catch {}
        try { if (listener) supportEvents.off('event', listener); } catch {}
        try { markEnded(); } catch {}
    };
    try {
        if (!(await _hasAdminSupport(req))) {
            return res.status(403).json({ error: 'admin_support permission required' });
        }
        const sse = setupSSE(res);
        markEnded = sse.markEnded;
        sse.sendEvent('ready', { at: Date.now() });

        listener = ({ event, data }) => {
            try { sse.sendEvent(event, { ...data, at: Date.now() }); }
            catch { cleanup(); }
        };
        supportEvents.on('event', listener);
        _logListenerPressure();

        // Heartbeat-driven liveness: 3 consecutive ping failures force-cleanup
        // the listener, even if `close` was never fired (half-closed sockets).
        let pingFailures = 0;
        heartbeat = setInterval(() => {
            if (res.writableEnded) return cleanup();
            try {
                res.write(': ping\n\n');
                pingFailures = 0;
            } catch {
                pingFailures += 1;
                if (pingFailures >= 3) cleanup();
            }
        }, 25000);

        req.on('close', cleanup);
        req.on('error', cleanup);
        res.on('error', cleanup);
    } catch (err) {
        cleanup();
        console.error('[Support] stream error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /config — staff: read AI agent + KB ids
// PUT /config — super-admin: update them
// ──────────────────────────────────────────────────────────────────────────
router.get('/config', async (req, res) => {
    try {
        if (!(await _hasAdminSupport(req))) {
            return res.status(403).json({ error: 'admin_support permission required' });
        }
        const agentId = await configStore.getConfig('support_ai_agent_id');
        const kbRaw = await configStore.getConfig('support_ai_kb_ids');
        let kbIds = [];
        if (kbRaw) {
            try { kbIds = Array.isArray(kbRaw) ? kbRaw : JSON.parse(kbRaw); } catch { kbIds = []; }
        }
        res.json({ agentId: agentId || null, kbIds });
    } catch (err) {
        console.error('[Support] GET /config error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.put('/config', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Super-admin required' });
        }
        const { agentId, kbIds } = req.body || {};
        if (agentId !== undefined) {
            await configStore.setConfig('support_ai_agent_id', agentId || '');
        }
        if (kbIds !== undefined) {
            if (!Array.isArray(kbIds)) return res.status(400).json({ error: 'kbIds must be an array' });
            await configStore.setConfig('support_ai_kb_ids', JSON.stringify(kbIds));
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[Support] PUT /config error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /agent  — fetch the Bee Flow Support singleton agent
// PUT /agent  — update the singleton (system prompt, model tier, KB ids,
//               starter prompts). Proxies to agentStore, bypassing the
//               owner_id check that PUT /agents/:id imposes for user-owned
//               agents (this agent has owner_id='system').
// POST /preview — non-streaming dry-run AI reply for the configuration UI.
//                 Calls chatWithAgent against the singleton without touching
//                 support_threads / support_messages / email.
// ──────────────────────────────────────────────────────────────────────────

const SUPPORT_AGENT_ID = 'system-bee-flow-support';

router.get('/agent', async (req, res) => {
    try {
        if (!(await _hasAdminSupport(req))) {
            return res.status(403).json({ error: 'admin_support permission required' });
        }
        const agentStore = require('../stores/agentStore');
        const agent = await agentStore.getAgent(SUPPORT_AGENT_ID);
        if (!agent) {
            return res.status(404).json({
                error: 'Support agent not seeded yet. Restart the server to seed it.',
            });
        }
        res.json({ agent });
    } catch (err) {
        console.error('[Support] GET /agent error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.put('/agent', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Super-admin required' });
        }
        const agentStore = require('../stores/agentStore');
        const existing = await agentStore.getAgent(SUPPORT_AGENT_ID);
        if (!existing) {
            return res.status(404).json({ error: 'Support agent not seeded yet.' });
        }

        const body = req.body || {};
        // Whitelisted fields — block anything that would let an admin
        // re-target the singleton at a different owner or org.
        const name = body.name ?? existing.name;
        const description = body.description ?? existing.description;
        const systemPrompt = body.systemPrompt ?? existing.system_prompt;
        const model = body.model ?? existing.model;
        const starterPrompts = Array.isArray(body.starterPrompts)
            ? body.starterPrompts
            : (() => {
                try { return JSON.parse(existing.starter_prompts || '[]'); } catch { return []; }
            })();

        // Merge config — preserve unknown keys so an upgrade that adds a new
        // sub-flag doesn't get silently wiped on save.
        const existingConfig = existing.config && typeof existing.config === 'object' ? existing.config : {};
        const inboundConfig = body.config && typeof body.config === 'object' ? body.config : {};
        const config = { ...existingConfig, ...inboundConfig };
        if (Array.isArray(body.knowledgeBaseIds)) {
            config.knowledge_base_ids = body.knowledgeBaseIds;
        }

        const ok = await agentStore.updateAgent(
            SUPPORT_AGENT_ID,
            name,
            description,
            systemPrompt,
            'system',                // ownerId — singleton is system-owned
            model,
            starterPrompts,
            existing.avatar || null, // avatar
            !!existing.threads_enabled,
            !!existing.copy_enabled,
            !!existing.workspace_enabled,
            config,
            !!existing.embed_enabled,
            null,                    // organizationId — singleton, no tenant
            [],                      // sharedGroups — never published
            null                     // categoryId
        );
        if (!ok) {
            return res.status(500).json({ error: 'Update failed (agent not owned by system?)' });
        }
        // Mirror knowledge_base_ids into the legacy configStore key so the
        // existing supportAiResponder fallback path keeps working without a
        // code change.
        if (Array.isArray(body.knowledgeBaseIds)) {
            try {
                await configStore.setConfig('support_ai_kb_ids', JSON.stringify(body.knowledgeBaseIds));
            } catch {}
        }
        const updated = await agentStore.getAgent(SUPPORT_AGENT_ID);
        res.json({ ok: true, agent: updated });
    } catch (err) {
        console.error('[Support] PUT /agent error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/preview', async (req, res) => {
    try {
        if (!(await _hasAdminSupport(req))) {
            return res.status(403).json({ error: 'admin_support permission required' });
        }
        const message = (req.body?.message || '').toString().trim();
        if (!message) return res.status(400).json({ error: 'message required' });
        if (message.length > 5000) return res.status(400).json({ error: 'message too long' });

        const { chatWithAgent } = require('../core/agentRuntime');
        const { quickKBSearch } = require('../core/agentRuntime/knowledgeSearch');
        const agentStore = require('../stores/agentStore');
        const agent = await agentStore.getAgent(SUPPORT_AGENT_ID);
        if (!agent) return res.status(404).json({ error: 'Support agent not seeded' });

        // Use the configured KB ids (same source the real responder reads).
        const kbIds = Array.isArray(agent?.config?.knowledge_base_ids)
            ? agent.config.knowledge_base_ids
            : [];

        // Synthetic preview user — never collides with a real session id.
        const previewUserId = `support-ai-preview:${getUserId(req) || 'anon'}`;

        let kbHits = [];
        try {
            kbHits = await quickKBSearch(previewUserId, kbIds, message, { topK: 4 });
        } catch (e) {
            console.warn('[Support] preview KB search failed:', e.message);
        }

        const kbContext = kbHits.length
            ? `\n\n[Reference material — only cite if directly relevant:]\n${kbHits.map((h, i) => `(${i + 1}) ${h.title}\n${h.content}`).join('\n\n')}`
            : '';
        const userMessage = `Preview mode — test customer message.\n\nSubject: (preview)\n\nCustomer: ${message}${kbContext}\n\nReply only to the customer's most recent message. If the knowledge base does not contain a confident answer or this requires account-specific actions, respond briefly and end your reply with [ESCALATE: <reason>].`;

        let result;
        try {
            result = await chatWithAgent(SUPPORT_AGENT_ID, previewUserId, userMessage, {});
        } catch (e) {
            console.error('[Support] preview chatWithAgent failed:', e.message);
            return res.status(500).json({ error: e.message });
        }

        const raw = (result && (result.content || result.response || result.message)) || '';
        const escMatch = raw.match(/\[ESCALATE(?::\s*([^\]]+))?\]/i);
        const escalated = !!escMatch || (kbHits.length === 0 && raw.trim().length < 60);
        const cleaned = raw.replace(/\[ESCALATE(?::\s*[^\]]+)?\]/i, '').trim();

        res.json({
            content: cleaned || '(empty reply)',
            model: (result && result.model) || null,
            modelTier: agent.model || null,
            citations: kbHits.map(h => ({ title: h.title, source_uri: h.source_uri, score: h.score })),
            escalated,
            escalateReason: escMatch?.[1]?.trim() || (escalated ? 'no_kb_grounding' : null),
        });
    } catch (err) {
        console.error('[Support] POST /preview error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Exported so server/index.js can trigger SLA checks.
module.exports = router;
module.exports.supportEvents = supportEvents;
module.exports.notifyStaff = notifyStaff;
