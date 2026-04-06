/**
 * Memory Extractor — Automatically extract structured memories from conversations.
 *
 * After each chat response, analyzes the conversation to identify:
 * - People mentioned (person)
 * - User preferences expressed (preference)
 * - Facts and information shared (fact)
 * - Project details (project)
 * - Workflow patterns (workflow)
 * - Standing instructions (instruction)
 *
 * Uses the fast tier model via LLMClient. Runs async — does not block chat responses.
 */

const memoryStore = require('../stores/memoryStore');

const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the conversation below and extract important information worth remembering about the user for future conversations.

Extract ONLY genuinely useful, persistent facts — not transient conversation details. Each memory should be something that would help personalize future interactions.

Return a JSON array of memory objects. Each object must have:
- "type": one of "person", "preference", "fact", "project", "workflow", "instruction"
- "content": a concise, self-contained statement (max 100 chars)
- "subject": the entity this is about (person name, project name, etc.) or null
- "attribute": what aspect (role, preference, stack, etc.) or null
- "value": the specific value or null
- "importance": 0.0-1.0 (how important to remember)

Type guidelines:
- "person": People the user mentions (colleagues, friends, family). Subject = person name.
- "preference": User's stated preferences (language, tools, style). Subject = category.
- "fact": Concrete facts about the user or their work.
- "project": Project names, tech stacks, URLs, deployment details. Subject = project name.
- "workflow": How the user likes to work (processes, habits). 
- "instruction": Explicit requests like "always do X" or "never do Y".

Rules:
- ALWAYS write memories in English, regardless of conversation language
- NEVER create duplicate memories. Each piece of information = exactly ONE memory
- Do NOT extract information the AI mentioned from its own memory context — only extract NEW information from the user
- Use the MOST SPECIFIC type. If info is about a person → "person" (not "fact"). If about a project → "project" (not "fact"). "fact" is only for info that doesn't fit a more specific type
- Only extract information explicitly stated or strongly implied by the USER (not the assistant)
- Skip trivial/temporary information (e.g., "the user asked about X")
- If nothing worth remembering, return an empty array []
- Maximum 5 memories per extraction. Prefer fewer, higher-quality memories
- Content must be a complete, standalone statement

Respond with ONLY the JSON array, no other text.`;

/**
 * Extract memories from a user message + assistant response.
 * Runs async — caller should fire-and-forget.
 *
 * @param {string} userId
 * @param {string} userMessage
 * @param {string} assistantResponse
 * @param {string} agentId - Optional agent ID for agent-specific memories
 * @param {string} projectId - Optional project ID for project-scoped memories
 * @param {string|null} userOrgId - Optional org ID for EU-mode tier overrides
 */
async function extractMemories(userId, userMessage, assistantResponse, agentId = null, projectId = null, userOrgId = null) {
    const llmClient = require('./llmClient');

    // Skip short/trivial messages
    if (!userMessage || userMessage.length < 20) return;
    if (!assistantResponse || assistantResponse.length < 20) return;

    // Resolve tier:fast → actual model ID (EU-aware)
    let modelId;
    try {
        const { resolveModelForTierName } = require('./modelResolver');
        modelId = await resolveModelForTierName('fast', { userOrgId, fallback: 'gemini-2.0-flash-lite' });
    } catch (e) {
        modelId = 'gemini-2.0-flash-lite';
    }

    // Truncate to avoid sending too much context (expand limit for detailed memories)
    const truncatedUser = userMessage.substring(0, 20000);
    const truncatedAssistant = assistantResponse.substring(0, 20000);

    try {
        const result = await llmClient.chat(modelId, [
            { role: 'system', content: EXTRACTION_PROMPT },
            {
                role: 'user',
                content: `User message:\n${truncatedUser}\n\nAssistant response:\n${truncatedAssistant}`,
            },
        ], { maxTokens: 2500, temperature: 0.1 });

        const raw = result.content?.trim();
        if (!raw || raw === '[]') return;

        // Parse JSON — handle markdown code fences
        let cleaned = raw;
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }

        let memories;
        try {
            memories = JSON.parse(cleaned);
        } catch (e) {
            // Try to repair truncated JSON (model ran out of tokens mid-array)
            try {
                // Find the last complete object by looking for the last "},"  or "}" before truncation
                const lastComplete = cleaned.lastIndexOf('}');
                if (lastComplete > 0) {
                    let repaired = cleaned.substring(0, lastComplete + 1);
                    if (!repaired.endsWith(']')) repaired += ']';
                    if (!repaired.startsWith('[')) repaired = '[' + repaired;
                    memories = JSON.parse(repaired);
                }
            } catch {
                // Give up
            }
            if (!memories) {
                console.warn('[MemoryExtractor] Failed to parse JSON:', cleaned.substring(0, 1000));
                return;
            }
        }

        if (!Array.isArray(memories) || memories.length === 0) return;

        // Store each extracted memory
        let stored = 0;
        for (const mem of memories.slice(0, 5)) {
            if (!mem.type || !mem.content) continue;

            // Validate type
            const validTypes = ['person', 'preference', 'fact', 'project', 'workflow', 'instruction', 'context'];
            if (!validTypes.includes(mem.type)) continue;

            // ── Isolation guard: project-type memories MUST have a project context ──
            // Prevents project-specific info (frameworks, URLs, deadlines) from
            // leaking into the user's global memory when chatting outside a project.
            if (mem.type === 'project' && !projectId) {
                console.log(`[MemoryExtractor] Skipping project-type memory in user-global scope: "${mem.content.slice(0, 50)}..."`);
                continue;
            }

            // Check for duplicates
            const existing = await memoryStore.findSimilarMemory(userId, mem.content, projectId);
            if (existing) {
                await memoryStore.confirmMemory(existing.id);
                continue;
            }

            await memoryStore.createMemory(
                userId,
                agentId,
                mem.type,
                mem.content,
                null,                          // summary
                mem.importance || 0.5,
                mem.subject || null,
                mem.attribute || null,
                mem.value || null,
                null,                          // evidenceQuote
                projectId
            );
            stored++;
        }

        if (stored > 0) {
            console.log(`[MemoryExtractor] Stored ${stored} new memories for user ${userId}`);
        }
    } catch (err) {
        console.warn('[MemoryExtractor] Extraction failed:', err.message);
    }
}

module.exports = { extractMemories };
