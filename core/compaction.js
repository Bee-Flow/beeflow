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

    // Split into old (to summarize) and recent (to keep verbatim)
    const oldMessages = convMessages.slice(0, convMessages.length - RECENT_WINDOW);
    const recentMessages = convMessages.slice(convMessages.length - RECENT_WINDOW);

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

    // Generate summary of old messages (incorporates existing summary if present)
    const newSummary = await generateSummary(oldMessages, options.existingSummary, options.summaryModelId, options.userOrgId);

    // Build compacted message array: system + summary-as-context + recent messages
    const compacted = [
        ...systemMessages,
    ];

    if (newSummary || hoistedImages.length > 0) {
        const summaryText = newSummary
            ? `[Conversation Summary — earlier messages have been compacted]\n${newSummary}`
            : '[Earlier messages have been compacted. Images from those turns are still attached below.]';

        // Attach hoisted images onto the summary user message so the model sees
        // them as context belonging to the summarised history.
        const summaryContent = hoistedImages.length > 0
            ? [{ type: 'text', text: summaryText }, ...hoistedImages]
            : summaryText;

        compacted.push({ role: 'user', content: summaryContent });
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
 * Generate a summary of conversation messages using the fast tier model.
 */
async function generateSummary(oldMessages, existingSummary, summaryModelId, userOrgId = null) {
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

    try {
        const result = await llmClient.chat(modelId, [
            {
                role: 'system',
                content: 'You are a conversation summarizer. Produce a concise summary of the conversation below. Include: key topics discussed, important decisions or conclusions, specific file/code/data references, and any pending tasks or questions. Keep it under 200 words. Output only the summary, no preamble.',
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

module.exports = { compactMessages, COMPACTION_THRESHOLD };
