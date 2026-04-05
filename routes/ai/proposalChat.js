/**
 * Proposal Chat — AI chat with proposal block editing tools
 * 
 * Tools available:
 * - proposal_block_update: Update a specific block's content
 * - proposal_blocks_fill: Fill ALL empty blocks from context/instructions
 * - agent_search: Web research
 */

const express = require('express');
const router = express.Router();
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const notebookStore = require('../../stores/notebookStore');
const { AGENT_SEARCH_TOOLS, executeAgentSearchTool, isAgentSearchTool } = require('../../integrations/agentSearchTools');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ── Proposal Block Tools ──────────────────────────────────────────

const PROPOSAL_BLOCK_UPDATE_TOOL = {
    type: 'function',
    function: {
        name: 'proposal_block_update',
        description: 'Update the content of a specific block in the proposal. Use this to fill, edit, or improve block content. Returns the updated block.',
        parameters: {
            type: 'object',
            properties: {
                blockId: {
                    type: 'string',
                    description: 'The ID of the block to update (from the blocks list)',
                },
                updates: {
                    type: 'object',
                    description: 'An object with the fields to update. Keys must match block data fields (e.g. title, subtitle, body, items, rows, companyName, etc.). Only include fields you want to change — other fields remain unchanged.',
                },
            },
            required: ['blockId', 'updates'],
        },
    },
};

const PROPOSAL_BLOCKS_FILL_TOOL = {
    type: 'function',
    function: {
        name: 'proposal_blocks_fill',
        description: 'Fill ALL proposal blocks at once with generated content. Returns the complete updated blocks array. Use this when the user asks to "fill the template", "generate the proposal", or "vul de offerte". You must provide a complete array of updated block objects.',
        parameters: {
            type: 'object',
            properties: {
                blocks: {
                    type: 'array',
                    description: 'The complete array of block objects with updated content. Each block must include its original id and type, plus the updated data fields.',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'The original block ID' },
                            type: { type: 'string', description: 'The block type (cover, specs, text, pricing, icon-section, timeline, signature)' },
                            data: { type: 'object', description: 'The block data with all fields filled in' },
                        },
                        required: ['id', 'type', 'data'],
                    },
                },
            },
            required: ['blocks'],
        },
    },
};

const PROPOSAL_TOOLS = [PROPOSAL_BLOCK_UPDATE_TOOL, PROPOSAL_BLOCKS_FILL_TOOL];

function executeProposalTool(toolName, toolArgs, currentBlocks) {
    if (toolName === 'proposal_block_update') {
        const { blockId, updates } = toolArgs;
        if (!blockId || !updates) return { error: 'blockId and updates are required' };
        
        const blockIndex = currentBlocks.findIndex(b => b.id === blockId);
        if (blockIndex === -1) return { error: `Block with id "${blockId}" not found` };
        
        const block = currentBlocks[blockIndex];
        let updatedBlock;
        
        // Timeline blocks store data in block.data, other blocks at root level
        if (block.type === 'timeline') {
            updatedBlock = { ...block, data: { ...(block.data || {}), ...updates } };
        } else {
            // Merge at root level for cover, specs, text, pricing, icon-section, signature
            updatedBlock = { ...block, ...updates };
        }
        
        const updatedBlocks = [...currentBlocks];
        updatedBlocks[blockIndex] = updatedBlock;
        
        return {
            _action: 'proposal_blocks_update',
            blocks: updatedBlocks,
            message: `Block "${blockId}" (${updatedBlock.type}) updated successfully.`,
        };
    }
    
    if (toolName === 'proposal_blocks_fill') {
        const { blocks } = toolArgs;
        if (!blocks || !Array.isArray(blocks)) return { error: 'blocks array is required' };
        
        // Merge: keep original block IDs/types, apply data from AI
        const mergedBlocks = currentBlocks.map(originalBlock => {
            const aiBlock = blocks.find(b => b.id === originalBlock.id);
            if (!aiBlock) return originalBlock;
            
            const aiData = aiBlock.data || aiBlock;
            
            if (originalBlock.type === 'timeline') {
                return { ...originalBlock, data: { ...(originalBlock.data || {}), ...aiData } };
            } else {
                // Spread AI data directly onto the block (excluding id, type which stay original)
                const { id: _id, type: _type, data: nestedData, ...rootFields } = aiData;
                return { ...originalBlock, ...rootFields, ...(nestedData || {}) };
            }
        });
        
        return {
            _action: 'proposal_blocks_update',
            blocks: mergedBlocks,
            message: `All ${mergedBlocks.length} blocks have been filled with generated content.`,
        };
    }
    
    return { error: `Unknown proposal tool: ${toolName}` };
}

// ── Block structure description for AI ────────────────────────────

function describeBlockSchema() {
    return `
BLOCK TYPES AND THEIR DATA FIELDS:

1. "cover" — Cover page block
   - title: string (main proposal title, e.g. "Website Redesign Voorstel")
   - subtitle: string (subtitle, e.g. "Opgesteld voor Bedrijf X")
   - date: string (date, e.g. "April 2026")

2. "specs" — Project specifications (key-value pairs)
   - items: array of { label: string, value: string }
   Example: [{ label: "Klant", value: "Acme BV" }, { label: "Project", value: "Website Redesign" }, { label: "Looptijd", value: "8 weken" }]

3. "text" — Rich text section
   - heading: string (section title, e.g. "Onze Aanpak")
   - body: string (the text content — can be multiple paragraphs, use \\n for line breaks)

4. "pricing" — Pricing table with auto-calculated totals
   - rows: array of { description: string, qty: number, unit: string, price: number }
   - vatRate: number (0.21 for 21% BTW)
   Example rows: [{ description: "Design & UX", qty: 40, unit: "uur", price: 95 }, { description: "Frontend Development", qty: 60, unit: "uur", price: 110 }]

5. "icon-section" — Section with an icon/emoji + text
   - icon: string (emoji, e.g. "🎯" or "✅")
   - heading: string
   - body: string

6. "signature" — Signature block (usually at the end)
   - leftTitle: string (e.g. "Namens [jouw bedrijf]")
   - leftName: string (e.g. "Jan Jansen")
   - leftRole: string (e.g. "Directeur")
   - rightTitle: string (e.g. "Namens [klant]")
   - rightName: string
   - rightRole: string

7. "timeline" — Vertical timeline / implementation plan
   - heading: string (e.g. "Implementatie programma")
   - phases: array of phase objects, each with:
     - icon: string (emoji, e.g. "📋")
     - title: string (e.g. "Fase 1 — Voorbereiding")
     - items: array of { title: string, description: string }
   Example phases: [
     { icon: "📋", title: "Voorbereiding & Verificatie", items: [{ title: "Controle vereisten", description: "Verificatie van alle benodigde resources" }] },
     { icon: "🔧", title: "Installatie & Configuratie", items: [{ title: "Setup", description: "Installatie en configuratie" }] },
     { icon: "🚀", title: "Oplevering", items: [{ title: "Go-live", description: "Testen en overdracht" }] }
   ]
`;
}

// ─── Streaming Proposal Chat ─────────────────────────────────────

router.post('/chat/proposal/stream', requireAuth, async (req, res) => {
    const { message, proposalId, history, modelTier, timezone, attachments, blocks, webSearchEnabled } = req.body;
    const userId = req.session.user.id;

    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!proposalId) return res.status(400).json({ error: 'Proposal ID required' });

    // Load proposal
    const proposal = await notebookStore.getNotebook(proposalId, userId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    // Resolve model from tier config
    let tiers = await configStore.getConfig('chat_model_tiers') || {};

    // EU mode + org privacy shield (same pattern as notebookChat)
    const { resolveUserOrgIds: resolveOrgIdsForTiers } = require('../../auth');
    const userStore = require('../../stores/userStore');
    const orgIdsForTiers = await resolveOrgIdsForTiers(req);
    let userOrgForTiers = orgIdsForTiers && orgIdsForTiers.size > 0 ? Array.from(orgIdsForTiers)[0] : null;
    if (!userOrgForTiers) {
        try {
            const dbUser = await userStore.getUser(userId);
            if (dbUser?.organizationId) {
                userOrgForTiers = dbUser.organizationId;
            } else {
                const groups = Array.isArray(dbUser?.groups) ? dbUser.groups : (() => { try { return JSON.parse(dbUser?.groups || '[]'); } catch(_) { return []; } })();
                if (groups.length > 0) {
                    const allGroups = await userStore.getAllGroups();
                    for (const gid of groups) {
                        const g = allGroups.find(gr => gr.id === gid);
                        if (g?.organizationId) { userOrgForTiers = g.organizationId; break; }
                    }
                }
            }
        } catch (_) {}
    }
    if (userOrgForTiers) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`);
        if (shield?.enabled && shield.euModeEnabled) {
            const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
            const mergedTiers = { ...tiers };
            for (const [tierName, euTier] of Object.entries(euTiers)) {
                if (euTier?.modelId) mergedTiers[tierName] = { ...mergedTiers[tierName], ...euTier };
            }
            tiers = mergedTiers;
        }
    }

    let resolvedTier = modelTier || 'fast';

    // Auto mode
    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/promptClassifier');
            const result = await classifyWithLLM(message, tiers);
            resolvedTier = result.tier;
            console.log(`[ProposalChat] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            console.log(`[ProposalChat] Auto classification failed: ${err.message}, using fast`);
            resolvedTier = 'fast';
        }
    }

    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;
    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model;
        if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}".`);
    }

    // Resolve provider
    let config;
    let adapter;
    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        console.error(`[ProposalChat] Provider resolution failed:`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

    console.log(`[ProposalChat] Model: ${modelId} (tier: ${resolvedTier}) for proposal: "${proposal.name}" (${(blocks || []).length} blocks)`);

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

    if (modelTier === 'auto') {
        send('model_selected', { tier: resolvedTier, modelId });
    }

    try {
        // Build blocks context
        const currentBlocks = blocks || [];
        const blocksJson = JSON.stringify(currentBlocks, null, 2);

        const userWantsSearch = webSearchEnabled !== false; // default true if not sent
        const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
        const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
        const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
        const searchAvailable = userWantsSearch && searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);

        const today = new Date().toLocaleDateString('nl-NL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        const systemPrompt = `Je bent een professionele offerte-assistent voor Bee Flow. Vandaag is ${today}.
Je helpt gebruikers bij het opstellen en invullen van professionele offertes (proposals).

[OFFERTE: "${proposal.name}"]
${proposal.description ? `Beschrijving: ${proposal.description}` : ''}
${proposal.instructions ? `\nInstructies: ${proposal.instructions}` : ''}

[HUIDIGE BLOKKEN]
De offerte bestaat uit bewerkbare blokken. Hier is de huidige structuur:
\`\`\`json
${blocksJson.slice(0, 12000)}
\`\`\`

${describeBlockSchema()}

[BESCHIKBARE TOOLS]
- proposal_block_update: Update één specifiek blok (gebruik blockId en updates object)
- proposal_blocks_fill: Vul ALLE blokken tegelijk in (voor wanneer de gebruiker vraagt alle content te genereren)
${searchAvailable ? `- agent_search: Zoek op het web voor actuele informatie` : ''}

INSTRUCTIES:
1. Als de gebruiker vraagt om de offerte/template te vullen: gebruik proposal_blocks_fill om alle blokken in één keer te vullen met professionele, overtuigende content.
2. Als de gebruiker vraagt om een specifieke sectie aan te passen: gebruik proposal_block_update met het juiste blockId.
3. Schrijf altijd in het Nederlands, tenzij anders gevraagd.
4. Maak de content professioneel, overtuigend en specifiek — vermijd vage, generieke teksten.
5. Bij prijzen: gebruik realistische uurtarieven en hoeveelheden passend bij het projecttype.
6. Na het updaten van blokken, geef een korte samenvatting van wat je hebt ingevuld/aangepast.
7. Als de gebruiker context geeft over het project (klant, type werk, budget), gebruik die info om de offerte relevant en specifiek te maken.
8. For specs blocks, include relevant items like: Klant, Project, Looptijd, Startdatum, Contactpersoon.
9. For pricing, always include qty (uren/stuks), unit, and realistic pricing.

TAAL: Nederlands (tenzij anders gevraagd)

Now: ${new Date().toLocaleString('sv-SE', { timeZone: timezone || 'UTC', timeZoneName: 'short' })}`;

        let messages = [{ role: 'system', content: systemPrompt }];

        // Add conversation history
        if (history && Array.isArray(history)) {
            for (const msg of history) {
                if ((msg.role === 'user' || msg.role === 'assistant') && msg.content?.trim()) {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }

        // Add current message with attachments
        if (attachments && attachments.length > 0) {
            const contentParts = [];
            if (message) contentParts.push({ type: 'text', text: message });
            for (const att of attachments) {
                try {
                    if (att.type?.startsWith('image/') && att.content) {
                        contentParts.push({ type: 'image_url', image_url: { url: att.content } });
                    } else if (att.content && typeof att.content === 'string') {
                        const text = att.content.startsWith('data:') ? Buffer.from(att.content.split(',')[1] || '', 'base64').toString('utf-8') : att.content;
                        if (text) contentParts.push({ type: 'text', text: `[File: ${att.name}]\n---\n${text.slice(0, 8000)}\n---` });
                    }
                } catch {}
            }
            const hasImages = contentParts.some(p => p.type === 'image_url');
            if (hasImages) {
                messages.push({ role: 'user', content: contentParts });
            } else {
                const combined = contentParts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
                if (combined.trim()) messages.push({ role: 'user', content: combined });
            }
        } else {
            messages.push({ role: 'user', content: message });
        }

        // ── Build tool list ──────────────────────────────────────────
        const tools = [...PROPOSAL_TOOLS];
        if (searchAvailable) tools.push(...AGENT_SEARCH_TOOLS);

        // ── Tool calling loop ────────────────────────────────────────
        const tierSettings = tiers[resolvedTier] || {};
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || 8192,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : 0.7,
        };

        let mutableBlocks = [...currentBlocks];
        let toolCallRounds = 0;
        const MAX_TOOL_ROUNDS = 5;

        while (toolCallRounds < MAX_TOOL_ROUNDS) {
            let result;
            try {
                result = await adapter.chat(apiKey, apiUrl, modelId, messages, {
                    ...chatOptions,
                    tools,
                    toolChoice: 'auto',
                });
            } catch (err) {
                console.error('[ProposalChat] Tool check error:', err.message);
                break;
            }

            if (!result.toolCalls || result.toolCalls.length === 0) break;

            messages.push({
                role: 'assistant',
                content: result.content || null,
                tool_calls: result.toolCalls,
            });
            toolCallRounds++;

            const toolResults = await Promise.all(result.toolCalls.map(async (toolCall) => {
                const toolName = toolCall.function?.name || toolCall.name;
                let toolArgs = {};
                try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) {}

                console.log(`[ProposalChat] Tool call: ${toolName}(${JSON.stringify(toolArgs).substring(0, 300)})`);
                send('thinking', { text: `Bezig met: ${toolName}...` });

                let toolResult;

                if (toolName === 'proposal_block_update' || toolName === 'proposal_blocks_fill') {
                    toolResult = executeProposalTool(toolName, toolArgs, mutableBlocks);
                    if (toolResult._action === 'proposal_blocks_update') {
                        mutableBlocks = toolResult.blocks;
                        send('proposal_blocks_update', { blocks: toolResult.blocks });
                    }
                } else if (isAgentSearchTool(toolName)) {
                    try {
                        toolResult = await executeAgentSearchTool(toolName, toolArgs);
                    } catch (err) {
                        toolResult = { error: `Search failed: ${err.message}` };
                    }
                } else {
                    toolResult = { error: `Unknown tool: ${toolName}` };
                }

                return {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                };
            }));

            messages.push(...toolResults);
        }

        // ── Stream final response ────────────────────────────────────
        let fullContent = '';
        const streamOptions = {
            ...chatOptions,
            tools: toolCallRounds === 0 ? tools : undefined,
            toolChoice: toolCallRounds === 0 ? 'auto' : undefined,
        };

        let streamToolCalls = [];
        const streamCallback = (type, data) => {
            if (type === 'text') {
                fullContent += data.text;
                send('content', { text: data.text });
            } else if (type === 'thinking') {
                send('thinking', { text: data.text });
            } else if (type === 'tool_use') {
                streamToolCalls.push({
                    id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: { name: data.name, arguments: JSON.stringify(data.input || {}) },
                });
            } else if (type === 'error') {
                send('error', data);
            }
        };

        await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);

        // Handle tool calls from streaming
        if (streamToolCalls.length > 0 && toolCallRounds < MAX_TOOL_ROUNDS) {
            messages.push({
                role: 'assistant',
                content: fullContent || null,
                tool_calls: streamToolCalls,
            });

            const streamToolResults = await Promise.all(streamToolCalls.map(async (toolCall) => {
                const toolName = toolCall.function?.name || toolCall.name;
                let toolArgs = {};
                try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) {}

                console.log(`[ProposalChat] Stream tool call: ${toolName}`);
                let toolResult;

                if (toolName === 'proposal_block_update' || toolName === 'proposal_blocks_fill') {
                    toolResult = executeProposalTool(toolName, toolArgs, mutableBlocks);
                    if (toolResult._action === 'proposal_blocks_update') {
                        mutableBlocks = toolResult.blocks;
                        send('proposal_blocks_update', { blocks: toolResult.blocks });
                    }
                } else if (isAgentSearchTool(toolName)) {
                    try { toolResult = await executeAgentSearchTool(toolName, toolArgs); }
                    catch (err) { toolResult = { error: err.message }; }
                } else {
                    toolResult = { error: `Unknown tool: ${toolName}` };
                }

                return {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                };
            }));

            messages.push(...streamToolResults);

            fullContent = '';
            await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, (type, data) => {
                if (type === 'text') { fullContent += data.text; send('content', { text: data.text }); }
                else if (type === 'thinking') { send('thinking', { text: data.text }); }
            });
        }

        send('done', {});
        res.end();

    } catch (err) {
        console.error('[ProposalChat] Error:', err);
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

module.exports = router;
