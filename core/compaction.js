/**
 * Conversation Compaction — Reduce token usage by summarizing old messages.
 *
 * When a conversation exceeds COMPACTION_THRESHOLD messages, older messages
 * are summarized using the fast tier model, and only a summary + the last
 * RECENT_WINDOW messages are sent to the LLM.
 *
 * Also prunes long tool results in the recent window to save tokens.
 */

const COMPACTION_THRESHOLD = 10;  // Start compacting after this many messages
const RECENT_WINDOW = 6;         // Keep this many recent messages verbatim
const TOOL_RESULT_MAX_LEN = 500; // Truncate tool results beyond this in recent window
// Per-file cap when carrying extracted text forward into the summary block.
// Smaller than the live-replay cap (30k) because we may carry several files,
// and the older they are the less likely the user is asking for verbatim
// details from them. Anything larger gets head-truncated with a marker.
const SUMMARY_FILE_TEXT_MAX_CHARS = 8_000;

// Unpaired UTF-16 high (D800-DBFF) or low (DC00-DFFF) surrogate. JSON parsers
// downstream of HTTP (notably Anthropic's) reject these, breaking the entire
// compaction call. Strip rather than escape so the summarizer still runs.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function stripLoneSurrogates(s) {
    if (typeof s !== 'string' || !s) return s;
    return s.replace(LONE_SURROGATE_RE, '�');
}

/**
 * Compact a message array for efficient LLM consumption.
 *
 * @param {Array} messages - Full message array (system + user/assistant/tool messages)
 * @param {object} options
 * @param {string} options.existingSummary - Previous compaction summary (from meta_json)
 * @param {string} options.summaryModelId - Model to use for summary generation (tier:fast)
 * @param {string|null} options.userOrgId - Org ID for EU-mode tier overrides
 * @returns {Promise<{ messages: Array, newSummary: string|null }>}
 */
async function compactMessages(messages, options = {}) {
    // Separate system message(s) from conversation messages
    const systemMessages = messages.filter(m => m.role === 'system');
    const convMessages = messages.filter(m => m.role !== 'system');

    // Not enough messages to compact
    if (convMessages.length <= COMPACTION_THRESHOLD) {
        return { messages: [...systemMessages, ...pruneToolResults(convMessages)], newSummary: null };
    }

    // Split into old (to summarize) and recent (to keep verbatim).
    // The naive boundary `length - RECENT_WINDOW` can land directly on an
    // orphan `tool` message — its matching assistant(tool_use) is the last
    // message in `old`, which gets collapsed into the summary. Anthropic
    // then rejects the request with "unexpected tool_use_id found in
    // tool_result blocks". Walk the boundary forward past every leading
    // tool message so the recent window always starts on a normal turn.
    // (An assistant(tool_use) at the boundary IS fine — its results follow
    // in the recent window.)
    let boundary = convMessages.length - RECENT_WINDOW;
    while (boundary < convMessages.length && convMessages[boundary].role === 'tool') {
        boundary++;
    }
    const oldMessages = convMessages.slice(0, boundary);
    const recentMessages = convMessages.slice(boundary);

    // Hoist any image_url blocks from the summarised window so visual context
    // isn't lost when their text gets collapsed into a summary. Deduped by URL
    // so the same image uploaded once isn't repeated N times.
    const hoistedImages = [];
    const seenUrls = new Set();
    for (const msg of oldMessages) {
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
            if (part?.type !== 'image_url') continue;
            const url = part.image_url?.url;
            if (!url || seenUrls.has(url)) continue;
            seenUrls.add(url);
            hoistedImages.push({ type: 'image_url', image_url: { url, detail: part.image_url.detail || 'auto' } });
        }
    }

    // Hoist unique attachment sidecars from old messages so file context
    // survives compaction. Without this, a PDF uploaded on turn 2 would be
    // visible to the model up to turn 10 (via the historyHydrator extractedText
    // re-injection) and then disappear once compaction folds turn 2 into the
    // summary. We keep per-file extracted text on the summary message itself.
    const hoistedAttachments = collectUniqueAttachments(oldMessages);

    // Generate summary of old messages (incorporates existing summary if present)
    const newSummary = await generateSummary(oldMessages, options.existingSummary, options.summaryModelId, options.userOrgId, hoistedAttachments);

    // Build compacted message array: system + summary-as-context + recent messages
    const compacted = [
        ...systemMessages,
    ];

    if (newSummary || hoistedImages.length > 0 || hoistedAttachments.length > 0) {
        const summaryText = newSummary
            ? `[Conversation Summary — earlier messages have been compacted]\n${newSummary}`
            : '[Earlier messages have been compacted. Files and images from those turns are still attached below.]';

        // Build the summary content: narrative + extracted text per hoisted
        // file (so the model can still answer detail questions about earlier
        // attachments) + the actual image_url blocks for hoisted images.
        const fileBlocks = hoistedAttachments
            .map(att => {
                const raw = typeof att.extractedText === 'string' ? att.extractedText : '';
                if (!raw) return null;
                if (raw.length <= SUMMARY_FILE_TEXT_MAX_CHARS) {
                    return { type: 'text', text: raw };
                }
                const head = raw.slice(0, SUMMARY_FILE_TEXT_MAX_CHARS - 200);
                const ref = att.storageKey ? ` storageKey=${att.storageKey}` : '';
                return {
                    type: 'text',
                    text: `${head}\n\n[…${att.name || 'file'} truncated for summary; full text available on demand${ref}]`,
                };
            })
            .filter(Boolean);

        const hasMultimodalParts = hoistedImages.length > 0 || fileBlocks.length > 0;
        const summaryContent = hasMultimodalParts
            ? [{ type: 'text', text: summaryText }, ...fileBlocks, ...hoistedImages]
            : summaryText;

        // Carry the sidecar forward too, so any future hydration pass (e.g. on
        // a retry) can still see which files this summary represents.
        const summaryMsg = { role: 'user', content: summaryContent };
        if (hoistedAttachments.length > 0) {
            summaryMsg.attachments = hoistedAttachments.map(({ extractedText, ...rest }) => rest);
        }
        compacted.push(summaryMsg);
        compacted.push({
            role: 'assistant',
            content: 'Understood, I have the context from our earlier conversation. Let\'s continue.',
        });
    }

    compacted.push(...pruneToolResults(recentMessages));

    console.log(`[Compaction] Compacted ${convMessages.length} messages → summary + ${recentMessages.length} recent`);

    return { messages: compacted, newSummary };
}

/**
 * Collect unique attachment sidecars across an array of messages.
 * Dedupe key prefers storageKey, falls back to url, finally name+type.
 */
function collectUniqueAttachments(messages) {
    const seen = new Set();
    const out = [];
    for (const msg of messages) {
        if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) continue;
        for (const att of msg.attachments) {
            const key = att.storageKey || att.url || `${att.name || ''}::${att.type || ''}`;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(att);
        }
    }
    return out;
}

/**
 * Generate a summary of conversation messages using the fast tier model.
 *
 * If hoistedAttachments are provided, the summarizer is given a separate
 * inventory block and instructed to preserve those file references verbatim.
 * The narrative stays under 200 words; the inventory is rendered alongside.
 */
async function generateSummary(oldMessages, existingSummary, summaryModelId, userOrgId = null, hoistedAttachments = []) {
    const llmClient = require('./llmClient');

    // Build the content to summarize
    let contentToSummarize = '';

    if (existingSummary) {
        contentToSummarize += `Previous summary:\n${existingSummary}\n\n---\n\nNew messages to incorporate:\n`;
    }

    for (const msg of oldMessages) {
        if (msg.role === 'user') {
            let text;
            if (typeof msg.content === 'string') {
                text = msg.content;
            } else if (Array.isArray(msg.content)) {
                // Multimodal content — extract text parts, note images as placeholders
                text = msg.content.map(part => {
                    if (part.type === 'text') return part.text || '';
                    if (part.type === 'image_url') return '[image]';
                    return '';
                }).filter(Boolean).join(' ');
            } else {
                text = '';
            }
            contentToSummarize += `User: ${text.substring(0, 300)}\n`;
        } else if (msg.role === 'assistant') {
            const text = typeof msg.content === 'string' ? msg.content : '';
            contentToSummarize += `Assistant: ${text.substring(0, 300)}\n`;
        } else if (msg.role === 'tool') {
            contentToSummarize += `[Tool result: ${String(msg.content).substring(0, 100)}...]\n`;
        }
    }

    if (hoistedAttachments && hoistedAttachments.length > 0) {
        const inventory = hoistedAttachments
            .map(att => `- ${att.name || 'unnamed'} (${att.type || 'unknown'})`)
            .join('\n');
        contentToSummarize += `\n---\nFiles attached during these turns (full text is preserved separately, do NOT re-summarize their contents in your narrative):\n${inventory}\n`;
    }

    // Resolve model — handle tier: prefix (EU-aware)
    let modelId = summaryModelId || 'tier:fast';
    if (modelId.startsWith('tier:')) {
        try {
            const { resolveModelForTierName } = require('./modelResolver');
            const tierName = modelId.substring(5);
            modelId = await resolveModelForTierName(tierName, { userOrgId, fallback: 'gemini-2.0-flash-lite' });
        } catch (e) {
            modelId = 'gemini-2.0-flash-lite';
        }
    }

    // Strip lone UTF-16 surrogates. Some upstream content (mangled paste,
    // truncated emoji, broken decoder) leaves unpaired D800-DBFF / DC00-DFFF
    // codepoints which Anthropic's JSON parser rejects with
    //   "no low surrogate in string: line 1 column N"
    // and the whole compaction call fails. Replace with U+FFFD so the
    // summarizer still runs and the conversation actually shrinks.
    contentToSummarize = stripLoneSurrogates(contentToSummarize);

    try {
        const result = await llmClient.chat(modelId, [
            {
                role: 'system',
                content: 'You are a conversation summarizer. Produce a concise summary of the conversation below. Include: key topics discussed, important decisions or conclusions, specific file/code/data references named verbatim, and any pending tasks or questions. If a "Files attached during these turns" inventory is provided, mention each file by name in your narrative but do NOT attempt to summarize their contents — the full text is preserved separately. Keep the narrative under 200 words. Output only the summary, no preamble.',
            },
            { role: 'user', content: contentToSummarize },
        ], { maxTokens: 300, temperature: 0.2 });

        const summary = result.content?.trim();
        if (summary) {
            console.log(`[Compaction] Generated summary (${summary.length} chars) using ${modelId}`);
            return summary;
        }
    } catch (err) {
        console.error('[Compaction] Summary generation failed:', err.message);
    }

    // Fallback: simple truncation-based summary
    return existingSummary || null;
}

/**
 * Prune long tool results in a message array to reduce token count.
 * Only truncates tool result messages, leaves user/assistant intact.
 */
function pruneToolResults(messages) {
    return messages.map(msg => {
        if (msg.role !== 'tool') return msg;

        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

        if (content.length <= TOOL_RESULT_MAX_LEN * 2) return msg;

        // Truncate to max length, keeping start and end for context
        const truncated = content.substring(0, TOOL_RESULT_MAX_LEN)
            + '\n...[truncated]...\n'
            + content.substring(content.length - 200);

        return { ...msg, content: truncated };
    });
}

module.exports = { compactMessages, COMPACTION_THRESHOLD, collectUniqueAttachments };
