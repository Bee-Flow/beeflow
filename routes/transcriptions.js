/**
 * Transcriptions API — REST endpoints for meeting transcription history.
 *
 * GET    /api/transcriptions          — List user's transcriptions
 * GET    /api/transcriptions/:id      — Get full transcription with segments
 * POST   /api/transcriptions          — Upload & transcribe an audio file
 * PATCH  /api/transcriptions/:id      — Rename a transcription
 * DELETE /api/transcriptions/:id      — Delete a transcription
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const transcriptionStore = require('../stores/transcriptionStore');
const configStore = require('../stores/configStore');

// Multer for audio file upload
const uploadsDir = path.resolve(__dirname, '../data/uploads/audio');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const allowed = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg', '.aac'];
        if (allowed.includes(ext) || file.mimetype?.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported audio format. Supported: MP3, WAV, M4A, OGG, WEBM, FLAC, MP4, AAC'));
        }
    },
});

/**
 * Get an Anthropic client using the provider key for Claude.
 */
async function getClaudeClient() {
    const { getProviderForModel } = require('../core/aiAgent');
    const config = await getProviderForModel('claude-opus-4-6');
    if (!config || !config.apiKey) throw new Error('Claude API key not configured');
    const Anthropic = require('@anthropic-ai/sdk');
    return new Anthropic({ apiKey: config.apiKey });
}

/**
 * Use Claude to identify speaker names from transcript context.
 */
async function identifySpeakerNames(transcript, speakerIds, language) {
    try {
        const client = await getClaudeClient();

        const speakerList = speakerIds.join(', ');
        const response = await client.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 1024,
            temperature: 0,
            system: `You are a transcript analyzer. Identify the real names of the people who are ACTUALLY SPEAKING in this meeting.

CRITICAL DISTINCTION — Speaking vs. Being Mentioned:
- A person is a SPEAKER if they introduce themselves ("I am Tom", "Ik ben Tom") or are directly addressed by another speaker ("Tom, what do you think?", "Tom, jij ook?").
- A person is merely MENTIONED if others talk ABOUT them in the third person ("Wesley zit daar ook", "We should ask Wesley", "Als Wesley er nou bij was"). Being mentioned does NOT make someone a speaker.
- NEVER assign the name of a person who is only talked about to a speaker_ID. Only use names of people who are actually present and speaking in the meeting.

DIARIZATION CONTEXT: Speech diarization often splits one person into multiple speaker IDs. A meeting with 3 real speakers may show 10+ speaker_IDs. You MUST group them correctly.

Instructions:
1. Read the FULL transcript and identify which named people are actually SPEAKING (present in the room, taking turns) vs. which are just being discussed/referenced.
2. Map EVERY speaker_ID to a real speaker's first name. Multiple speaker_IDs often map to the SAME person — this is expected.
3. Use ONLY simple first names (e.g. "Tom", "Gerard"). No descriptions or qualifiers.
4. If you can only identify some speakers by name, use "Speaker A", "Speaker B" etc. for unidentified ones — do NOT guess with names of mentioned-but-absent people.
5. NEVER return null. Every speaker_ID must get a name string.

Return ONLY a JSON object. Example: {"speaker_1": "Tom", "speaker_2": "Gerard", "speaker_3": "Tom", "speaker_4": "Speaker A"}

IMPORTANT: Return ONLY valid JSON, no other text. No null values.`,
            messages: [
                { role: 'user', content: `Speakers: ${speakerList}\nLanguage: ${language}\n\n${transcript.substring(0, 100000)}` }
            ],
        });

        const content = (response.content?.[0]?.text || '').trim();
        // Extract the first valid JSON object from the response
        const jsonStart = content.indexOf('{');
        const jsonEnd = content.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
            const jsonStr = content.substring(jsonStart, jsonEnd + 1);
            let mapping;
            try {
                mapping = JSON.parse(jsonStr);
            } catch {
                // If full range fails, try to find a balanced JSON object
                let depth = 0, end = -1;
                for (let i = jsonStart; i < content.length; i++) {
                    if (content[i] === '{') depth++;
                    else if (content[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
                }
                if (end > jsonStart) {
                    mapping = JSON.parse(content.substring(jsonStart, end + 1));
                }
            }
            if (mapping) {
                for (const [key, value] of Object.entries(mapping)) {
                    if (!value || value === 'null' || value === 'unknown' || value === 'Unknown') {
                        delete mapping[key];
                    }
                }
                console.log('[Transcriptions] Speaker names identified:', mapping);
                return mapping;
            }
        }
    } catch (err) {
        console.error('[Transcriptions] Speaker identification failed:', err.message);
    }
    return null;
}

/**
 * Generate a structured meeting summary using Claude.
 */
async function generateMeetingSummary(transcript, language) {
    try {
        const client = await getClaudeClient();

        const langName = { nl: 'Dutch', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese' }[language] || language;

        const response = await client.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 4096,
            temperature: 0.3,
            system: `You are a meeting assistant. Create a concise, well-structured summary of the meeting transcript. Write the summary in ${langName}.

Format the summary with these sections (use markdown):
## 📋 Summary
A brief 2-3 sentence overview of what the meeting was about.

## 🔑 Key Topics
- Bullet points of main topics discussed

## ✅ Decisions Made
- Any decisions that were agreed upon (skip if none)

## 📌 Action Items
- Specific tasks assigned to people (skip if none)

## 💡 Key Insights
- Notable ideas, suggestions, or observations

Keep it concise and actionable. Skip empty sections.`,
            messages: [
                { role: 'user', content: transcript }
            ],
        });

        const summary = (response.content?.[0]?.text || '').trim();
        console.log(`[Transcriptions] Meeting summary generated (${summary.length} chars)`);
        return summary;
    } catch (err) {
        console.error('[Transcriptions] Summary generation failed:', err.message);
        return '';
    }
}

/**
 * Generate a short, descriptive meeting title using Claude.
 */
async function generateMeetingTitle(summary, language) {
    try {
        const client = await getClaudeClient();

        const langName = { nl: 'Dutch', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese' }[language] || language;

        const response = await client.messages.create({
            model: 'claude-opus-4-6',
            max_tokens: 50,
            temperature: 0,
            system: `Generate a short, descriptive title (max 8 words) for this meeting based on the summary. Write in ${langName}. Return ONLY the title, nothing else. No quotes, no prefixes.`,
            messages: [
                { role: 'user', content: summary.substring(0, 1000) }
            ],
        });

        const title = (response.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '');
        if (title && title.length > 2 && title.length < 100) {
            console.log(`[Transcriptions] AI title: "${title}"`);
            return title;
        }
    } catch (err) {
        console.error('[Transcriptions] Title generation failed:', err.message);
    }
    return null;
}

/**
 * Transcribe audio via the self-hosted WhisperX FastAPI service.
 * Returns a response object with the same shape as Voxtral output.
 */
async function transcribeWithWhisperX(filePath, fileName, language, contextTerms) {
    const whisperxUrl = process.env.WHISPERX_URL || 'http://localhost:8787';
    const FormData = require('form-data');
    const fetch = require('node-fetch');

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), fileName);
    form.append('language', language);
    form.append('diarize', 'true');
    if (contextTerms) form.append('context_terms', contextTerms);

    console.log(`[Transcriptions] Sending to WhisperX at ${whisperxUrl}/transcribe ...`);

    const resp = await fetch(`${whisperxUrl}/transcribe`, {
        method: 'POST',
        body: form,
        headers: form.getHeaders(),
        timeout: 600000, // 10 minutes for long files
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`WhisperX service error (${resp.status}): ${errText}`);
    }

    const data = await resp.json();

    console.log(`[Transcriptions] WhisperX: ${data.segments?.length || 0} segments, ${data.device}, processed in ${data.processingTime}s`);

    // Return in Voxtral-compatible shape
    return {
        text: data.text || '',
        segments: (data.segments || []).map(seg => ({
            text: seg.text,
            start: seg.start,
            end: seg.end,
            speakerId: seg.speakerId || 'speaker_0',
        })),
    };
}

// Auth middleware
function requireAuth(req, res, next) {
    if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

// ── List transcriptions ──────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const offset = parseInt(req.query.offset) || 0;
        const transcriptions = await transcriptionStore.getTranscriptions(userId, { limit, offset });
        res.json({ transcriptions });
    } catch (err) {
        console.error('[Transcriptions] List error:', err.message);
        res.status(500).json({ error: 'Failed to list transcriptions' });
    }
});

// ── Get single transcription ─────────────────────────────

router.get('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId);
        if (!transcription) return res.status(404).json({ error: 'Transcription not found' });
        res.json(transcription);
    } catch (err) {
        console.error('[Transcriptions] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get transcription' });
    }
});

// ── Upload & transcribe ──────────────────────────────────

router.post('/', requireAuth, upload.single('audio'), async (req, res) => {
    const userId = req.session.user.id;

    if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const language = req.body.language || 'nl';
    const contextTerms = req.body.context_terms || '';
    let title = req.body.title || req.file.originalname || 'Untitled';

    try {
        // Set route timeout to 10 minutes for large files (WhisperX can be slower on CPU)
        req.setTimeout(600000);
        res.setTimeout(600000);

        const fileContent = fs.readFileSync(req.file.path);
        const fileName = req.file.originalname || 'audio.mp3';
        const provider = req.body.provider || 'voxtral';

        console.log(`[Transcriptions] Transcribing "${fileName}" (${(fileContent.length / (1024 * 1024)).toFixed(1)} MB) via ${provider} for user ${userId}`);

        let response;

        if (provider === 'whisperx') {
            // ── WhisperX (self-hosted) ───────────────────────
            response = await transcribeWithWhisperX(req.file.path, fileName, language, contextTerms);
        } else {
            // ── Voxtral (cloud) ──────────────────────────────
            const apiKey = await configStore.getSecret('mistral_api_key');
            if (!apiKey) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
                return res.status(400).json({ error: 'Mistral API key not configured' });
            }

            const { Mistral } = require('@mistralai/mistralai');
            const client = new Mistral({ apiKey, timeout: 300000 });

            const transcriptionOptions = {
                model: 'voxtral-mini-2602',
                file: { fileName, content: fileContent },
                diarize: true,
                language,
                timestampGranularities: ['segment'],
            };
            if (contextTerms) transcriptionOptions.prompt = contextTerms;

            response = await client.audio.transcriptions.complete(transcriptionOptions);
        }

        // Merge segments
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
            if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
            return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
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
        const nameMapping = await identifySpeakerNames(transcript, speakerIds, language);

        if (nameMapping) {
            // Apply name mapping to segments
            for (const seg of merged) {
                if (nameMapping[seg.speaker]) seg.speaker = nameMapping[seg.speaker];
            }
            // Re-generate transcript with real names
            transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');
            // Update speakers list with mapped names
            speakers = speakers.map(s => ({
                ...s,
                id: nameMapping[s.id] || s.id,
            }));
        }

        // Merge speakers with the same name (e.g. multiple "Gerard" entries)
        const mergedSpeakers = {};
        for (const s of speakers) {
            if (mergedSpeakers[s.id]) {
                mergedSpeakers[s.id].speakingSeconds += s.speakingSeconds;
                mergedSpeakers[s.id].segments += s.segments;
            } else {
                mergedSpeakers[s.id] = { ...s };
            }
        }
        speakers = Object.values(mergedSpeakers).map(s => ({
            ...s,
            speakingTime: formatTime(s.speakingSeconds),
        }));

        // Generate meeting summary with Claude
        const summary = await generateMeetingSummary(transcript, language);

        // Always generate AI title from summary
        if (summary) {
            const aiTitle = await generateMeetingTitle(summary, language);
            if (aiTitle) title = aiTitle;
        }

        // Save audio permanently for playback
        const audioDir = path.resolve(__dirname, '../data/uploads/saved-recordings');
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
        const ext = path.extname(req.file.originalname || '.webm') || '.webm';
        const audioName = `${Date.now()}-${userId}${ext}`;
        const audioPath = path.join(audioDir, audioName);
        try {
            fs.copyFileSync(req.file.path, audioPath);
            fs.unlinkSync(req.file.path);
        } catch (_) {
            // If copy fails, just clean up temp
            try { fs.unlinkSync(req.file.path); } catch (_) {}
        }

        // Save to DB
        const saved = await transcriptionStore.createTranscription({
            userId,
            title,
            fileName,
            language,
            durationSeconds: Math.round(totalDuration),
            speakerCount: speakers.length,
            segmentCount: merged.length,
            fullText: response.text || '',
            transcript,
            segments: merged,
            speakers,
            summary,
            audioPath: fs.existsSync(audioPath) ? audioPath : '',
            provider,
        });

        res.json({
            id: saved.id,
            title,
            fileName,
            language,
            duration: formatTime(totalDuration),
            durationSeconds: Math.round(totalDuration),
            speakerCount: speakers.length,
            segmentCount: merged.length,
            speakers,
            fullText: response.text || '',
            transcript,
            segments: merged,
            summary,
        });

    } catch (err) {
        // Save recording for manual reprocessing instead of deleting
        let savedPath = '';
        try {
            if (req.file?.path && fs.existsSync(req.file.path)) {
                const savedDir = path.resolve(__dirname, '../data/uploads/saved-recordings');
                if (!fs.existsSync(savedDir)) fs.mkdirSync(savedDir, { recursive: true });
                const ext = path.extname(req.file.originalname || '.webm') || '.webm';
                const savedName = `${Date.now()}-${userId}${ext}`;
                savedPath = path.join(savedDir, savedName);
                fs.copyFileSync(req.file.path, savedPath);
                fs.unlinkSync(req.file.path);
                console.log(`[Transcriptions] Saved failed recording to ${savedPath}`);
            }
        } catch (saveErr) {
            console.error('[Transcriptions] Failed to save recording:', saveErr.message);
        }

        // Create a "failed" record so it shows in the list
        try {
            const saved = await transcriptionStore.createTranscription({
                userId,
                title: req.body.title || req.file?.originalname || 'Failed Transcription',
                fileName: req.file?.originalname || 'unknown',
                language: req.body.language || 'nl',
                status: 'failed',
                audioPath: savedPath,
            });
            console.error('[Transcriptions] Transcribe error:', err.message);
            res.status(500).json({ error: `Transcription failed: ${err.message}`, id: saved.id, status: 'failed' });
        } catch (dbErr) {
            console.error('[Transcriptions] Transcribe error:', err.message);
            res.status(500).json({ error: `Transcription failed: ${err.message}` });
        }
    }
});

// ── Reprocess failed transcription ───────────────────────

router.post('/:id/reprocess', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId);
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (transcription.status !== 'failed') return res.status(400).json({ error: 'Only failed transcriptions can be reprocessed' });
        if (!transcription.audioPath || !fs.existsSync(transcription.audioPath)) {
            return res.status(400).json({ error: 'Audio file not found. Cannot reprocess.' });
        }

        const apiKey = await configStore.getSecret('mistral_api_key');
        if (!apiKey) return res.status(400).json({ error: 'Mistral API key not configured' });

        const { Mistral } = require('@mistralai/mistralai');
        const client = new Mistral({ apiKey });

        const fileContent = fs.readFileSync(transcription.audioPath);
        const fileName = transcription.fileName || 'audio.webm';
        const language = transcription.language || 'nl';

        console.log(`[Transcriptions] Reprocessing "${fileName}" (${(fileContent.length / (1024 * 1024)).toFixed(1)} MB)`);

        const response = await client.audio.transcriptions.complete({
            model: 'voxtral-mini-2602',
            file: { fileName, content: fileContent },
            diarize: true,
            language,
            timestampGranularities: ['segment'],
        });

        // Merge segments
        const segments = response.segments || [];
        const merged = [];
        for (const seg of segments) {
            const last = merged[merged.length - 1];
            if (last && seg.speakerId === last.speakerId) {
                last.end = seg.end;
                last.text += ' ' + (seg.text || '').trim();
            } else {
                merged.push({ speaker: seg.speakerId || 'Unknown', start: seg.start, end: seg.end, text: (seg.text || '').trim() });
            }
        }

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
            if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
            return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        };

        let transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');
        let speakers = Object.entries(speakerMap).map(([id, data]) => ({ id, speakingTime: formatTime(data.duration), speakingSeconds: Math.round(data.duration), segments: data.segments }));

        // Speaker identification
        const speakerIds = Object.keys(speakerMap);
        const nameMapping = await identifySpeakerNames(transcript, speakerIds, language);
        if (nameMapping) {
            for (const seg of merged) { if (nameMapping[seg.speaker]) seg.speaker = nameMapping[seg.speaker]; }
            transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');
            speakers = speakers.map(s => ({ ...s, id: nameMapping[s.id] || s.id }));
        }

        // Merge speakers with the same name
        const mergedSpeakers = {};
        for (const s of speakers) {
            if (mergedSpeakers[s.id]) {
                mergedSpeakers[s.id].speakingSeconds += s.speakingSeconds;
                mergedSpeakers[s.id].segments += s.segments;
            } else {
                mergedSpeakers[s.id] = { ...s };
            }
        }
        speakers = Object.values(mergedSpeakers).map(s => ({
            ...s,
            speakingTime: formatTime(s.speakingSeconds),
        }));

        // Summary
        const summary = await generateMeetingSummary(transcript, language);

        // Update the existing record
        const { run } = require('../stores/db');
        await run(
            `UPDATE transcriptions SET status = $1, duration_seconds = $2, speaker_count = $3, segment_count = $4, full_text = $5, transcript = $6, segments = $7, speakers = $8, summary = $9, updated_at = NOW() WHERE id = $10 AND user_id = $11`,
            ['completed', Math.round(totalDuration), Object.keys(speakerMap).length, merged.length, response.text || '', transcript, JSON.stringify(merged), JSON.stringify(speakers), summary, req.params.id, userId]
        );

        // Delete saved audio file after successful reprocessing
        try { fs.unlinkSync(transcription.audioPath); } catch (_) {}

        res.json({ success: true, id: req.params.id, status: 'completed' });
    } catch (err) {
        console.error('[Transcriptions] Reprocess error:', err.message);
        res.status(500).json({ error: `Reprocessing failed: ${err.message}` });
    }
});

// ── Serve audio file for playback ────────────────────────

router.get('/:id/audio', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId);
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (!transcription.audioPath || !fs.existsSync(transcription.audioPath)) {
            return res.status(404).json({ error: 'Audio file not available' });
        }
        const ext = path.extname(transcription.audioPath).toLowerCase();
        const mimeMap = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.flac': 'audio/flac', '.aac': 'audio/aac', '.mp4': 'audio/mp4' };
        res.setHeader('Content-Type', mimeMap[ext] || 'audio/mpeg');
        res.setHeader('Content-Disposition', `inline; filename="${transcription.fileName || 'audio' + ext}"`);
        fs.createReadStream(transcription.audioPath).pipe(res);
    } catch (err) {
        console.error('[Transcriptions] Audio serve error:', err.message);
        res.status(500).json({ error: 'Failed to serve audio' });
    }
});

// ── Rename transcription ─────────────────────────────────

router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { title } = req.body;
        if (!title) return res.status(400).json({ error: 'Title is required' });
        const updated = await transcriptionStore.updateTranscription(req.params.id, userId, { title });
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Transcriptions] Update error:', err.message);
        res.status(500).json({ error: 'Failed to update' });
    }
});

// ── Delete transcription ─────────────────────────────────

router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const deleted = await transcriptionStore.deleteTranscription(req.params.id, userId);
        if (!deleted) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Transcriptions] Delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// ── Share/unshare transcription ──────────────────────────

router.post('/:id/share', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { userIds } = req.body; // Array of user IDs to share with
        if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds must be an array' });

        // Only the owner can share
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId);
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can share' });

        // Merge new userIds with existing shared_with (deduplicated)
        const existing = transcription.sharedWith || [];
        const merged = [...new Set([...existing, ...userIds])].filter(id => id !== userId);

        await transcriptionStore.updateTranscription(req.params.id, userId, { sharedWith: merged });
        res.json({ success: true, sharedWith: merged });
    } catch (err) {
        console.error('[Transcriptions] Share error:', err.message);
        res.status(500).json({ error: 'Failed to share' });
    }
});

router.post('/:id/unshare', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { userIds } = req.body;
        if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds must be an array' });

        const transcription = await transcriptionStore.getTranscription(req.params.id, userId);
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can manage sharing' });

        const remaining = (transcription.sharedWith || []).filter(id => !userIds.includes(id));
        await transcriptionStore.updateTranscription(req.params.id, userId, { sharedWith: remaining });
        res.json({ success: true, sharedWith: remaining });
    } catch (err) {
        console.error('[Transcriptions] Unshare error:', err.message);
        res.status(500).json({ error: 'Failed to unshare' });
    }
});

// ── Multer error handling ────────────────────────────────

router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 500 MB.' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
});

module.exports = router;
