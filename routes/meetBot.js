/**
 * Meet Bot API — REST endpoints for the meeting recording bot.
 *
 * Supports Google Meet, Microsoft Teams, and Zoom. The platform is
 * auto-detected from the meeting URL.
 *
 * GET    /api/meet-bot/platforms      — List supported meeting platforms
 * POST   /api/meet-bot/join           — Send bot to a meeting (any platform)
 * GET    /api/meet-bot/sessions       — List bot sessions for current user
 * GET    /api/meet-bot/sessions/:id   — Get a specific bot session
 * POST   /api/meet-bot/sessions/:id/stop — Stop an active bot session
 * DELETE /api/meet-bot/sessions/:id   — Delete a session record
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const meetBotStore = require('../stores/meetBotStore');
const meetBot = require('../core/meetBot');
const transcriptionStore = require('../stores/transcriptionStore');
const configStore = require('../stores/configStore');
const storageStore = require('../stores/storageStore');

const AUDIO_MIME_BY_EXT = {
    '.webm': 'audio/webm',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
};

function decodeStorageKeyFromProxyPath(proxyPath) {
    if (typeof proxyPath !== 'string') return null;
    const prefix = '/api/storage/file/';
    if (!proxyPath.startsWith(prefix)) return null;
    const encoded = proxyPath.slice(prefix.length);
    if (!encoded) return null;
    return encoded.split('/').map(part => decodeURIComponent(part)).join('/');
}

async function uploadBotRecordingToRustFS(localAudioPath, userId, sessionId) {
    if (!storageStore.isAvailable()) return null;
    if (!localAudioPath || !fs.existsSync(localAudioPath)) return null;

    const fileBuffer = fs.readFileSync(localAudioPath);
    const ext = path.extname(localAudioPath).toLowerCase();
    const contentType = AUDIO_MIME_BY_EXT[ext] || 'application/octet-stream';
    const safeName = path.basename(localAudioPath).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = storageStore.buildKey(userId, 'audio', `meet-bot-${sessionId}-${safeName}`);

    await storageStore.uploadFile(key, fileBuffer, contentType);
    return {
        key,
        proxyUrl: storageStore.buildProxyUrl(key),
    };
}

/**
 * Transcribe a bot recording using the existing Voxtral pipeline.
 * This reuses the same logic as the manual transcription upload route.
 */
async function transcribeBotRecording(audioPath, userId, title, language = 'nl') {
    const apiKey = await configStore.getSecret('mistral_api_key');
    if (!apiKey) throw new Error('Mistral API key not configured');

    const { Mistral } = require('@mistralai/mistralai');
    const client = new Mistral({ apiKey });

    const fileContent = fs.readFileSync(audioPath);
    const fileName = path.basename(audioPath);

    console.log(`[MeetBot] Transcribing ${fileName} (${(fileContent.length / (1024 * 1024)).toFixed(1)} MB)`);

    // Voxtral transcription with diarization
    const response = await client.audio.transcriptions.complete({
        model: 'voxtral-mini-2602',
        file: { fileName, content: fileContent },
        diarize: true,
        language,
        timestampGranularities: ['segment'],
    });

    // Merge consecutive segments from same speaker
    const segments = response.segments || [];
    const merged = [];
    for (const seg of segments) {
        const last = merged[merged.length - 1];
        if (last && seg.speakerId === last.speakerId) {
            last.end = seg.end;
            last.text += ' ' + (seg.text || '').trim();
        } else {
            merged.push({
                speaker: seg.speakerId || 'Unknown',
                start: seg.start,
                end: seg.end,
                text: (seg.text || '').trim(),
            });
        }
    }

    // Speaker stats
    const speakerMap = {};
    for (const seg of merged) {
        if (!speakerMap[seg.speaker]) speakerMap[seg.speaker] = { duration: 0, segments: 0 };
        speakerMap[seg.speaker].duration += (seg.end || 0) - (seg.start || 0);
        speakerMap[seg.speaker].segments += 1;
    }

    const totalDuration = segments.length > 0 ? Math.max(...segments.map(s => s.end || 0)) : 0;

    const formatTime = (secs) => {
        if (secs == null) return '00:00';
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = Math.floor(secs % 60);
        if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    let transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');
    let speakers = Object.entries(speakerMap).map(([id, data]) => ({
        id,
        speakingTime: formatTime(data.duration),
        speakingSeconds: Math.round(data.duration),
        segments: data.segments,
    }));

    // Identify speaker names using Claude
    const speakerIds = Object.keys(speakerMap);
    let nameMapping = null;
    try {
        const { getProviderForModel } = require('../core/aiAgent');
        const claudeConfig = await getProviderForModel('claude-sonnet-4-6');
        const Anthropic = require('@anthropic-ai/sdk');
        const claude = new Anthropic({ apiKey: claudeConfig.apiKey });

        const nameResp = await claude.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            temperature: 0,
            system: `You are a transcript analyzer. Identify real names of speakers from the conversation.

IMPORTANT: Speech diarization often splits one person into multiple speaker IDs. A conversation with 3 real people may show 15+ speaker_IDs. You MUST group them.

Instructions:
1. Map EVERY speaker_ID to a real name. Multiple IDs will map to the SAME person.
2. If a speaker_ID has very few segments, assign them to the most likely existing speaker.
3. NEVER return null. Every speaker_ID must get a name string.

Return ONLY a JSON object. Example: {"speaker_1": "Tom", "speaker_2": "Gerard", "speaker_3": "Tom"}
Return ONLY valid JSON, no other text.`,
            messages: [
                { role: 'user', content: `Speakers: ${speakerIds.join(', ')}\nLanguage: ${language}\n\n${transcript.substring(0, 15000)}` }
            ],
        });
        const chatContent = (nameResp.content?.[0]?.text || '').trim();
        const jsonMatch = chatContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            nameMapping = JSON.parse(jsonMatch[0]);
            // Filter nulls
            for (const [key, value] of Object.entries(nameMapping)) {
                if (!value || value === 'null') delete nameMapping[key];
            }
            console.log('[MeetBot] Speaker names:', nameMapping);
        }
    } catch (e) {
        console.warn('[MeetBot] Speaker name identification failed:', e.message);
    }

    if (nameMapping) {
        for (const seg of merged) {
            if (nameMapping[seg.speaker]) seg.speaker = nameMapping[seg.speaker];
        }
        transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');
        speakers = speakers.map(s => ({ ...s, id: nameMapping[s.id] || s.id }));
    }

    // Generate summary using Claude
    let summary = '';
    try {
        const { getProviderForModel } = require('../core/aiAgent');
        const claudeConfig = await getProviderForModel('claude-sonnet-4-6');
        const Anthropic = require('@anthropic-ai/sdk');
        const claude = new Anthropic({ apiKey: claudeConfig.apiKey });

        const summaryResp = await claude.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 4096,
            temperature: 0.3,
            system: `You are a meeting analyst. Summarize the meeting transcript below. Write your summary directly using markdown formatting (headings, bullet points, bold). Do NOT wrap your response in a code block or code fence. Do NOT include any introductory sentence — start directly with the first heading.

Structure:
## Key Topics Discussed
## Decisions
## Action Items
## Key Takeaways

Write in the same language as the transcript (${language}). Be concise and focused on substance.`,
            messages: [
                { role: 'user', content: transcript }
            ],
        });
        summary = (summaryResp.content?.[0]?.text || '').trim();
    } catch (e) {
        console.warn('[MeetBot] Summary generation failed:', e.message);
    }

    // Generate AI title from summary using Claude
    let finalTitle = title || 'Bot Meeting Recording';
    if (summary) {
        try {
            const { getProviderForModel } = require('../core/aiAgent');
            const claudeConfig = await getProviderForModel('claude-sonnet-4-6');
            const Anthropic = require('@anthropic-ai/sdk');
            const claude = new Anthropic({ apiKey: claudeConfig.apiKey });

            const titleResp = await claude.messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 50,
                temperature: 0,
                system: `Generate a short, descriptive title (max 8 words) for this meeting. Write in the same language as the content. Return ONLY the title, nothing else. No quotes.`,
                messages: [
                    { role: 'user', content: summary.substring(0, 1000) }
                ],
            });
            const aiTitle = (titleResp.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '');
            if (aiTitle && aiTitle.length > 2 && aiTitle.length < 100) {
                finalTitle = aiTitle;
                console.log(`[MeetBot] AI title: "${aiTitle}"`);
            }
        } catch (e) { console.warn('[MeetBot] Title generation failed:', e.message); }
    }

    // Save transcription to DB
    const saved = await transcriptionStore.createTranscription({
        userId,
        title: finalTitle,
        fileName,
        language,
        durationSeconds: Math.round(totalDuration),
        speakerCount: Object.keys(speakerMap).length,
        segmentCount: merged.length,
        fullText: response.text || '',
        transcript,
        segments: merged,
        speakers,
        summary,
        audioPath,
    });

    return saved;
}


// ─── Routes ────────────────────────────────────────────────

/**
 * GET /credentials — Check if bot credentials are configured
 */
router.get('/credentials', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const email = await configStore.getSecret('meet_bot_email');
        res.json({ configured: !!email, email: email || null });
    } catch (err) {
        console.error('[MeetBot] /credentials GET error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /credentials — Save bot Google account credentials (encrypted)
 */
router.post('/credentials', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

        await configStore.setSecret('meet_bot_email', email);
        await configStore.setSecret('meet_bot_password', password);

        console.log(`[MeetBot] Credentials saved for bot account: ${email}`);
        res.json({ success: true, email });
    } catch (err) {
        console.error('[MeetBot] /credentials POST error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Teams SDK (ACS Call Automation) configuration ────────

function requireAdmin(req, res, next) {
    const role = req.session?.user?.role;
    if (role !== 'admin' && role !== 'owner') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

/**
 * GET /sdk-config — Read SDK provider config status (Teams ACS + Google
 * Meet Media API). Secrets are never returned in full; only booleans and
 * the non-secret callback base URL and impersonation user email.
 */
router.get('/sdk-config', requireAdmin, async (_req, res) => {
    try {
        const acsConnStr = await configStore.getSecret('acs_connection_string');
        const acsCallbackSecret = await configStore.getSecret('teams_bot_callback_secret');
        const acsCallbackBaseUrl = await configStore.getConfig('teams_bot_callback_base_url');

        const gmKeyRaw = await configStore.getSecret('google_meet_service_account_key');
        const gmImpersonationUser = await configStore.getConfig('google_meet_impersonation_user');
        let gmServiceAccountEmail = null;
        try {
            const parsed = gmKeyRaw ? JSON.parse(gmKeyRaw) : null;
            gmServiceAccountEmail = parsed?.client_email || null;
        } catch (_) {}

        res.json({
            teams: {
                acsConfigured: !!acsConnStr,
                callbackSecretConfigured: !!acsCallbackSecret,
                callbackBaseUrl: acsCallbackBaseUrl || null,
                callbackBaseUrlFromEnv: process.env.SERVER_BASE_URL || null,
            },
            googleMeet: {
                serviceAccountConfigured: !!gmKeyRaw,
                serviceAccountEmail: gmServiceAccountEmail,
                impersonationUser: gmImpersonationUser || null,
            },
        });
    } catch (err) {
        console.error('[MeetBot] /sdk-config GET error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /sdk-config — Save SDK provider config. Fields are optional; only
 * provided fields are updated.
 * Body may contain any of:
 *   - acsConnectionString, callbackBaseUrl, callbackSecret, clearAcsConnectionString  (Teams SDK)
 *   - googleMeetServiceAccountKey (JSON string), googleMeetImpersonationUser,
 *     clearGoogleMeetServiceAccountKey  (Google Meet SDK)
 */
router.post('/sdk-config', requireAdmin, async (req, res) => {
    try {
        const {
            acsConnectionString, callbackBaseUrl, callbackSecret, clearAcsConnectionString,
            googleMeetServiceAccountKey, googleMeetImpersonationUser, clearGoogleMeetServiceAccountKey,
        } = req.body || {};

        // ── Teams / ACS ─────────────────────────────────────
        if (clearAcsConnectionString) {
            await configStore.setSecret('acs_connection_string', '');
        } else if (typeof acsConnectionString === 'string' && acsConnectionString.trim()) {
            if (!/^endpoint=https:\/\//i.test(acsConnectionString.trim())) {
                return res.status(400).json({ error: 'ACS connection string should start with "endpoint=https://"' });
            }
            await configStore.setSecret('acs_connection_string', acsConnectionString.trim());
        }

        if (typeof callbackBaseUrl === 'string') {
            const trimmed = callbackBaseUrl.trim().replace(/\/+$/, '');
            if (trimmed && !/^https:\/\//i.test(trimmed)) {
                return res.status(400).json({ error: 'Callback base URL must start with https://' });
            }
            await configStore.setConfig('teams_bot_callback_base_url', trimmed);
        }

        if (typeof callbackSecret === 'string') {
            await configStore.setSecret('teams_bot_callback_secret', callbackSecret.trim());
        }

        // ── Google Meet SDK ─────────────────────────────────
        if (clearGoogleMeetServiceAccountKey) {
            await configStore.setSecret('google_meet_service_account_key', '');
        } else if (typeof googleMeetServiceAccountKey === 'string' && googleMeetServiceAccountKey.trim()) {
            let parsed;
            try { parsed = JSON.parse(googleMeetServiceAccountKey); }
            catch { return res.status(400).json({ error: 'Service account key must be valid JSON' }); }
            if (!parsed.client_email || !parsed.private_key) {
                return res.status(400).json({ error: 'Service account JSON missing client_email or private_key' });
            }
            if (parsed.type !== 'service_account') {
                return res.status(400).json({ error: 'Expected a Google service-account key (type=service_account)' });
            }
            await configStore.setSecret('google_meet_service_account_key', googleMeetServiceAccountKey.trim());
        }

        if (typeof googleMeetImpersonationUser === 'string') {
            const trimmed = googleMeetImpersonationUser.trim();
            if (trimmed && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
                return res.status(400).json({ error: 'Impersonation user must be a valid email address' });
            }
            await configStore.setConfig('google_meet_impersonation_user', trimmed);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[MeetBot] /sdk-config POST error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /platforms — List supported meeting platforms
 */
router.get('/platforms', async (_req, res) => {
    try {
        const platforms = await meetBot.listPlatforms();
        res.json({ platforms });
    } catch (err) {
        console.error('[MeetBot] /platforms error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /join — Send bot to a meeting (Google Meet, Teams, or Zoom).
 * The platform is auto-detected from the meeting URL.
 */
router.post('/join', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const { meetLink, title, language } = req.body;
        if (!meetLink) return res.status(400).json({ error: 'meetLink is required' });

        // Validate URL and determine platform
        const validation = await meetBot.validateMeetingUrl(meetLink);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }
        const platform = validation.platform;
        const platformLabel = validation.label;

        // Google Meet requires a signed-in bot account; Teams/Zoom join as guests.
        const provider = await meetBot.detectProvider(meetLink);
        let credentials = null;
        if (provider.requiresCredentials) {
            const botEmail = await configStore.getSecret('meet_bot_email');
            const botPassword = await configStore.getSecret('meet_bot_password');
            if (!botEmail || !botPassword) {
                return res.status(400).json({
                    error: `${platformLabel} requires a bot Google account. Configure credentials first.`,
                });
            }
            credentials = { email: botEmail, password: botPassword };
        }

        // Create session record
        const defaultTitle = `${platformLabel} Recording`;
        const session = await meetBotStore.createSession(userId, meetLink, title || defaultTitle, platform);
        console.log(`[MeetBot] Session ${session.id} (${platformLabel}) created for user ${userId}`);

        // Start the bot in the background (don't await)
        (async () => {
            try {
                await meetBotStore.updateSession(session.id, { status: 'joining' });

                const result = await meetBot.joinAndRecord(session.id, meetLink, {
                    botName: 'Bee Flow - Meeting Assistant',
                    credentials,
                    onStatusChange: async (status) => {
                        console.log(`[MeetBot] Session ${session.id} status: ${status}`);
                        await meetBotStore.updateSession(session.id, { status });
                    },
                });

                if (result.audioPath && fs.existsSync(result.audioPath)) {
                    let audioPathForSession = result.audioPath;
                    try {
                        const uploaded = await uploadBotRecordingToRustFS(result.audioPath, userId, session.id);
                        if (uploaded?.proxyUrl) {
                            audioPathForSession = uploaded.proxyUrl;
                            console.log(`[MeetBot] Recording uploaded to RustFS: ${uploaded.key}`);
                        }
                    } catch (uploadErr) {
                        console.warn(`[MeetBot] RustFS upload failed, continuing with local file: ${uploadErr.message}`);
                    }

                    await meetBotStore.updateSession(session.id, {
                        status: 'processing',
                        audioPath: audioPathForSession,
                    });

                    const stats = fs.statSync(result.audioPath);
                    if (stats.size < 5000) {
                        console.warn(`[MeetBot] Recording too small (${stats.size} bytes), may be empty`);
                        await meetBotStore.updateSession(session.id, {
                            status: 'failed',
                            error: 'Recording was too short or empty',
                            endedAt: new Date().toISOString(),
                        });
                        return;
                    }

                    console.log(`[MeetBot] Transcribing recording (${(stats.size / (1024 * 1024)).toFixed(1)} MB)...`);

                    const transcription = await transcribeBotRecording(
                        result.audioPath,
                        userId,
                        title || defaultTitle,
                        language || 'nl'
                    );

                    await meetBotStore.updateSession(session.id, {
                        status: 'completed',
                        transcriptionId: transcription.id,
                        endedAt: new Date().toISOString(),
                    });

                    console.log(`[MeetBot] Session ${session.id} completed. Transcription: ${transcription.id}`);
                } else {
                    await meetBotStore.updateSession(session.id, {
                        status: 'failed',
                        error: 'No recording produced',
                        endedAt: new Date().toISOString(),
                    });
                }

            } catch (err) {
                console.error(`[MeetBot] Session ${session.id} failed:`, err.message);
                await meetBotStore.updateSession(session.id, {
                    status: 'failed',
                    error: err.message,
                    endedAt: new Date().toISOString(),
                });
            }
        })();

        // Return immediately with session info
        res.json({
            message: `Bot is joining the ${platformLabel} meeting`,
            session: {
                id: session.id,
                meetLink,
                platform,
                platformLabel,
                title: title || defaultTitle,
                status: 'joining',
            },
        });

    } catch (err) {
        console.error('[MeetBot] /join error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /sessions — List bot sessions for current user
 */
router.get('/sessions', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const sessions = await meetBotStore.getUserSessions(userId);

        // Enrich with live status for active sessions
        for (const s of sessions) {
            if (['pending', 'joining', 'recording'].includes(s.status)) {
                s.isLive = meetBot.isSessionActive(s.id);
            }
        }

        res.json(sessions);
    } catch (err) {
        console.error('[MeetBot] /sessions error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /sessions/:id — Get a specific session
 */
router.get('/sessions/:id', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const session = await meetBotStore.getSession(req.params.id);
        if (!session || session.userId !== userId) {
            return res.status(404).json({ error: 'Session not found' });
        }

        if (['pending', 'joining', 'recording'].includes(session.status)) {
            session.isLive = meetBot.isSessionActive(session.id);
        }

        res.json(session);
    } catch (err) {
        console.error('[MeetBot] /sessions/:id error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /sessions/:id/stop — Stop an active bot
 */
router.post('/sessions/:id/stop', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const session = await meetBotStore.getSession(req.params.id);
        if (!session || session.userId !== userId) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const stopped = meetBot.stopSession(req.params.id);
        if (stopped) {
            res.json({ message: 'Bot is stopping', status: 'stopping' });
        } else {
            res.json({ message: 'Bot is not currently active', status: session.status });
        }
    } catch (err) {
        console.error('[MeetBot] /stop error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /sessions/:id — Delete a session
 */
router.delete('/sessions/:id', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const session = await meetBotStore.getSession(req.params.id);
        if (!session || session.userId !== userId) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Don't delete active sessions
        if (meetBot.isSessionActive(req.params.id)) {
            return res.status(400).json({ error: 'Cannot delete an active session. Stop it first.' });
        }

        await meetBotStore.deleteSession(req.params.id);

        const storageKey = decodeStorageKeyFromProxyPath(session.audioPath);
        if (storageKey && storageStore.isAvailable()) {
            try {
                await storageStore.deleteFile(storageKey);
                console.log(`[MeetBot] Deleted RustFS recording: ${storageKey}`);
            } catch (e) {
                console.warn(`[MeetBot] Failed to delete RustFS recording ${storageKey}: ${e.message}`);
            }
        }

        res.json({ deleted: true });
    } catch (err) {
        console.error('[MeetBot] /delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
