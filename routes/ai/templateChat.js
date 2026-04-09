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
const { getServiceHeaders } = require('../../core/serviceAuth');
const guardrailEventStore = require('../../stores/guardrailEventStore');

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

    // Resolve user's org for EU-mode tier overrides
    const { resolveModelForTier, getTierConfig } = require('../../core/modelResolver');
    const { resolveUserOrgIds } = require('../../auth');
    let userOrgId = null;
    try {
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds && orgIds.size > 0) {
            userOrgId = Array.from(orgIds)[0];
        }
        if (!userOrgId) {
            const userStore = require('../../stores/userStore');
            const dbUser = await userStore.getUser(userId);
            if (dbUser?.organizationId) {
                userOrgId = dbUser.organizationId;
            } else {
                const groups = Array.isArray(dbUser?.groups) ? dbUser.groups : (() => { try { return JSON.parse(dbUser?.groups || '[]'); } catch (_) { return []; } })();
                if (groups.length > 0) {
                    const allGroups = await userStore.getAllGroups();
                    for (const gid of groups) {
                        const g = allGroups.find(gr => gr.id === gid);
                        if (g?.organizationId) { userOrgId = g.organizationId; break; }
                    }
                }
            }
        }
    } catch (_) {}

    // Resolve model from tier config (EU-aware)
    let resolvedTier = modelTier || 'fast';
    const tierConfig = await getTierConfig(resolvedTier, { userOrgId, userId });
    let modelId = await resolveModelForTier(`tier:${resolvedTier}`, { userOrgId, userId, fallbackTier: 'fast' });

    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model || 'mistral-small-latest';
    }

    let orgShield = null;
    if (userOrgId) {
        orgShield = await configStore.getConfig(`org_privacy_shield_${userOrgId}`);
        if (orgShield?.euModeEnabled) {
            console.log(`[TemplateChat] EU mode active for org ${userOrgId}`);
        }
    }

    // Resolve provider
    let config;
    let adapter;

    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        console.error(`[TemplateChat] Provider resolution failed for model "${modelId}":`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

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
                const { quickKBSearch } = require('../../core/agentRuntime/knowledgeSearch');
                const kbResults = await quickKBSearch(userId, kbIds, message, { topK: 6 });

                if (kbResults.length > 0) {
                    const kbText = kbResults.map((c, i) => {
                        const src = c.source_uri || c.title || 'KB';
                        return `### Source ${i + 1}: ${src}\n${c.content}`;
                    }).join('\n\n');
                    kbContext = `\n\n[TEMPLATE KNOWLEDGE BASE]\nRelevant information from the template's knowledge base:\n${kbText}`;
                    console.log(`[TemplateChat] Injected ${kbResults.length} KB chunks for template "${template.name}"`);
                }
            } catch (kbErr) {
                console.warn('[TemplateChat] KB search failed:', kbErr.message);
            }
        }

        // Build system prompt
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const systemPrompt = `You are a helpful AI assistant specialized in filling Word document templates. Today is ${today}.${templateContext}${instructionsContext}${kbContext}${meetingContext}\nNow: ${(() => { const _tz = timezone || 'Europe/Amsterdam'; try { const _now = new Date(); const _dp = _now.toLocaleString('sv-SE', { timeZone: _tz }); const _lp = new Date(_now.toLocaleString('en-US', { timeZone: _tz })); const _om = Math.round((_lp - _now) / 60000); const _s = _om >= 0 ? '+' : '-'; const _a = Math.abs(_om); return `${_dp} UTC${_s}${String(Math.floor(_a/60)).padStart(2,'0')}:${String(_a%60).padStart(2,'0')} (${_tz})`; } catch(_) { return new Date().toISOString(); } })()}`;

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

        // ─── PII Detection on Input ──────────────────────────────
        // Scans user input for PII using org shield settings.
        // Respects scope.userInput — admin can disable input scanning.
        let piiTokenMap = null;
        const inputPiiScope = orgShield?.scope?.userInput !== false;
        try {
            const { validateInputForPii } = require('../../core/azurePiiDetection');
            const orgPiiEnabled = !!(orgShield?.enabled && orgShield?.azurePiiEnabled && inputPiiScope);
            const piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled);

            if (piiResult && piiResult.tokenizedText) {
                // Tokenize mode: replace last user message with tokenized version
                const lastIdx = messages.length - 1;
                if (messages[lastIdx]?.role === 'user') {
                    if (typeof messages[lastIdx].content === 'string') {
                        messages[lastIdx] = { role: 'user', content: piiResult.tokenizedText };
                    } else if (Array.isArray(messages[lastIdx].content)) {
                        const textBlock = messages[lastIdx].content.find(b => b.type === 'text');
                        if (textBlock) textBlock.text = piiResult.tokenizedText;
                    }
                }
                piiTokenMap = piiResult.tokenMap;
                console.warn(`[TemplateChat] 🔒 PII tokenized (${Object.keys(piiTokenMap).length} tokens)`);
            }
        } catch (piiError) {
            if (piiError.piiEntities) {
                const categoryList = [...new Set(piiError.piiEntities.map(e => e.label))].join(', ');
                console.warn(`[TemplateChat] 🚫 PII blocked | ${categoryList}`);

                guardrailEventStore.logGuardrailEvent({
                    organization_id: userOrgId || null,
                    user_id: userId,
                    conversation_id: conversationId || null,
                    violation_type: 'pii',
                    violation_categories: categoryList,
                    direction: 'input',
                    action_taken: 'blocked',
                    source: 'template',
                    model: modelId || null,
                }).catch(() => {});

                send('error', { error: `Your message contains sensitive personal information (${categoryList}). Please remove PII before sending.` });
                res.end();
                return;
            }
        }

        // Stream response
        const tierSettings = tiers[resolvedTier] || {};
        const { TIER_DEFAULTS } = require('../../core/modelResolver');
        const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
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

        // ─── Restore PII tokens ─────────────────────────────────
        if (piiTokenMap && Object.keys(piiTokenMap).length > 0) {
            const { restoreTokens } = require('../../core/azurePiiDetection');
            const restored = restoreTokens(fullContent, piiTokenMap);
            if (restored !== fullContent) {
                send('content_replace', { text: restored });
                fullContent = restored;
                console.log(`[TemplateChat] 🔓 PII tokens restored in output`);
            }
        }

        // ─── PII Detection on AI Output ─────────────────────────
        // Scans the final AI response for PII using org shield settings.
        // Runs AFTER token restoration so restored real values are also scanned.
        // Respects scope.agentOutput — admin can disable output scanning.
        const outputPiiScope = orgShield?.scope?.agentOutput !== false;
        if (fullContent && orgShield?.enabled && orgShield?.azurePiiEnabled && outputPiiScope) {
            try {
                const { validateOutputForPii } = require('../../core/azurePiiDetection');
                await validateOutputForPii(fullContent, {
                    enabledCategories: orgShield.piiDetectionCategories,
                    confidenceThreshold: orgShield.piiDetectionConfidenceThreshold,
                    piiEnabled: true,
                });
                console.log('[TemplateChat] ✅ PII output scan passed');
            } catch (piiOutError) {
                if (piiOutError.piiEntities) {
                    const categoryList = [...new Set(piiOutError.piiEntities.map(e => e.label))].join(', ');
                    console.warn(`[TemplateChat] 🚫 PII in AI output | ${categoryList}`);

                    if (orgShield.action === 'redact') {
                        let redacted = fullContent;
                        const sorted = [...piiOutError.piiEntities].sort((a, b) => b.offset - a.offset);
                        for (const e of sorted) {
                            if (e.offset >= 0 && e.length > 0) {
                                redacted = redacted.slice(0, e.offset) + `[REDACTED: ${e.label}]` + redacted.slice(e.offset + e.length);
                            }
                        }
                        send('content_replace', { text: redacted });
                        fullContent = redacted;
                    } else {
                        const msg = `⚠️ This response was blocked because it contained sensitive personal information (${categoryList}).`;
                        send('content_replace', { text: msg });
                        fullContent = msg;
                    }

                    guardrailEventStore.logGuardrailEvent({
                        organization_id: userOrgId || null,
                        user_id: userId,
                        conversation_id: conversationId || null,
                        violation_type: 'pii',
                        violation_categories: categoryList,
                        direction: 'output',
                        action_taken: orgShield.action === 'redact' ? 'redacted' : 'blocked',
                        source: 'template',
                        model: modelId || null,
                    }).catch(() => {});
                }
            }
        }

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
