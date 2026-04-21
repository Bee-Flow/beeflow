/**
 * Voice Chat Routes (Beta) — Realtime voice conversation with Mistral.
 *
 * Endpoints (all gated on the `voice_chat` beta feature + a configured
 * Mistral API key):
 *   GET  /ai/voice/availability           — cheap capability probe for the UI
 *   POST /ai/voice/session                — create a session, return defaults
 *   POST /ai/voice/turn                   — multipart audio in, SSE response out
 *
 * Per-turn pipeline (v1 Beta, turn-based streaming):
 *   1. Receive the user's audio blob (MediaRecorder → audio/webm;opus).
 *   2. Voxtral STT → transcript (emitted as SSE `transcript`).
 *   3. Mistral chat streaming → `text` deltas (LLM reply).
 *   4. Voxtral TTS (fallback ElevenLabs) on the final reply → `tts` event
 *      with base64-encoded MP3.
 *   5. `done` event terminates the stream.
 *
 * State is held client-side: the client sends `history` with each turn and
 * appends the assistant reply locally. This keeps v1 stateless and avoids
 * a schema migration for the Beta. Persistence can be layered in v2 by
 * attaching a turn to an existing `direct_conversations` row.
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();

const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const voxtralStt = require('../../core/voice/voxtralStt');
const voxtralTts = require('../../core/voice/voxtralTts');

// ─── Auth & gating ───────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

async function requireMistralConfigured(req, res, next) {
    const key = await configStore.getSecret('mistral_api_key');
    if (!key) {
        return res.status(409).json({
            error: 'mistral_not_configured',
            message: 'Voice chat requires a configured Mistral API key. Please add one in Admin → AI Config.',
        });
    }
    req._mistralKey = key;
    next();
}

// Memory-based multer — audio turns are small (~MBs) and we immediately
// hand the buffer to Voxtral; no need to touch disk.
const uploadTurn = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per turn (≥ 2 minutes of opus)
    fileFilter: (req, file, cb) => {
        if (file.mimetype?.startsWith('audio/')) cb(null, true);
        else cb(new Error('Only audio/* mimetypes are accepted'));
    },
});

// ─── Defaults ─────────────────────────────────────────────────────
const DEFAULT_LLM_MODEL = 'mistral-large-latest';
const DEFAULT_SYSTEM_PROMPT =
    'You are BeeFlow Voice — a concise, warm, spoken assistant. ' +
    'Keep replies short (2–3 sentences) and natural for speech. ' +
    'Avoid markdown, code blocks, bullet lists, or long URLs — they do not sound good when read aloud. ' +
    'If a detailed answer is needed, offer to send it as text in the chat instead. ' +
    'ALWAYS reply in the same language the user spoke in. ' +
    'If the user speaks Dutch, reply in Dutch. If the user speaks French, reply in French. ' +
    'Never switch languages unless the user explicitly asks you to.';

// Map BCP-47 codes returned by Voxtral STT to a human-readable prompt hint
// so the LLM reliably matches the spoken language. Voxtral supports 13
// languages for STT; the subset below covers the ones Voxtral TTS also
// speaks (9 languages), plus common fallbacks.
const LANG_NAMES = {
    en: 'English', nl: 'Dutch', fr: 'French', de: 'German', es: 'Spanish',
    it: 'Italian', pt: 'Portuguese', hi: 'Hindi', ar: 'Arabic',
    pl: 'Polish', ru: 'Russian', tr: 'Turkish', zh: 'Chinese', ja: 'Japanese',
};
function languageName(code) {
    if (!code) return null;
    const short = String(code).toLowerCase().slice(0, 2);
    return LANG_NAMES[short] || null;
}

// ─── GET /ai/voice/availability ───────────────────────────────────
// Called by the UI on mount to decide whether to show the voice button.
// Returns { enabled, reason } without leaking secrets.
router.get('/availability', requireAuth, async (req, res) => {
    try {
        const hasMistral = !!(await configStore.getSecret('mistral_api_key'));
        // Beta-feature gating happens at the router mount level (see ai.js).
        // If the user reached this handler at all, they have the beta flag.
        res.json({
            enabled: hasMistral,
            reason: hasMistral ? 'ok' : 'mistral_not_configured',
            sttProvider: 'voxtral',
            ttsProvider: (await configStore.getSecret('mistral_api_key')) ? 'voxtral' : 'elevenlabs',
            defaultModel: DEFAULT_LLM_MODEL,
        });
    } catch (err) {
        console.error('[Voice] availability error:', err);
        res.status(500).json({ enabled: false, reason: 'error' });
    }
});

// ─── POST /ai/voice/session ───────────────────────────────────────
// Issues a lightweight session id + the turn defaults. Purely a
// client-side bookkeeping hook for now — no server-side state is stored.
router.post('/session', requireAuth, requireMistralConfigured, async (req, res) => {
    const crypto = require('crypto');
    const sessionId = crypto.randomBytes(16).toString('hex');
    res.json({
        sessionId,
        model: DEFAULT_LLM_MODEL,
        // Leave voice unset so the Voxtral endpoint picks its default.
        // Clients can override via the session-create body for voice cloning.
        voice: req.body?.voice || null,
        language: req.body?.language || null, // null = auto-detect from audio
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        maxTurnSeconds: 60,
        sessionTimeoutMs: 15 * 60 * 1000,
    });
});

// ─── POST /ai/voice/turn (SSE) ────────────────────────────────────
// Body (multipart/form-data):
//   audio:    <Blob>               — user's speech (audio/webm;codecs=opus preferred)
//   history:  <JSON string>        — [{role, content}, …] prior messages
//   model:    <string>             — override LLM model (optional)
//   language: <string>             — BCP-47 language hint (optional)
//   systemPrompt: <string>         — override system prompt (optional)
router.post(
    '/turn',
    requireAuth,
    requireMistralConfigured,
    uploadTurn.single('audio'),
    async (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        const send = (event, data) => {
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            } catch (_) { /* socket closed */ }
        };

        try {
            if (!req.file) {
                send('error', { message: 'Missing audio blob' });
                return res.end();
            }

            const apiKey = req._mistralKey;
            const language = req.body?.language || null;
            const model = req.body?.model || DEFAULT_LLM_MODEL;
            const systemPrompt = req.body?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
            const voice = req.body?.voice || 'amber';

            let history = [];
            if (req.body?.history) {
                try { history = JSON.parse(req.body.history); } catch (_) { history = []; }
            }
            if (!Array.isArray(history)) history = [];

            // 1 ─ Transcribe
            const sttStart = Date.now();
            const stt = await voxtralStt.transcribe(apiKey, req.file.buffer, {
                mime: req.file.mimetype,
                filename: req.file.originalname,
                language,
            });
            send('transcript', {
                text: stt.text,
                language: stt.language,
                duration: stt.duration,
                latencyMs: Date.now() - sttStart,
            });

            if (!stt.text) {
                // Silence / unintelligible — give the UI a chance to recover
                send('no_speech', {});
                send('done', { latencyMs: Date.now() - sttStart });
                return res.end();
            }

            // 2 ─ LLM stream (Mistral SDK, existing provider abstraction)
            // Append a detected-language directive to the system prompt so the
            // model reliably matches the user's spoken language.
            const detected = languageName(stt.language);
            const langDirective = detected
                ? `\n\nThe user just spoke in ${detected}. Reply in ${detected}.`
                : '';
            const messages = [
                { role: 'system', content: systemPrompt + langDirective },
                ...history
                    .filter(m => m && m.role && typeof m.content === 'string')
                    .map(m => ({ role: m.role, content: m.content })),
                { role: 'user', content: stt.text },
            ];

            const adapter = getAdapter('mistral');
            let assistantText = '';
            const llmStart = Date.now();
            let firstTokenAt = null;

            await adapter.stream(apiKey, null, model, messages, { temperature: 0.7 }, (event, data) => {
                if (event === 'text' && data?.text) {
                    if (!firstTokenAt) firstTokenAt = Date.now();
                    assistantText += data.text;
                    send('text', { delta: data.text });
                } else if (event === 'done') {
                    send('llm_done', {
                        ttftMs: firstTokenAt ? firstTokenAt - llmStart : null,
                        totalMs: Date.now() - llmStart,
                        usage: data || null,
                    });
                }
            });

            // 3 ─ TTS the full reply (v1: one-shot; v2 can sentence-stream)
            // Prefer the language Voxtral detected over any client hint so
            // TTS picks the right voice model for Dutch/French/etc. replies.
            if (assistantText.trim()) {
                const ttsStart = Date.now();
                let tts = { audioBase64: null, mimeType: 'audio/mpeg', provider: 'none' };
                let ttsReason = 'no_provider_configured';
                try {
                    tts = await voxtralTts.synthesize(assistantText, {
                        voice,
                        language: stt.language || language,
                    });
                } catch (err) {
                    const msg = String(err?.message || err);
                    if (msg.includes('no_voice_configured')) ttsReason = 'no_voice_configured';
                    else ttsReason = 'tts_failed';
                    console.warn('[Voice turn] TTS pipeline error:', msg);
                }
                if (tts.audioBase64) {
                    send('tts', {
                        audioBase64: tts.audioBase64,
                        mimeType: tts.mimeType,
                        provider: tts.provider,
                        latencyMs: Date.now() - ttsStart,
                    });
                } else {
                    send('tts_unavailable', { reason: ttsReason });
                }
            }

            send('done', {
                assistantText,
                transcript: stt.text,
            });
            res.end();
        } catch (err) {
            console.error('[Voice turn] error:', err);
            send('error', { message: err.message || 'Voice turn failed' });
            try { res.end(); } catch (_) { /* noop */ }
        }
    }
);

module.exports = router;
