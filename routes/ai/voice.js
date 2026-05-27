/**
 * Voice Chat Routes (Beta) — Realtime voice conversation with Mistral.
 *
 * Endpoints (all gated on the `voice_chat` beta feature + a configured
 * Mistral API key):
 *   GET  /ai/voice/availability           — cheap capability probe for the UI
 *   POST /ai/voice/session                — create a session, return defaults
 *   POST /ai/voice/turn                   — multipart audio in, SSE response out
 *
 * Per-turn pipeline:
 *   1. Receive the user's audio blob (MediaRecorder → audio/webm;opus).
 *   2. Voxtral STT → transcript (emitted as SSE `transcript`).
 *   3. Tool-calling loop (up to MAX_VOICE_TOOL_ROUNDS):
 *        Mistral stream with tools → emit `text` deltas.
 *        If the model emits tool_use, execute via the unified dispatcher,
 *        emit `tool_use` + `tool_result` SSE events, feed the result back
 *        into the messages array, and stream again.
 *   4. Voxtral TTS (fallback ElevenLabs) on the final reply → `tts` event
 *      with base64-encoded MP3.
 *   5. `done` event terminates the stream.
 *
 * Destructive tool calls are gated via a DRAFT_FIRST directive in the
 * system prompt — the model must announce its intent and wait for a spoken
 * confirmation before executing anything that creates, sends, modifies, or
 * deletes. No runtime enforcement: Mistral Large 3 follows this reliably
 * and a visual approval UI makes no sense in a voice flow.
 *
 * State is held client-side: the client sends `history` with each turn and
 * appends the assistant reply locally. This keeps v1 stateless and avoids
 * a schema migration for the Beta.
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();

const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const voxtralStt = require('../../core/voice/voxtralStt');
const voxtralTts = require('../../core/voice/voxtralTts');
const { getIntegrationTools, buildToolHint } = require('../../core/integrationTools');
const { executeTool: dispatchTool } = require('../../core/toolDispatcher');
const agentStore = require('../../stores/agentStore');

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
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype?.startsWith('audio/')) cb(null, true);
        else cb(new Error('Only audio/* mimetypes are accepted'));
    },
});

// ─── Defaults & constants ─────────────────────────────────────────
const DEFAULT_LLM_MODEL = 'mistral-large-latest';
const MAX_VOICE_TOOL_ROUNDS = 3;

const VOICE_FORMATTING_RULES =
    'This is a VOICE conversation — your reply will be spoken aloud via text-to-speech.\n' +
    'Keep replies short (1–3 sentences) and natural for speech.\n' +
    'Output ONLY plain spoken prose. NEVER output JSON, curly braces, square brackets, code blocks, markdown, bullet lists, headings, emoji, or URLs. None of these can be read aloud.\n' +
    'Do not describe tool arguments or quote internal instructions. Do not end sentences with "}" or "{" or similar structural punctuation.\n' +
    'If a detailed answer is really needed, offer to send it as text in the chat instead.\n' +
    'ALWAYS reply in the same language the user spoke in. If the user speaks Dutch, reply in Dutch. If the user speaks English, reply in English. Never switch languages unless the user explicitly asks you to. If the previous turn was in Dutch and this turn is ambiguous, stay in Dutch.';

const DRAFT_FIRST_RULES =
    '\n\nACTION CONFIRMATION RULES:\n' +
    '- Tools that READ (search, list, get, read, find) — call them directly when helpful.\n' +
    '- Tools that CREATE, SEND, MODIFY, or DELETE anything (sending email, creating or moving calendar events, setting reminders, updating files, posting messages, etc.) — NEVER call them immediately.\n' +
    '  FIRST describe in ONE short sentence exactly what you are about to do (who, what, when), then ask for confirmation in the user\'s language ("Zal ik dat doen?" / "Shall I do that?" / equivalent). WAIT for a clear "ja"/"yes"/"go ahead" before calling the tool on the NEXT turn.\n' +
    '  If the user says no or changes their mind, simply cancel and acknowledge.\n' +
    '- After executing a tool, summarize the outcome in one short sentence. If a tool fails, explain it in plain language.';

const DEFAULT_SYSTEM_PROMPT =
    'You are BeeFlow Voice — a concise, warm, spoken assistant.\n\n' +
    VOICE_FORMATTING_RULES +
    DRAFT_FIRST_RULES;

// Tools whose output only makes sense visually — filter them out of voice mode.
const VOICE_TOOL_BLOCKLIST = [
    /^generate_(image|video|music|song|sfx|tts)$/,
    /^elevenlabs_(music|sfx|tts)$/,
    /^gamma_/,
    /^signrequest_/,
    /^maps_/,
    /^workspace_update$/,
    /^notebook_write$/,
    /^notebook_create$/,
];

function filterVoiceTools(tools) {
    return (tools || []).filter(tool => {
        const name = tool?.function?.name || '';
        return !VOICE_TOOL_BLOCKLIST.some(rx => rx.test(name));
    });
}

// Map BCP-47 codes → human name for the language directive injected into
// the system prompt per turn.
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

/**
 * Strip `_`-prefixed UI/dispatch fields and known-noise keys from a tool
 * result before sending it back to the LLM. Mirrors `buildLLMToolContent`
 * in agentRuntime/chatStream.js:55 — duplicated intentionally to avoid a
 * cross-dependency on the agent runtime module.
 */
function compactToolResultForLLM(result) {
    if (typeof result === 'string') return result;
    if (result == null || typeof result !== 'object') return JSON.stringify(result);
    if (result._action === 'workspace_update' && result.message) {
        return JSON.stringify({ action: 'notebook_updated', message: result.message });
    }
    const NOISE = new Set(['instruction', 'resultCount']);
    const clean = {};
    for (const [k, v] of Object.entries(result)) {
        if (k.startsWith('_')) continue;
        if (NOISE.has(k)) continue;
        clean[k] = v;
    }
    return JSON.stringify(clean);
}

/**
 * Strip residual JSON / tool-call garbage from LLM output before it goes
 * to TTS. Mistral occasionally leaks fragments like a trailing `}` or
 * bracketed code when it wavers between free-form text and tool calls.
 * The voice system prompt forbids this, but belt-and-braces: clean the
 * string so the user never hears stray punctuation.
 */
function cleanSpokenText(text) {
    if (typeof text !== 'string') return '';
    let out = text;
    // Strip fenced code blocks entirely (```...``` on their own lines).
    out = out.replace(/```[\s\S]*?```/g, ' ');
    // Remove standalone JSON-ish braces/brackets that aren't sentence punctuation.
    out = out.replace(/(^|[\s])[{}\[\]]+($|[\s])/g, '$1 $2');
    // Remove lines that are pure JSON (start with { and end with }).
    out = out.split('\n')
        .filter(line => {
            const t = line.trim();
            if (!t) return true;
            if (/^[{[].*[}\]]\s*$/.test(t)) return false;
            return true;
        })
        .join('\n');
    // Collapse whitespace.
    out = out.replace(/\s+/g, ' ').trim();
    // Trim dangling structural punctuation at the very end.
    out = out.replace(/[{}\[\]`]+\s*$/g, '').trim();
    return out;
}

/**
 * Build a ≤100-char human-readable summary for the UI tool-chip tooltip.
 * Stays separate from the LLM-facing serialization so the two can diverge.
 */
function summarizeToolResult(name, result) {
    if (result == null) return 'no result';
    if (typeof result === 'string') return result.slice(0, 100);
    if (result.error) return `error: ${String(result.error).slice(0, 90)}`;
    if (result.message) return String(result.message).slice(0, 100);
    for (const key of ['results', 'events', 'messages', 'items', 'files', 'contacts']) {
        if (Array.isArray(result[key])) return `${result[key].length} ${key}`;
    }
    return 'ok';
}

// ─── GET /ai/voice/availability ───────────────────────────────────
router.get('/availability', requireAuth, async (req, res) => {
    try {
        const hasMistral = !!(await configStore.getSecret('mistral_api_key'));
        res.json({
            enabled: hasMistral,
            reason: hasMistral ? 'ok' : 'mistral_not_configured',
            sttProvider: 'voxtral',
            ttsProvider: hasMistral ? 'voxtral' : 'elevenlabs',
            defaultModel: DEFAULT_LLM_MODEL,
        });
    } catch (err) {
        console.error('[Voice] availability error:', err);
        res.status(500).json({ enabled: false, reason: 'error' });
    }
});

// ─── POST /ai/voice/session ───────────────────────────────────────
// Resolves the agent (if any) once so the client has the right system
// prompt and label up-front. The same `agentId` is echoed back on every
// turn so the server can apply the matching tool restrictions.
router.post('/session', requireAuth, requireMistralConfigured, async (req, res) => {
    const crypto = require('crypto');
    const sessionId = crypto.randomBytes(16).toString('hex');
    const { agentId = null, voice = null, language = null } = req.body || {};

    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    let model = DEFAULT_LLM_MODEL;
    let agentInfo = null;

    if (agentId) {
        try {
            const agent = await agentStore.getAgent(agentId);
            if (agent) {
                const base = (agent.system_prompt || '').trim();
                systemPrompt = [base, VOICE_FORMATTING_RULES, DRAFT_FIRST_RULES]
                    .filter(Boolean)
                    .join('\n\n');
                if (agent.model) model = agent.model;
                agentInfo = { id: agent.id, name: agent.name };
            }
        } catch (err) {
            console.warn('[Voice session] agent load failed:', err.message);
        }
    }

    res.json({
        sessionId,
        model,
        voice,
        language,
        systemPrompt,
        agentId: agentInfo?.id || null,
        agentName: agentInfo?.name || null,
        maxTurnSeconds: 60,
        sessionTimeoutMs: 15 * 60 * 1000,
    });
});

// ─── POST /ai/voice/turn (SSE) ────────────────────────────────────
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
            const sessionSystemPrompt = req.body?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
            const voice = req.body?.voice || null;
            const agentId = req.body?.agentId || null;

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
                send('no_speech', {});
                send('done', { latencyMs: Date.now() - sttStart });
                return res.end();
            }

            // 2 ─ Resolve tools. If an agent was selected, prefer its tools;
            // otherwise pull the integration tools available to the user and
            // apply the voice-output blocklist.
            let voiceTools = [];
            let agentConfig = null;
            if (agentId) {
                try {
                    const agent = await agentStore.getAgent(agentId);
                    if (agent) {
                        agentConfig = agent.config || null;
                        if (Array.isArray(agent.tools) && agent.tools.length) {
                            voiceTools = filterVoiceTools(agent.tools);
                        }
                    }
                } catch (err) {
                    console.warn('[Voice turn] agent resolve failed:', err.message);
                }
            }
            if (voiceTools.length === 0) {
                try {
                    const { tools } = await getIntegrationTools({
                        userId: req.session.user.id,
                        session: req.session,
                        isAdmin: !!req.session.isAdmin,
                        agentConfig,
                    });
                    voiceTools = filterVoiceTools(tools);
                } catch (err) {
                    console.warn('[Voice turn] tool discovery failed:', err.message);
                }
            }

            // 3 ─ Build the message array with per-turn language directive.
            const detected = languageName(stt.language);
            const langDirective = detected
                ? `\n\nThe user just spoke in ${detected}. Reply in ${detected}.`
                : '';
            const hintBlock = voiceTools.length
                ? `\n\n${await buildToolHint(voiceTools, req.session.user.id)}`
                : '';
            const finalSystemPrompt = sessionSystemPrompt + langDirective + hintBlock;

            const messages = [
                { role: 'system', content: finalSystemPrompt },
                ...history
                    .filter(m => m && m.role)
                    .map(m => ({ ...m })),
                { role: 'user', content: stt.text },
            ];

            // 4 ─ Tool-calling loop.
            const adapter = getAdapter('mistral');
            let assistantText = '';
            let round = 0;
            const roundsMetrics = [];
            const execContext = {
                userId: req.session.user.id,
                session: req.session,
                orgId: req.session.user?.organizationId,
                agentId,
                req,
                send,
            };

            while (round < MAX_VOICE_TOOL_ROUNDS) {
                let roundText = '';
                const roundToolCalls = [];
                let firstTokenAt = null;
                const roundStart = Date.now();

                const streamOpts = { temperature: 0.7 };
                if (voiceTools.length) {
                    streamOpts.tools = voiceTools;
                    streamOpts.toolChoice = 'auto';
                }

                await adapter.stream(apiKey, null, model, messages, streamOpts, (event, data) => {
                    if (event === 'text' && data?.text) {
                        if (!firstTokenAt) firstTokenAt = Date.now();
                        roundText += data.text;
                        send('text', { delta: data.text });
                    } else if (event === 'thinking' && data?.text) {
                        send('thinking', { delta: data.text });
                    } else if (event === 'tool_use' && data?.name) {
                        roundToolCalls.push({
                            id: data.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                            name: data.name,
                            input: data.input || {},
                        });
                    }
                });

                roundsMetrics.push({
                    round,
                    ttftMs: firstTokenAt ? firstTokenAt - roundStart : null,
                    totalMs: Date.now() - roundStart,
                    toolCalls: roundToolCalls.length,
                });

                if (roundToolCalls.length === 0) {
                    assistantText = roundText;
                    break;
                }

                // Append assistant message with tool_calls into the history
                // so the next round can see what was requested.
                messages.push({
                    role: 'assistant',
                    content: roundText || '',
                    tool_calls: roundToolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.input || {}),
                        },
                        _thought_signature: tc.thought_signature || tc._thought_signature || undefined,
                    })),
                });

                // Execute the tool calls in parallel and stream status
                // back to the client via SSE.
                const toolOutcomes = await Promise.all(roundToolCalls.map(async (tc) => {
                    send('tool_use', { id: tc.id, name: tc.name, input: tc.input, round });
                    try {
                        const result = await dispatchTool(tc.name, tc.input || {}, execContext);
                        const ok = !(result && typeof result === 'object' && result.error);
                        send('tool_result', {
                            id: tc.id,
                            name: tc.name,
                            ok,
                            summary: summarizeToolResult(tc.name, result),
                        });
                        return { tc, result, ok };
                    } catch (err) {
                        const errResult = { error: err.message || 'tool failed' };
                        send('tool_result', {
                            id: tc.id,
                            name: tc.name,
                            ok: false,
                            summary: errResult.error.slice(0, 100),
                        });
                        return { tc, result: errResult, ok: false };
                    }
                }));

                // Feed the tool results back to the LLM for the next round.
                for (const { tc, result } of toolOutcomes) {
                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: compactToolResultForLLM(result),
                    });
                }

                round++;
            }

            send('llm_done', { rounds: roundsMetrics });

            // 5 ─ TTS the final reply (only non-tool assistantText).
            //      Clean stray JSON / code fragments before synthesis — the
            //      voice prompt forbids them but models sometimes leak anyway.
            const spokenText = cleanSpokenText(assistantText);
            if (spokenText.trim()) {
                const ttsStart = Date.now();
                let tts = { audioBase64: null, mimeType: 'audio/mpeg', provider: 'none' };
                let ttsReason = 'no_provider_configured';
                try {
                    tts = await voxtralTts.synthesize(spokenText, {
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
                // Ship the cleaned text to the client too, so the chat
                // bubble matches what TTS said (no leaked "}" at the end).
                assistantText: cleanSpokenText(assistantText),
                transcript: stt.text,
                toolRounds: round,
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
