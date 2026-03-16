/**
 * Template Chat Routes — AI-powered chat for filling Word templates.
 *
 * SSE streaming endpoint that provides context-aware AI chat
 * with template parameters and optional meeting note context.
 * Reuses the same streaming pattern as directChat.js.
 */

const express = require('express');
const router = express.Router();
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const templateStore = require('../../stores/templateStore');
const transcriptionStore = require('../../stores/transcriptionStore');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Streaming Template Chat ─────────────────────────────────────

router.post('/chat/template/stream', requireAuth, async (req, res) => {
    const { message, templateId, conversationId, history, meetingNoteIds, modelTier, timezone, attachments } = req.body;
    const userId = req.session.user.id;

    if (!message) {
        return res.status(400).json({ error: 'Message required' });
    }

    if (!templateId) {
        return res.status(400).json({ error: 'Template ID required' });
    }

    // Load template
    const template = await templateStore.getTemplate(templateId, userId);
    if (!template) {
        return res.status(404).json({ error: 'Template not found' });
    }

    // Resolve model from tier config
    let tiers = await configStore.getConfig('chat_model_tiers') || {};
    let resolvedTier = modelTier || 'fast';
    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;

    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model || 'mistral-small-latest';
    }

    // Resolve provider
    const config = await getProviderForModel(modelId);
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(config.providerType, apiUrl);

    console.log(`[TemplateChat] Model: ${modelId} (tier: ${resolvedTier}) for template: ${template.name}`);

    // Set SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        // Build template context
        // Parameters are { name, description } objects
        const paramList = template.parameters.length > 0
            ? template.parameters.map(p => {
                const param = typeof p === 'string' ? { name: p, description: '' } : p;
                return param.description
                    ? `- {{${param.name}}} — ${param.description}`
                    : `- {{${param.name}}}`;
            }).join('\n')
            : '(No parameters detected — the template may use different formatting)';

        const paramNames = template.parameters.map(p => typeof p === 'string' ? p : p.name);

        let templateContext = `\n\n[TEMPLATE CONTEXT]
Template Name: "${template.name}"
File: ${template.fileName}
${template.description ? `Description: ${template.description}` : ''}

Parameters to fill:
${paramList}

CRITICAL INSTRUCTIONS — READ CAREFULLY:
You are helping fill a Word document template with {{parameter}} placeholders.

YOUR #1 PRIORITY: Fill ALL parameters from available context WITHOUT asking the user.

You have access to:
- Meeting note transcripts (attached below if selected)
- Template knowledge base (attached below if available)
- Custom instructions from the template owner
- Conversation history and uploaded documents
- Your general knowledge about business, law, and standard practices

STRICT WORKFLOW — follow this order:
1. EXHAUST ALL CONTEXT FIRST: Read every piece of context carefully. Extract names, dates, addresses, phone numbers, company names, product descriptions, legal terms, etc. from meeting notes, KB, uploaded documents.
2. MAKE INFORMED ASSUMPTIONS: For anything not explicitly stated, use reasonable defaults:
   - Today's date for effective dates
   - Standard legal/business phrasing for descriptions
   - Derive company info from email addresses, website mentions, context clues
   - Use patterns from similar documents in the KB
   - If a template has an example or reference document as context, follow its structure
3. FILL EVERYTHING YOU CAN: Be aggressive. If you can make a reasonable guess, fill it.
4. OUTPUT THE JSON IMMEDIATELY when you have ≥80% of parameters filled:
\`\`\`json
{
${paramNames.map(p => `  "${p}": "filled value here"`).join(',\n')}
}
\`\`\`

5. ONLY use a form for the ABSOLUTE MINIMUM of truly unknown values (max 2-3 fields).
   A form should be a LAST RESORT, not a first response.

[WHEN YOU MUST USE A FORM — RARE]
If after exhausting all context you still have 2-3 values that are impossible to determine:

\`\`\`json-form
{
  "description": "I filled [X] of [Y] parameters from context. I just need [2-3] values I couldn't find:",
  "submitLabel": "Bevestig & Genereer",
  "fields": [
    { "name": "field_id", "type": "text", "label": "Label", "defaultValue": "Best guess", "hint": "Why I need this" }
  ]
}
\`\`\`

Available types: text, select, textarea, checkbox, radio, number, date, time, email, tel, url
Fields support: name, type, label, placeholder, required, options, hint, min, max, step, defaultValue.

ABSOLUTE RULES:
- NEVER show a form with more than 5 fields. If you have that many unknowns, you're not trying hard enough.
- NEVER ask for information that exists in the meeting notes, KB, or conversation
- ALWAYS pre-fill defaultValue with your best guess
- Prefer outputting the complete JSON over showing a form
- If a value is ambiguous, use your best judgment and note it — don't ask
- When the user submits a form or says "use what you have", output the COMPLETE JSON immediately`;





        // Inject custom instructions if set
        let instructionsContext = '';
        if (template.instructions && template.instructions.trim()) {
            instructionsContext = `\n\n[CUSTOM INSTRUCTIONS]\n${template.instructions.trim()}`;
        }

        // Load meeting notes if requested
        let meetingContext = '';
        if (meetingNoteIds && Array.isArray(meetingNoteIds) && meetingNoteIds.length > 0) {
            const noteTexts = [];
            for (const noteId of meetingNoteIds.slice(0, 5)) { // Max 5 notes
                try {
                    const note = await transcriptionStore.getTranscription(noteId, userId);
                    if (note) {
                        const transcript = note.fullText || note.transcript || '';
                        const truncated = transcript.slice(0, 4000); // Max 4K chars per note
                        noteTexts.push(`### Meeting: "${note.title}" (${new Date(note.createdAt).toLocaleDateString()})\nSpeakers: ${note.speakerCount || 'unknown'} | Duration: ${Math.round((note.durationSeconds || 0) / 60)} min\n${note.summary ? `Summary: ${note.summary}\n` : ''}Transcript:\n${truncated}${transcript.length > 4000 ? '\n...(truncated)' : ''}`);
                    }
                } catch (err) {
                    console.warn(`[TemplateChat] Failed to load meeting note ${noteId}:`, err.message);
                }
            }
            if (noteTexts.length > 0) {
                meetingContext = `\n\n[MEETING NOTES CONTEXT]\nThe following meeting transcriptions are available as context for filling the template:\n\n${noteTexts.join('\n\n---\n\n')}`;
            }
        }

        // Search template knowledge bases if any
        let kbContext = '';
        const kbIds = template.knowledgeBaseIds || [];
        if (kbIds.length > 0) {
            try {
                const searchUrl = process.env.SEARCH_SERVICE_URL || 'http://search-service:8000';
                const searchRes = await fetch(`${searchUrl}/tools/kb-search`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tenant_id: userId, kb_ids: kbIds, query: message, top_k: 8, rerank: true }),
                    signal: AbortSignal.timeout(10000),
                });
                if (searchRes.ok) {
                    const searchData = await searchRes.json();
                    const chunks = (searchData.chunks || searchData.results || []).filter(c => (c.score || c.rerank_score || 0) >= 0.25);
                    if (chunks.length > 0) {
                        const kbText = chunks.slice(0, 6).map((c, i) => {
                            const src = c.source_uri || c.title || 'KB';
                            const content = (c.content || '').slice(0, 1200);
                            return `### Source ${i + 1}: ${src}\n${content}`;
                        }).join('\n\n');
                        kbContext = `\n\n[TEMPLATE KNOWLEDGE BASE]\nRelevant information from the template's knowledge base:\n${kbText}`;
                        console.log(`[TemplateChat] Injected ${chunks.length} KB chunks for template "${template.name}"`);
                    }
                }
            } catch (kbErr) {
                console.warn('[TemplateChat] KB search failed:', kbErr.message);
            }
        }

        // Build system prompt
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const systemPrompt = `You are a helpful AI assistant specialized in filling Word document templates. Today is ${today}.${templateContext}${instructionsContext}${kbContext}${meetingContext}\nNow: ${new Date().toLocaleString('sv-SE', { timeZone: timezone || 'UTC', timeZoneName: 'short' })}`;

        let messages = [{ role: 'system', content: systemPrompt }];

        // Add conversation history (filter out empty messages)
        if (history && Array.isArray(history)) {
            for (const msg of history) {
                if ((msg.role === 'user' || msg.role === 'assistant') && msg.content?.trim()) {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }

        // Add current message (with attachments if any)
        if (attachments && attachments.length > 0) {
            const contentParts = [];
            if (message) contentParts.push({ type: 'text', text: message });

            for (const att of attachments) {
                try {
                    if (att.type && att.type.startsWith('image/') && att.content) {
                        // Image — pass as multimodal content
                        contentParts.push({ type: 'image_url', image_url: { url: att.content } });
                    } else if (att.source === 'google-drive' && att.content) {
                        // Google Drive file — already exported as text
                        contentParts.push({ type: 'text', text: `--- Google Drive: ${att.name} ---\n${att.content}\n--- End of ${att.name} ---` });
                    } else if (att.content && att.type && att.type.includes('pdf')) {
                        // PDF — extract text
                        const base64Data = att.content.split(',')[1] || att.content;
                        const pdfBuffer = Buffer.from(base64Data, 'base64');
                        let pdfText = '';
                        try {
                            const { extractTextFromPDF } = require('../../core/pdfExtractor');
                            pdfText = await extractTextFromPDF(pdfBuffer, att.name);
                        } catch (e) {
                            console.warn(`[TemplateChat] PDF extraction failed for ${att.name}:`, e.message);
                        }
                        if (pdfText) {
                            contentParts.push({ type: 'text', text: `[PDF Document: ${att.name}]\n---\n${pdfText}\n---` });
                        }
                    } else if (att.content && att.type && (att.type.includes('wordprocessing') || att.name?.endsWith('.docx'))) {
                        // Word doc — extract text with mammoth
                        const base64Data = att.content.split(',')[1] || att.content;
                        const docBuffer = Buffer.from(base64Data, 'base64');
                        try {
                            const mammothLib = require('mammoth');
                            const result = await mammothLib.extractRawText({ buffer: docBuffer });
                            if (result.value) {
                                contentParts.push({ type: 'text', text: `[Word Document: ${att.name}]\n---\n${result.value}\n---` });
                            }
                        } catch (e) {
                            console.warn(`[TemplateChat] Word extraction failed for ${att.name}:`, e.message);
                        }
                    } else if (att.content && typeof att.content === 'string') {
                        // Plain text or other text-based files
                        const textContent = att.content.startsWith('data:') ? Buffer.from(att.content.split(',')[1] || '', 'base64').toString('utf-8') : att.content;
                        if (textContent) {
                            contentParts.push({ type: 'text', text: `[File: ${att.name}]\n---\n${textContent.slice(0, 8000)}\n---` });
                        }
                    }
                } catch (e) {
                    console.warn(`[TemplateChat] Attachment processing failed for ${att.name}:`, e.message);
                }
            }

            // If we have images, send as multimodal; otherwise combine text parts
            const hasImages = contentParts.some(p => p.type === 'image_url');
            if (hasImages) {
                messages.push({ role: 'user', content: contentParts });
            } else {
                const combinedText = contentParts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
                if (combinedText.trim()) messages.push({ role: 'user', content: combinedText });
            }
        } else {
            messages.push({ role: 'user', content: message });
        }

        // Stream response
        const tierSettings = tiers[resolvedTier] || {};
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || 8192,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : 0.7,
        };

        let fullContent = '';
        const streamCallback = (type, data) => {
            if (type === 'text') {
                fullContent += data.text;
                send('content', { text: data.text });
            } else if (type === 'thinking') {
                send('thinking', { text: data.text });
            } else if (type === 'error') {
                send('error', data);
            }
            // 'done' handled after stream completes
        };

        await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, streamCallback);

        send('done', {});
        res.end();

    } catch (err) {
        console.error('[TemplateChat] Error:', err);
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

// ── Get available meeting notes for template context ──────────────

router.get('/chat/template/meeting-notes', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notes = await transcriptionStore.getTranscriptions(userId, { limit: 50 });
        res.json({
            notes: notes.map(n => ({
                id: n.id,
                title: n.title,
                createdAt: n.createdAt,
                durationSeconds: n.durationSeconds,
                speakerCount: n.speakerCount,
            }))
        });
    } catch (err) {
        console.error('[TemplateChat] Meeting notes fetch failed:', err);
        res.status(500).json({ error: 'Failed to fetch meeting notes' });
    }
});

module.exports = router;
