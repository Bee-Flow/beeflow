/**
 * Shared meeting-notes pipeline helpers.
 *
 * Extracted from `server/routes/transcriptions.js` so both the HTTP routes
 * and the background Nextcloud Talk auto-ingest can reuse the exact same
 * logic without duplicating it (or creating a circular require on the route
 * module). Holds:
 *   - model-tier resolution (EU-aware)
 *   - speaker-name identification (diarization → real names)
 *   - meeting summary / title / action-item generation
 *   - the WhisperX provider call
 *   - segment merge + transcript/speaker artifact builder
 */

const llmClient = require('../llmClient');
const fs = require('fs');

const LANG_NAMES = { nl: 'Dutch', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese' };

async function resolveSmartModel(userOrgId = null) {
    try {
        const { resolveModelForTierName } = require('../modelResolver');
        return await resolveModelForTierName('smart', { userOrgId, fallback: 'gemini-2.0-flash' });
    } catch (_) {
        return 'gemini-2.0-flash';
    }
}

async function resolveFastModel(userOrgId = null) {
    try {
        const { resolveModelForTierName } = require('../modelResolver');
        return await resolveModelForTierName('fast', { userOrgId, fallback: 'gemini-2.0-flash-lite' });
    } catch (_) {
        return 'gemini-2.0-flash-lite';
    }
}

/**
 * Use the fast-tier LLM to identify speaker names from transcript context.
 */
async function identifySpeakerNames(transcript, speakerIds, language, userName, userOrgId = null) {
    try {
        const modelId = await resolveFastModel(userOrgId);

        const speakerList = speakerIds.join(', ');
        const userHint = userName
            ? `\n\nSTRONG HINT: The person who recorded this meeting is named "${userName}". They are almost certainly one of the speakers. Identify which speaker ID(s) belong to "${userName}" by looking at who speaks most, who introduces the meeting, or who uses first-person statements. Map those IDs to "${userName}".`
            : '';

        const systemPrompt = `You are a transcript analyst. Identify who is actually SPEAKING in this transcript.

CRITICAL — Speaking vs. Being Mentioned:
- A person is a SPEAKER if they introduce themselves ("I am Tom", "Ik ben Tom") or are directly addressed ("Tom, what do you think?").
- A person is merely MENTIONED if others talk ABOUT them in third person. Being mentioned does NOT make someone a speaker.
- NEVER assign the name of a mentioned-but-absent person to a speaker ID.

DIARIZATION: One person often gets multiple speaker IDs. Map them all to the same name.

Rules:
1. Map EVERY speaker_ID to a first name (or "Speaker A", "Speaker B" if unknown).
2. Multiple IDs can map to the same name — this is expected.
3. Never return null. All IDs must get a value.${userHint}

Return ONLY a JSON object: {"speaker_1": "Tom", "speaker_2": "Gerard", "speaker_3": "Tom"}
No explanation, no markdown, ONLY valid JSON.`;

        const result = await llmClient.chat(modelId, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Speakers: ${speakerList}\nLanguage: ${language}\n\n${transcript.substring(0, 60000)}` },
        ], { maxTokens: 512, temperature: 0 });

        const content = (result.content || '').trim();
        const jsonStart = content.indexOf('{');
        const jsonEnd = content.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
            const mapping = JSON.parse(content.substring(jsonStart, jsonEnd + 1));
            for (const [key, value] of Object.entries(mapping)) {
                if (!value || value === 'null' || value === 'unknown' || value === 'Unknown') {
                    delete mapping[key];
                }
            }
            console.log(`[Transcriptions] Speaker names via ${modelId}:`, mapping);
            return mapping;
        }
    } catch (err) {
        console.error('[Transcriptions] Speaker identification failed:', err.message);
    }
    return null;
}

/**
 * Generate a structured meeting summary using the smart-tier LLM.
 */
async function generateMeetingSummary(transcript, language, userOrgId = null) {
    try {
        const modelId = await resolveSmartModel(userOrgId);
        const langName = LANG_NAMES[language] || language;

        // Native-language section headers for the most-used locales. For
        // unknown languages we fall back to English headers and let the LLM
        // translate the body into `langName`.
        const HEADERS = {
            nl: { summary: '📋 Samenvatting', topics: '🔑 Belangrijkste onderwerpen', decisions: '✅ Besluiten', actions: '📌 Actiepunten', insights: '💡 Inzichten' },
            en: { summary: '📋 Summary',      topics: '🔑 Key Topics',                decisions: '✅ Decisions Made', actions: '📌 Action Items', insights: '💡 Key Insights' },
            de: { summary: '📋 Zusammenfassung', topics: '🔑 Hauptthemen', decisions: '✅ Entscheidungen', actions: '📌 Aufgaben', insights: '💡 Erkenntnisse' },
            fr: { summary: '📋 Résumé',       topics: '🔑 Sujets clés',  decisions: '✅ Décisions',     actions: '📌 Actions',      insights: '💡 Points clés' },
        };
        const h = HEADERS[language] || HEADERS.en;

        const result = await llmClient.chat(modelId, [
            {
                role: 'system',
                content: `You are a meeting assistant. Create a concise, well-structured summary of the meeting transcript. Write the entire summary in ${langName} — do not mix languages.

Format with these markdown sections (use these EXACT section headings, in this order):
## ${h.summary}
A brief 2-3 sentence overview of what the meeting was about.

## ${h.topics}
- Bullet points of main topics discussed

## ${h.decisions}
- Decisions that were agreed upon (skip the section entirely if there are none)

## ${h.actions}
- Specific tasks assigned to people (skip if none)

## ${h.insights}
- Notable ideas, suggestions, or observations

Keep it concise and actionable. Skip empty sections rather than writing "none".`,
            },
            { role: 'user', content: transcript },
        ], { maxTokens: 4096, temperature: 0.3 });

        const summary = (result.content || '').trim();
        console.log(`[Transcriptions] Meeting summary generated (${summary.length} chars) via ${modelId}`);
        return summary;
    } catch (err) {
        console.error('[Transcriptions] Summary generation failed:', err.message);
        return '';
    }
}

/**
 * Generate a short, descriptive meeting title using the fast-tier LLM.
 */
async function generateMeetingTitle(summary, language, userOrgId = null) {
    try {
        const modelId = await resolveFastModel(userOrgId);
        const langName = LANG_NAMES[language] || language;

        const result = await llmClient.chat(modelId, [
            { role: 'system', content: `Generate a short, descriptive title (max 8 words) for this meeting based on the summary. Write in ${langName}. Return ONLY the title, nothing else. No quotes, no prefixes.` },
            { role: 'user', content: summary.substring(0, 1000) },
        ], { maxTokens: 50, temperature: 0 });

        const title = (result.content || '').trim().replace(/^["']|["']$/g, '');
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
 * Extract structured action items from the transcript using the smart-tier LLM.
 */
async function extractActionItems(transcript, language, userOrgId = null) {
    try {
        const modelId = await resolveSmartModel(userOrgId);
        const langName = LANG_NAMES[language] || language;

        const nlExample = language === 'nl' ? `

Voorbeelden van Nederlandse actiepunten:
- "Tom belt klant volgende week maandag" → text: "Klant bellen", assignee: "Tom", timestamp: "12:30"
- "Sandra stuurt het rapport voor vrijdag op" → text: "Rapport opsturen", assignee: "Sandra", timestamp: "08:15"` : '';

        const result = await llmClient.chat(modelId, [
            {
                role: 'system',
                content: `You are a meeting analyst. Extract all action items, tasks, and follow-ups from the meeting transcript. For each action item, identify who is responsible (the assignee) and what needs to be done.

Return ONLY a JSON array of objects. Each object must have:
- "text": the action item description (in ${langName})
- "assignee": the person responsible (first name or "${language === 'nl' ? 'Niet toegewezen' : 'Unassigned'}" if unclear)
- "timestamp": the approximate timestamp in the transcript where this was discussed (format: "MM:SS" or "HH:MM:SS")

If there are no action items, return an empty array []. Return ONLY valid JSON, no other text.${nlExample}`,
            },
            { role: 'user', content: transcript.substring(0, 80000) },
        ], { maxTokens: 2048, temperature: 0 });

        const content = (result.content || '').trim();
        const jsonStart = content.indexOf('[');
        const jsonEnd = content.lastIndexOf(']');
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
            const items = JSON.parse(content.substring(jsonStart, jsonEnd + 1));
            return items.map((item, idx) => ({
                id: `ai-${idx}`,
                text: item.text || '',
                assignee: item.assignee || 'Unassigned',
                timestamp: item.timestamp || '',
                done: false,
            }));
        }
    } catch (err) {
        console.error('[Transcriptions] Action item extraction failed:', err.message);
    }
    return [];
}

/**
 * Transcribe with the self-hosted WhisperX service. Returns a
 * Voxtral-compatible `{ text, segments:[{text,start,end,speakerId}] }` shape.
 */
async function transcribeWithWhisperX(filePath, fileName, language, contextTerms) {
    const whisperxUrl = process.env.WHISPERX_URL || 'https://services.beeflow.nl/whisperx';
    const FormData = require('form-data');
    const fetch = require('node-fetch');

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), fileName);
    form.append('language', language);
    form.append('diarize', 'true');
    if (contextTerms) form.append('context_terms', contextTerms);

    console.log(`[Transcriptions] Sending to WhisperX at ${whisperxUrl}/transcribe ...`);

    const apiKey = process.env.SERVICES_API_KEY;
    const resp = await fetch(`${whisperxUrl}/transcribe`, {
        method: 'POST',
        body: form,
        headers: {
            ...form.getHeaders(),
            ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        timeout: 600000, // 10 minutes for long files
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`WhisperX service error (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    console.log(`[Transcriptions] WhisperX: ${data.segments?.length || 0} segments, ${data.device}, processed in ${data.processingTime}s`);

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

function formatTime(s) {
    if (s == null) return '00:00';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    return h > 0 ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
                 : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * Merge consecutive same-speaker segments and derive the formatted transcript
 * string, the per-speaker stats and total duration. Mirrors the logic in the
 * main upload route.
 */
function buildTranscriptArtifacts(segments) {
    const merged = [];
    for (const seg of segments || []) {
        const last = merged[merged.length - 1];
        if (last && seg.speakerId === last.speakerId) {
            last.end = seg.end;
            last.text += ' ' + (seg.text || '').trim();
        } else {
            merged.push({ speaker: seg.speakerId || 'Unknown', speakerId: seg.speakerId || 'Unknown', start: seg.start, end: seg.end, text: (seg.text || '').trim() });
        }
    }
    const totalDuration = (segments && segments.length) ? Math.max(...segments.map(s => s.end || 0)) : 0;
    const transcript = merged.map(s => `[${s.speaker}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`).join('\n');

    const speakerMap = {};
    for (const s of merged) {
        if (!speakerMap[s.speaker]) speakerMap[s.speaker] = { duration: 0, segments: 0 };
        speakerMap[s.speaker].duration += (s.end || 0) - (s.start || 0);
        speakerMap[s.speaker].segments += 1;
    }
    const speakers = Object.entries(speakerMap).map(([id, d]) => ({
        id, speakingTime: formatTime(d.duration), speakingSeconds: Math.round(d.duration), segments: d.segments,
    }));

    return { merged, transcript, speakers, totalDuration };
}

module.exports = {
    resolveSmartModel,
    resolveFastModel,
    identifySpeakerNames,
    generateMeetingSummary,
    generateMeetingTitle,
    extractActionItems,
    transcribeWithWhisperX,
    formatTime,
    buildTranscriptArtifacts,
};
