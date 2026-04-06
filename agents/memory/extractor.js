/**
 * Memory Extractor - Extracts memorable information from conversations
 * Uses LLM to identify facts, preferences, and instructions worth remembering
 */

const memoryStore = require('../../stores/memoryStore');
const agentStore = require('../../stores/agentStore');
const { resolveModelWithGlobalFallback } = require('../../core/modelResolver');

// Extraction prompt is managed via the system agent (stored in DB)

// JSON Schema for structured output (OpenAI-compatible)
const MEMORY_SCHEMA = {
    type: "json_schema",
    json_schema: {
        name: "memory_extraction",
        strict: true,
        schema: {
            type: "object",
            properties: {
                memories: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            type: { type: "string", enum: ["fact", "preference", "instruction"] },
                            content: { type: "string", description: "Full readable sentence" },
                            subject: { type: "string", enum: ["user", "project", "agent"] },
                            attribute: { type: "string", description: "The property being defined" },
                            value: { type: "string", description: "Canonical value" },
                            evidence_quote: { type: "string", description: "Exact quote from user message" },
                            confidence: { type: "number", minimum: 0.8, maximum: 1.0 }
                        },
                        required: ["type", "content", "evidence_quote", "confidence"],
                        additionalProperties: false
                    }
                }
            },
            required: ["memories"],
            additionalProperties: false
        }
    }
};

/**
 * Verify that evidence_quote exists in source text
 */
function verifyEvidence(memory, sourceText) {
    if (!memory.evidence_quote || memory.evidence_quote.length < 3) return false;
    // Normalize for matching (handle whitespace differences)
    const normalized = sourceText.toLowerCase().replace(/\s+/g, ' ').trim();
    const quote = memory.evidence_quote.toLowerCase().replace(/\s+/g, ' ').trim();
    return normalized.includes(quote);
}


/**
 * Extract memories from conversation messages
 * @param {string} userId - User ID
 * @param {string} agentId - Agent ID (or null for global)
 * @param {Array} messages - Array of {role, content} messages
 * @param {string} conversationId - Conversation ID for source tracking
 * @param {string} projectId - Optional project ID for scoping memory
 * @param {string} userOrgId - Optional org ID for EU-mode model overrides
 */
async function extractFromConversation(userId, agentId, messages, conversationId = null, projectId = null, userOrgId = null) {

    // Only analyze the LATEST user message (not last 5 - prevents blending)
    const userMessages = messages.filter(m => m.role === 'user').slice(-1);

    if (userMessages.length === 0) {
        console.log('[MemoryExtractor] No user messages to analyze');
        return [];
    }

    // Get the single latest message content
    let userText = userMessages[0].content;

    // Handle multimodal messages
    if (Array.isArray(userText)) {
        const textBlock = userText.find(b => b.type === 'text');
        userText = textBlock ? textBlock.text : '';
    }



    if (!userText || userText.length < 10) {
        console.log('[MemoryExtractor] Message too short to analyze');
        return [];
    }

    try {
        // Fetch System Agent for config
        const extractorAgent = await agentStore.getSystemAgent('system-memory-extractor');
        const systemPrompt = extractorAgent?.system_prompt || 'Extract user memories.';

        // Resolve model via centralized resolver
        const extractionModel = await resolveModelWithGlobalFallback(extractorAgent?.model, { userOrgId, userId, fallbackTier: 'fast' });

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Extract memories from this user message:\n\n"${userText}"` }
        ];

        let responseFormat;
        try {
            responseFormat = MEMORY_SCHEMA;
        } catch (e) {
            // Fallback: provider doesn't support response_format
        }

        const llmClient = require('../../core/llmClient');
        const result = await llmClient.chat(extractionModel, messages, {
            maxTokens: 2500,
            temperature: 0.2,
            responseFormat: responseFormat
        });
        const content = result.content;



        // Parse JSON from response
        const memories = parseMemoryResponse(content);


        if (memories.length === 0) {
            console.log('[MemoryExtractor] No memories extracted');
            return [];
        }

        // Store each extracted memory with evidence verification
        const created = [];
        for (const memory of memories) {
            // VERIFY EVIDENCE: The quote must exist in the source text
            if (!verifyEvidence(memory, userText)) {
                console.log(`[MemoryExtractor] Evidence verification failed: "${memory.evidence_quote?.slice(0, 30)}..."`);
                continue;
            }

            // Check for existing memory with same (subject, attribute) key
            const existing = memory.subject && memory.attribute
                ? await memoryStore.findByKey(userId, memory.type, memory.subject, memory.attribute, projectId)
                : await memoryStore.findSimilarMemory(userId, memory.content, projectId);

            if (existing) {
                // Upsert: update if value changed, or bump confidence if same
                if (existing.value !== memory.value) {
                    console.log(`[MemoryExtractor] Updating memory: ${memory.subject}.${memory.attribute} = ${memory.value}`);
                    await memoryStore.updateMemoryValue(existing.id, memory.value, memory.content, memory.evidence_quote);
                } else {
                    console.log(`[MemoryExtractor] Confirming existing memory: "${memory.content.slice(0, 40)}..."`);
                    await memoryStore.confirmMemory(existing.id);
                }
                continue;
            }

            // Create new memory with evidence
            // ── Isolation guard ──────────────────────────────────────────────────
            // Memories with subject='project' belong only inside a project context.
            // If there is no projectId, skip them to avoid polluting global memory.
            if (memory.subject === 'project' && !projectId) {
                console.log(`[MemoryExtractor] Skipping project-subject memory in user-global scope: "${memory.content?.slice(0, 50)}..."`);
                continue;
            }
            const id = await memoryStore.createMemory(
                userId,
                null,  // agentId null = global memory
                memory.type,
                memory.content,
                null,
                memory.confidence || 0.8,
                memory.subject,
                memory.attribute,
                memory.value,
                memory.evidence_quote,
                projectId
            );

            // Link to source conversation
            if (conversationId && id) {
                let sourceMessage = userMessages[userMessages.length - 1]?.content;

                // Handle array content (multimodal messages)
                if (Array.isArray(sourceMessage)) {
                    const textBlock = sourceMessage.find(b => b.type === 'text');
                    sourceMessage = textBlock ? textBlock.text : '[Media Message]';
                }

                if (sourceMessage && typeof sourceMessage === 'string') {
                    try {
                        await memoryStore.addMemorySource(id, conversationId, sourceMessage);
                    } catch (err) {
                        console.error('[MemoryExtractor] Failed to link source:', err.message);
                    }
                }
            }

            created.push({ id, ...memory });
        }

        console.log(`[MemoryExtractor] Created ${created.length} memories`);
        return created;

    } catch (error) {
        console.error('[MemoryExtractor] Extraction failed:', error);
        return [];
    }
}

/**
 * Parse the LLM response to extract memory objects
 * Handles both {memories: [...]} and [...] formats
 */
function parseMemoryResponse(content) {
    try {
        // Clean content
        let cleanContent = content.trim();

        // Try to parse as JSON first (structured output)
        let parsed;
        try {
            parsed = JSON.parse(cleanContent);
        } catch (e) {
            // Fallback: try to find JSON in response
            const objectMatch = cleanContent.match(/\{[\s\S]*"memories"[\s\S]*\}/);
            const arrayMatch = cleanContent.match(/\[[\s\S]*\]/);

            if (objectMatch) {
                parsed = JSON.parse(objectMatch[0]);
            } else if (arrayMatch) {
                parsed = JSON.parse(arrayMatch[0]);
            } else {
                return [];
            }
        }

        // Handle both {memories: [...]} and [...] formats
        let memories = Array.isArray(parsed) ? parsed : (parsed.memories || []);

        if (!Array.isArray(memories)) {
            return [];
        }


        // Validate and filter memories
        return memories.filter(m => {
            // Basic validation
            if (!m.type || !m.content || typeof m.content !== 'string') return false;
            if (m.content.length < 5 || m.content.length > 500) return false;

            // Confidence threshold - only keep high confidence
            if ((m.confidence || 0) < 0.8) return false;

            // Filter out task-like content (secondary filter in case LLM misses)
            const taskVerbs = /^(the user wants to|user wants|create|write|fix|build|make|generate|show|explain|help|add|remove|update|delete|edit|modify|change|set|get|fetch|load|save|open|close|run|execute|deploy|test|debug|refactor)/i;
            if (taskVerbs.test(m.content.trim())) {
                console.log(`[MemoryExtractor] Filtered task-like content: "${m.content.slice(0, 40)}..."`);

                return false;
            }

            // Filter out questions
            if (m.content.trim().endsWith('?')) return false;

            return true;
        }).map(m => ({
            type: m.type,
            content: m.content.trim(),
            subject: m.subject ? m.subject.toLowerCase().trim() : null,
            attribute: m.attribute ? m.attribute.toLowerCase().trim() : null,
            value: m.value ? m.value.trim() : null,
            evidence_quote: m.evidence_quote ? m.evidence_quote.trim() : null,
            confidence: Math.min(1, Math.max(0.8, m.confidence || 0.8)),
            importance: Math.min(1, Math.max(0.5, m.importance || 0.7))
        }));

    } catch (error) {
        console.error('[MemoryExtractor] Failed to parse response:', error);
        return [];
    }
}

/**
 * Manually save a memory (user explicitly asked to remember something)
 */
function saveExplicitMemory(userId, agentId, content, type = 'fact') {
    // Check for duplicates first
    const existing = memoryStore.findSimilarMemory(userId, content);
    if (existing) {
        // Update existing memory
        memoryStore.updateMemory(existing.id, content);
        return existing.id;
    }

    return memoryStore.createMemory(userId, agentId, type, content, null, 0.8);
}

module.exports = {
    extractFromConversation
};
