/**
 * Notebook Chat — AI chat with full tool support
 * 
 * Tools available:
 * - notebook_doc_read/write/replace: Read and modify the TipTap document editor
 * - agent_search: Web research
 * - notebook_add_source: Add web search results directly as notebook sources
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
const notebookConversationStore = require('../../stores/notebookConversationStore');
const { startSseHeartbeat } = require('../../core/sseHelpers');

const { NOTEBOOK_DOC_TOOLS, NOTEBOOK_ADD_SOURCE_TOOL, executeNotebookDocTool } = require('../../integrations/notebookDocTools');
const { htmlToMarkdown } = require('../../core/markdown');
const { AGENT_SEARCH_TOOLS, executeAgentSearchTool, isAgentSearchTool } = require('../../integrations/agentSearchTools');
const { searchNotebookKB, executeNotebookKBSearchTool, NOTEBOOK_KB_SEARCH_TOOL } = require('../../core/notebookKnowledgeSearch');
const { emitPhase, emitPhaseEnd } = require('../../core/agentRuntime/phaseEvents');
const { checkSubscriptionLimits } = require('../../core/limits');

// ── Legal Studio (dutch_legal_sources) ──────────────────────────────
// A legal matter is a notebook of type 'legal_matter'. For those, we expose
// the Dutch legal research tools (rechtspraak / EUR-Lex / tuchtrecht /
// kamerstukken / bekendmakingen) and append a legal-mode prompt. Dispatch is
// reused via the central toolDispatcher — no duplicated legal if/else.
const fs = require('fs');
const path = require('path');
const legalCitationStore = require('../../stores/legalCitationStore');
const { executeTool } = require('../../core/toolDispatcher');
const { RECHTSPRAAK_TOOLS, isRechtspraakTool } = require('../../integrations/rechtspraakTools');
const { EURLEX_TOOLS, isEurlexTool } = require('../../integrations/eurlexTools');
const { TUCHTRECHT_TOOLS, isTuchtrechtTool } = require('../../integrations/tuchtrechtTools');
const { KAMERSTUKKEN_TOOLS, isKamerstukkenTool } = require('../../integrations/kamerstukkenTools');
const { BEKENDMAKINGEN_TOOLS, isBekendmakingenTool } = require('../../integrations/bekendmakingenTools');
const { LEGAL_MATTER_TOOLS, isLegalMatterTool, executeLegalMatterTool } = require('../../integrations/legalMatterTools');
const { userHasBetaFeature } = require('../../core/betaFeatures');

// ── Guardrails (parity with direct chat) ─────────────────────────────
const { sanitizeMessagesUnicode } = require('../../utils/unicodeSanitizer');
const { resolveShieldFor, mergeWithOrgShield } = require('../../core/orgShield');
const { checkRegexPatterns } = require('../../core/guardrails');
const guardrailEventStore = require('../../stores/guardrailEventStore');

// ── PII tokenization round-trip (parity with direct chat) ────────────
// The notebook path tokenizes inbound (doc body + user message) but historically
// never restored outbound, so `[person_1]` leaked into the chat + the editor and
// the token map was never persisted. These finish the round-trip: un-tokenise the
// stream for display, teach the model to preserve tokens, and re-tokenise history.
const dlpRunner = require('../../core/dlp/dlpRunner');
const { createUntokeniser } = require('../../core/dlp/untokeniseStream');
const { buildTokenPreservationAddendum } = require('../../core/dlp/tokenPreservationPrompt');
const { applyTokenMapToMessages, untokeniseToolArgs } = require('../../core/dlp/applyTokenMapToOutbound');

const LEGAL_TOOLS = [...RECHTSPRAAK_TOOLS, ...EURLEX_TOOLS, ...TUCHTRECHT_TOOLS, ...KAMERSTUKKEN_TOOLS, ...BEKENDMAKINGEN_TOOLS];
function isLegalTool(name) {
    return isRechtspraakTool(name) || isEurlexTool(name) || isTuchtrechtTool(name)
        || isKamerstukkenTool(name) || isBekendmakingenTool(name);
}

let _LEGAL_CHAT_PROMPT = null;
function getLegalChatPrompt() {
    if (_LEGAL_CHAT_PROMPT === null) {
        try { _LEGAL_CHAT_PROMPT = fs.readFileSync(path.join(__dirname, '../../prompts/legal-matter-chat-prompt.md'), 'utf-8'); }
        catch (e) { _LEGAL_CHAT_PROMPT = ''; console.warn('[NotebookChat] legal prompt load failed:', e.message); }
    }
    return _LEGAL_CHAT_PROMPT;
}

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Streaming Notebook Chat ─────────────────────────────────────

router.post('/chat/notebook/stream', requireAuth, async (req, res) => {
    const { message, notebookId, history, modelTier, timezone, attachments, documentContent, notebookSelection } = req.body;
    const userId = req.session.user.id;

    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!notebookId) return res.status(400).json({ error: 'Notebook ID required' });

    // Load notebook
    const notebook = await notebookStore.getNotebook(notebookId, userId);
    if (!notebook) return res.status(404).json({ error: 'Notebook not found' });

    // Legal Studio: expose the Dutch legal research tools + legal-mode prompt
    // only for matters whose owner has the dutch_legal_sources beta enabled.
    const isLegalMatter = notebook.type === 'legal_matter';
    let legalToolsEnabled = false;
    if (isLegalMatter) {
        try { legalToolsEnabled = await userHasBetaFeature(userId, 'dutch_legal_sources', req.session); }
        catch (_) { legalToolsEnabled = false; }
    }

    // ── Subscription limit enforcement ──
    // Same pattern as /api/agents/:id/chat/stream — block AI calls past the
    // org's monthly message/token/cost cap before any model runtime is invoked.
    {
        const { resolveUserOrgIds: _resolveOrgs } = require('../../auth');
        const orgIds = await _resolveOrgs(req);
        const limitOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
        const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
        if (limitError) return res.status(402).json({ error: limitError });
    }

    // Get sources for context
    const sources = await notebookStore.getSources(notebookId);
    const readySources = sources.filter(s => s.status === 'ready');

    // EU mode + org privacy shield: resolve user's org (matches direct chat)
    const { resolveUserOrgIds: resolveOrgIdsForTiers } = require('../../auth');
    const userStore = require('../../stores/userStore');
    const { getEUAwareTiers } = require('../../core/modelResolver');
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

    // Resolve model from tier config (EU-aware via centralized modelResolver)
    let tiers = await getEUAwareTiers({ userOrgId: userOrgForTiers, userId });
    if (userOrgForTiers) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`);
        if (shield?.enabled && shield.euModeEnabled) {
            console.log(`[NotebookChat] EU mode active for org ${userOrgForTiers}`);
        }
    }

    let resolvedTier = modelTier || 'fast';
    if (resolvedTier === 'standard') {
        resolvedTier = 'fast';
    }

    // Auto mode: classify which tier to use (matches direct chat)
    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/promptClassifier');
            const result = await classifyWithLLM(message, tiers, { userOrgId: userOrgForTiers, userId });
            resolvedTier = result.tier;
            console.log(`[NotebookChat] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            console.log(`[NotebookChat] Auto classification failed: ${err.message}, using fast`);
            resolvedTier = 'fast';
        }
    }
    if (resolvedTier === 'standard') {
        resolvedTier = 'fast';
    }

    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;

    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model;
        if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
    }

    // Resolve provider
    let config;
    let adapter;
    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        console.error(`[NotebookChat] Provider resolution failed for model "${modelId}":`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

    console.log(`[NotebookChat] Model: ${modelId} (tier: ${resolvedTier}${modelTier === 'auto' ? ', auto-selected' : ''}) for notebook: "${notebook.name}" (${readySources.length} sources)`);

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
    // Keep the stream warm through the NC AppAPI proxy during long reasoning /
    // doc-edit turns so it isn't idle-timed-out into a 504 (BFSF-221/177).
    startSseHeartbeat(res);

    // Persist a verified authority into the matter's bronnenlijst when a
    // retrieval tool returns a real record (a successful _get IS verification).
    // format_citation only auto-verifies at high/medium confidence.
    const recordLegalCitationFromTool = async (toolName, result) => {
        if (!result || result.error) return;
        let cite = null;
        if (toolName === 'rechtspraak_get' && result.ecli) cite = { kind: 'jurisprudentie', identifier: result.ecli, title: result.title, url: result.link };
        else if (toolName === 'eurlex_get' && result.celex) cite = { kind: 'eu', identifier: result.celex, title: result.title, url: result.link };
        else if (toolName === 'tuchtrecht_get' && (result.ecli || result.identifier)) cite = { kind: 'tuchtrecht', identifier: result.ecli || result.identifier, title: result.title, url: result.link };
        else if (toolName === 'format_citation' && result.ok && result.ecli && result.confidence !== 'low') cite = { kind: 'jurisprudentie', identifier: result.ecli, title: result.title, url: result.url };
        if (!cite) return;
        try {
            const saved = await legalCitationStore.upsertCitation({ notebookId, ...cite, verified: true, verificationMethod: toolName });
            if (saved) send('legal_citation_found', { citation: saved });
        } catch (e) { console.warn('[NotebookChat] citation upsert failed:', e.message); }
    };

    // Route a Dutch legal tool through the central dispatcher, then feed any
    // retrieved authority into the bronnenlijst.
    const handleLegalTool = async (toolName, toolArgs) => {
        const result = await executeTool(toolName, toolArgs, { userId, session: req.session });
        await recordLegalCitationFromTool(toolName, result);
        return result;
    };

    // Notify frontend of auto-selected model
    if (modelTier === 'auto') {
        send('model_selected', { tier: resolvedTier, modelId });
    }
    emitPhase(send, 'model_resolved', modelId);
    emitPhaseEnd(send, 'model_resolved');

    try {
        // ── PII round-trip setup (shared by KB / document / message scans) ──
        // Hydrate the notebook's persisted PII token map (keyed by notebookId)
        // BEFORE any tokenization this turn, so doc/KB/message tokens reuse tokens
        // minted on earlier turns and survive a server restart. Idempotent.
        try { await dlpRunner.getConversationTokenMapAsync(notebookId); } catch (_) { /* best-effort */ }
        // Resolve the org Privacy Shield ONCE — respect-the-shield: tokenization
        // only runs when the admin has it enabled. Reused by the KB + doc scans.
        const docShield = userOrgForTiers
            ? await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`)
            : null;
        // When the shield is on AND set to fail closed, a scan that throws must
        // abort the turn rather than silently sending raw PII to the model.
        const _failClosed = !!docShield?.enabled && (docShield?.dlpFailureMode === 'fail_closed');
        const _abortFailClosed = (where) => {
            console.warn(`[NotebookChat] 🚫 Privacy Shield scan failed (${where}); fail_closed → aborting turn`);
            send('error', { error: 'Privacy Shield could not verify this content for personal data, so the request was blocked. Please try again shortly.' });
            res.end();
        };

        // Search notebook knowledge base for relevant context
        let kbContext = '';
        let citationSources = [];
        const kbIds = notebook.knowledgeBaseIds || [];
        if (kbIds.length > 0) {
            emitPhase(send, 'kb_search');
            const _kbT = Date.now();
            try {
                const kbResult = await searchNotebookKB({
                    userId, kbIds, query: message,
                    options: { topK: 10, rerank: true, minScore: 0.2 },
                });

                if (kbResult.chunks.length > 0) {
                    // Resolve source names for citation display
                    const sourceNameMap = {};
                    readySources.forEach(s => {
                        sourceNameMap[s.name] = s.name;
                        sourceNameMap[s.id] = s.name;
                    });
                    const resolveSourceName = (rawTitle) => {
                        if (!rawTitle) return 'Unknown Source';
                        if (sourceNameMap[rawTitle]) return sourceNameMap[rawTitle];
                        const basename = rawTitle.split('/').pop();
                        if (sourceNameMap[basename]) return sourceNameMap[basename];
                        for (const [key, name] of Object.entries(sourceNameMap)) {
                            if (rawTitle.includes(key) || key.includes(rawTitle)) return name;
                        }
                        return rawTitle;
                    };

                    citationSources = kbResult.citations.map(c => ({
                        ...c,
                        title: resolveSourceName(c.title),
                    }));
                    kbContext = kbResult.contextPrompt;
                    console.log(`[NotebookChat] Injected ${kbResult.chunks.length} KB chunks for notebook "${notebook.name}"`);

                    // Tokenize the retrieved KB context BEFORE it enters the prompt.
                    // Embeddings + stored source text stay REAL (ingest untouched) —
                    // we only tokenize the small set of chunks actually injected,
                    // seeded from + merged into the SAME notebook map so a name shared
                    // by a source and the document maps to one [person_1]. The
                    // citationSources previews (sent to the client below) stay REAL —
                    // they are the user's own sources.
                    if (kbContext && docShield?.enabled) {
                        try {
                            const { scanAttachmentText } = require('../../core/dlp/attachmentScanner');
                            const kbScan = await scanAttachmentText({
                                text: kbContext, filename: 'kb-context', orgShield: docShield, conversationId: notebookId,
                            });
                            if (kbScan && kbScan.action === 'tokenize' && kbScan.text) {
                                kbContext = kbScan.text;
                                const n = Array.isArray(kbScan.findings) ? kbScan.findings.length : 0;
                                if (n > 0) console.warn(`[NotebookChat] 🔒 KB context tokenized (${n} PII spans)`);
                            }
                            // Coverage guarantee: per-chunk detection can miss a span
                            // the ingest-time scan already mapped. Apply the notebook's
                            // accumulated map (real→token) so EVERY known entity in the
                            // retrieved context is tokenised before the model sees it —
                            // the model must never read a raw name that's already mapped.
                            const { buildReverseReplacer } = require('../../core/dlp/applyTokenMapToOutbound');
                            const _rev = buildReverseReplacer(dlpRunner.getConversationTokenMap(notebookId));
                            if (_rev) kbContext = _rev(kbContext);
                        } catch (kbScanErr) {
                            console.warn('[NotebookChat] KB context PII scan failed:', kbScanErr.message);
                            if (_failClosed) return _abortFailClosed('kb-context');
                        }
                    }
                }
            } catch (kbErr) {
                console.warn('[NotebookChat] KB search failed:', kbErr.message);
            }
            emitPhaseEnd(send, 'kb_search', Date.now() - _kbT);
        }

        // Send citation sources to frontend
        if (citationSources.length > 0) {
            send('kb_sources', { sources: citationSources.map(s => ({ title: s.title, preview: s.content, score: s.score })) });
        }

        // If the document was too large to inline in the prompt, tell the UI so
        // it can show a one-shot banner. The client-side handler decides whether
        // to suppress repeat banners for the same conversation turn.
        // Emitted AFTER the systemPrompt build below uses `documentTruncation` —
        // so the announcement is deferred until we've actually committed to it.

        // Build source summary
        const sourceSummary = readySources.length > 0
            ? readySources.map(s => `- ${s.name} (${s.type}, ${(s.wordCount || 0).toLocaleString()} words)`).join('\n')
            : '(No sources added yet)';

        // Build document context. We used to hard-truncate at 8000 chars, which
        // silently dropped content for anything longer than ~4 pages. Now we fit
        // the document into a token budget (~20k tokens ≈ 80k chars) and tell
        // BOTH the AI and the user when truncation happened so neither thinks
        // they've seen the whole thing.
        const { fitIntoTokenBudget } = require('../../core/tokenBudget');
        const DOCUMENT_CONTEXT_TOKENS = 20000;
        let documentContext = '';
        let documentTruncation = null; // { originalTokens, keptTokens, approxPagesCut }
        // Privacy Shield — scan the notebook document body BEFORE it lands
        // in the system prompt. Without this, PII inside the TipTap editor
        // (names, BSNs, emails in a Wmo intake document) leaks directly to
        // the model because the regular validateInputForPii() only scans
        // the user/assistant message turns, not the system prompt.
        let docPiiTokenMap = null;
        let scannedDocumentContent = documentContent;
        if (documentContent && documentContent.trim() && documentContent !== '<p></p>') {
            try {
                if (docShield?.enabled) {
                    const { scanAttachmentText } = require('../../core/dlp/attachmentScanner');
                    const scanRes = await scanAttachmentText({
                        text: documentContent,
                        filename: 'notebook-document',
                        orgShield: docShield,
                        conversationId: notebookId,
                    });
                    if (scanRes && scanRes.action === 'tokenize' && scanRes.text) {
                        scannedDocumentContent = scanRes.text;
                        docPiiTokenMap = scanRes.tokenMap || null;
                        const findingCount = Array.isArray(scanRes.findings) ? scanRes.findings.length : 0;
                        if (findingCount > 0) {
                            console.warn(`[NotebookChat] 🔒 Document content tokenized (${findingCount} PII spans)`);
                        }
                    }
                    // Coverage guarantee (mirrors the KB-context path): apply the
                    // notebook's accumulated map (real→token) so any mapped entity the
                    // per-document detection missed is still tokenised before the body
                    // enters the prompt — the model reads `[email_1]`, never the real
                    // value, when it re-reads its own stored-real document.
                    const { buildReverseReplacer } = require('../../core/dlp/applyTokenMapToOutbound');
                    const _revDoc = buildReverseReplacer(dlpRunner.getConversationTokenMap(notebookId));
                    if (_revDoc) scannedDocumentContent = _revDoc(scannedDocumentContent);
                }
            } catch (docScanErr) {
                console.warn('[NotebookChat] Document PII scan failed, falling back to raw content:', docScanErr.message);
                if (_failClosed) return _abortFailClosed('document');
            }
        }
        if (scannedDocumentContent && scannedDocumentContent.trim() && scannedDocumentContent !== '<p></p>') {
            // Inline the document as Markdown (≈30–60% fewer tokens than the HTML
            // for the same content), so more of it fits in the context budget.
            const scannedMarkdown = (notebook.documentMd && !docPiiTokenMap)
                ? notebook.documentMd
                : htmlToMarkdown(scannedDocumentContent);
            const fit = fitIntoTokenBudget(scannedMarkdown, DOCUMENT_CONTEXT_TOKENS);
            if (fit.truncated) {
                documentTruncation = {
                    originalTokens: fit.originalTokens,
                    keptTokens: fit.keptTokens,
                };
                documentContext =
                    `\n\n[DOCUMENT EDITOR — CURRENT CONTENT, TRUNCATED]\n` +
                    `The user has a large rich-text document editor open in the center panel. ` +
                    `Roughly ${fit.keptTokens.toLocaleString()} of ${fit.originalTokens.toLocaleString()} tokens shown below. ` +
                    `If the user asks about something not visible here, use notebook_kb_search to retrieve from the indexed content, ` +
                    `or ask them to quote / select the section they mean.\n` +
                    `\`\`\`markdown\n${fit.text}\n\`\`\`\n` +
                    `You can read, write, or edit this document using the notebook_doc_* tools.`;
            } else {
                documentContext =
                    `\n\n[DOCUMENT EDITOR — CURRENT CONTENT]\n` +
                    `The user has a rich-text document editor open in the center panel. Current content:\n` +
                    `\`\`\`markdown\n${fit.text}\n\`\`\`\n` +
                    `You can read, write, or edit this document using the notebook_doc_* tools.`;
            }
        } else {
            documentContext = '\n\n[DOCUMENT EDITOR — EMPTY]\nThe user has an empty rich-text document editor open. Use notebook_doc_write to create content.';
        }

        // Append the user's editor selection (set by the Ask AI / rewrite /
        // shorten / expand bubble menu actions on the frontend). When present,
        // the AI should treat "this", "the text", "the selection", etc. as
        // referring to the exact string below, and — for rewrite-style actions
        // — pass that same string verbatim as `find_text` to notebook_doc_replace.
        let selectionContext = '';
        if (notebookSelection && typeof notebookSelection.text === 'string' && notebookSelection.text.trim()) {
            const MAX_SEL_CHARS = 8000;
            const selText = notebookSelection.text.length > MAX_SEL_CHARS
                ? notebookSelection.text.slice(0, MAX_SEL_CHARS) + '…[truncated]'
                : notebookSelection.text;
            const actionHint = notebookSelection.action && ['rewrite', 'shorten', 'expand'].includes(notebookSelection.action)
                ? `The user explicitly invoked "${notebookSelection.action}" on this selection, so you MUST call notebook_doc_replace with find_text set to the exact selection above and replace_text set to your revised version.`
                : `If the user asks you to edit, rewrite, or change "this" / "the text" / "the selection", use notebook_doc_replace with find_text set to the EXACT string above. If they ask a question, answer about this text specifically.`;
            selectionContext =
                `\n\n[SELECTED TEXT IN DOCUMENT]\n` +
                `The user has highlighted the following text in the editor:\n` +
                `<<<SELECTION_BEGIN>>>\n${selText}\n<<<SELECTION_END>>>\n` +
                actionHint;
        }

        // Build system prompt
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // Compute search availability before the system prompt uses it
        const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
        const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
        const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
        const searchAvailable = searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);

        // ── Build system prompt ──────────────────────────────────────
        emitPhase(send, 'building_prompt');
        const _spT = Date.now();
        let systemPrompt;
        {
            systemPrompt = `You are an intelligent notebook assistant. Today is ${today}.

[NOTEBOOK: "${notebook.name}"]
${notebook.description ? `Description: ${notebook.description}` : ''}
${notebook.instructions ? `\nCustom Instructions: ${notebook.instructions}` : ''}

[AVAILABLE SOURCES]
${sourceSummary}

CRITICAL INSTRUCTIONS:
1. ALWAYS ground your responses in the notebook's sources when relevant context is available.
2. Use inline citations like [Source 1], [Source 2] when referencing specific information from the knowledge base.
3. If the user asks about something not covered in the sources, clearly state that and provide general knowledge with a disclaimer.
4. Be comprehensive but concise. Synthesize information across multiple sources when applicable.
5. If asked to summarize, compare, or analyze — draw from ALL relevant sources.
6. Format responses with clear structure: headings, bullet points, and citations.

[DOCUMENT TOOLS]
You have tools to interact with the user's document editor:
- notebook_doc_read: Read the current document content (ALWAYS use before editing)
- notebook_doc_write: Replace ALL document content (for new documents or full rewrites)
- notebook_doc_replace: Replace a SPECIFIC portion (preferred for edits)

DOCUMENT FORMAT — write the document in Markdown (BFM):
- Headings: # H1, ## H2, ### H3
- Inline: **bold**, *italic*, ~~strike~~, inline code in single backticks, ==highlight==
- Lists: "- item", "1. item"; task lists "- [ ] todo" / "- [x] done"
- > blockquote, --- divider, [text](url) links
- Tables: a header row, then a |---|---| separator row, then data rows
- Fenced code blocks (triple-backtick + language); diagrams use triple-backtick mermaid fences
- Math (KaTeX): $inline$ and $$block$$
- Images: ![alt](url){w=400 align=center wrap} (attrs optional; user uploads go via the toolbar, not AI)
- Color/font are rare: [text]{color=#e74c3c} / [text]{font=Georgia}

DOCUMENT RULES — FOLLOW STRICTLY:
1. To rewrite, shorten, expand, fix, edit, or modify text from the document: ALWAYS use notebook_doc_replace to apply the change directly — do NOT just return the modified text in chat.
2. For partial edits, ALWAYS prefer notebook_doc_replace over notebook_doc_write.
3. Before notebook_doc_replace, call notebook_doc_read to see the EXACT current Markdown.
4. When asked to write, create, or draft something: write it via notebook_doc_write — don't just reply in chat.
5. The user's message may include selected document text — pass it verbatim as find_text.
6. After applying a change, briefly confirm what you did (e.g. "I've shortened that paragraph").
7. For source citations use clickable [Source name](url) links — never [1]-style refs.
8. STYLE CONSISTENCY: when replacing, match the original formatting — don't promote a paragraph to a heading unless asked.

${searchAvailable ? `[WEB SEARCH & SOURCES]
- You can search the web using agent_search for current information and research
- You can add search results or any text directly as a notebook source using notebook_add_source
- When adding web search results as a source, pass the complete results text directly — no need to re-fetch
` : ''}${legalToolsEnabled ? '\n' + getLegalChatPrompt() + '\n' : ''}${kbContext}${documentContext}${selectionContext}
Now: ${(() => { const _tz = timezone || 'Europe/Amsterdam'; try { const _now = new Date(); const _dp = _now.toLocaleString('sv-SE', { timeZone: _tz }); const _lp = new Date(_now.toLocaleString('en-US', { timeZone: _tz })); const _om = Math.round((_lp - _now) / 60000); const _s = _om >= 0 ? '+' : '-'; const _a = Math.abs(_om); return `${_dp} UTC${_s}${String(Math.floor(_a/60)).padStart(2,'0')}:${String(_a%60).padStart(2,'0')} (${_tz})`; } catch(_) { return new Date().toISOString(); } })()}`;
        }
        emitPhaseEnd(send, 'building_prompt', Date.now() - _spT);

        // Announce document truncation to the client now that we've finalised
        // the system prompt. One event per turn — the UI debounces banners.
        if (documentTruncation) {
            send('document_truncated', documentTruncation);
        }

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

            // Use the same server-side extraction pipeline as direct chat so
            // PDFs/DOCX/spreadsheets are turned into real text (pdfjs → Azure →
            // Mistral OCR → vision) instead of being UTF-8-decoded into garbage.
            const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote, isPdf, isDocx, isSpreadsheet } = require('../../core/attachmentExtractor');
            // Tokenize PII in extracted attachment text BEFORE it enters the prompt
            // — a file attached in Legal/Notebook chat must not send names/BSN/email
            // to the model raw (notebook chat used to inline attachment text raw).
            // Honors the org's chosen action and merges into the same notebook token
            // map so the streamed reply un-tokenises consistently. Reuses the same
            // scanner as direct chat + the KB/doc scans.
            const _scanAttBody = async (text, filename) => {
                if (!text || !docShield?.enabled) return text;
                try {
                    const { scanAttachmentText } = require('../../core/dlp/attachmentScanner');
                    const r = await scanAttachmentText({ text, filename: filename || 'attachment', orgShield: docShield, conversationId: notebookId });
                    if (r && r.action === 'tokenize' && r.text) return r.text;
                } catch (e) { console.warn('[NotebookChat] attachment PII scan failed:', e.message); }
                return text;
            };
            for (const att of attachments) {
                try {
                    if (att.type && att.type.startsWith('image/') && att.content) {
                        contentParts.push({ type: 'image_url', image_url: { url: att.content } });
                    } else if (att.content && (isPdf(att) || isDocx(att) || isSpreadsheet(att))) {
                        const result = await extractAttachment(att, { modelSupportsVision: adapter.supportsVision?.(modelId) });
                        if (result.kind === 'text') {
                            const _body = await _scanAttBody((result.text || '').slice(0, 20000), att.name);
                            contentParts.push({ type: 'text', text: `${formatTextHeader(att, result)}\n---\n${_body}\n---` });
                        } else if (result.kind === 'images' && Array.isArray(result.images)) {
                            contentParts.push({ type: 'text', text: formatImagesHeader(att, result) });
                            for (const img of result.images) {
                                contentParts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
                            }
                        } else {
                            contentParts.push({ type: 'text', text: formatFailureNote(att, result) });
                        }
                    } else if (att.content && typeof att.content === 'string') {
                        // Plain-text / csv / code files — a UTF-8 decode is correct.
                        const textContent = att.content.startsWith('data:') ? Buffer.from(att.content.split(',')[1] || '', 'base64').toString('utf-8') : att.content;
                        if (textContent) {
                            const _body = await _scanAttBody(textContent.slice(0, 8000), att.name);
                            contentParts.push({ type: 'text', text: `[File: ${att.name}]\n---\n${_body}\n---` });
                        }
                    }
                } catch (attErr) {
                    contentParts.push({ type: 'text', text: `[Bestand: ${att.name} — kon niet worden gelezen: ${attErr.message}]` });
                }
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

        // ── Unicode Smuggling Defense (must run FIRST) ──────────────────
        const unicodeResult = sanitizeMessagesUnicode(messages);
        if (unicodeResult.smugglingDetected) {
            console.warn(`[NotebookChat] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
            send('unicode_smuggling_detected', {
                strippedCount: unicodeResult.totalStripped,
                messageIndices: unicodeResult.detectedIn,
            });
            guardrailEventStore.logGuardrailEvent({
                organization_id: userOrgForTiers || null,
                user_id: userId || null,
                conversation_id: notebookId || null,
                violation_type: 'unicode_smuggling',
                violation_categories: `${unicodeResult.totalStripped} hidden chars`,
                direction: 'input',
                action_taken: 'stripped',
                source: 'notebook',
            }).catch(() => {});
        }

        // ── PII detection / tokenization (Privacy Shield) ──────────────
        // Mirrors directChat: if the org's Privacy Shield is enabled,
        // run validateInputForPii on the last user message and apply
        // tokenize/block actions. detectPii() calls the PII Guard service.
        let piiTokenMap = null;
        // Privacy-panel parity with directChat: assembled once per turn, emitted
        // to the client (live) AND persisted on the assistant message (so the
        // "Privacy protection" panel survives a refresh). `_userPiiCategories`
        // backs the redacted badge on the user bubble; `_showRawPayload` gates
        // surfacing the exact tokenised prompt / token map (org opt-in).
        let _assistantTokenisationInfo = null;
        let _userPiiCategories = [];
        let _showRawPayload = false;
        try {
            const orgShield = userOrgForTiers ? await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`) : null;
            const orgPiiEnabled = !!orgShield?.enabled;
            _showRawPayload = !!orgShield?.showRawPayload;
            // Hydrate the conversation-scoped token map (keyed on notebookId
            // here, matching the mergeTokenMap key below) before tokenisation
            // runs so turn 2+ reuses tokens minted on turn 1 instead of
            // leaking them to the LLM as literal text. Idempotent.
            if (notebookId) {
                try { await require('../../core/dlp/dlpRunner').getConversationTokenMapAsync(notebookId); }
                catch (_) { /* hydration is best-effort */ }
            }
            if (orgPiiEnabled) {
                const { validateInputForPii } = require('../../core/piiDetection');
                const piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield);
                if (piiResult && piiResult.tokenizedText) {
                    const lastMsg = messages[messages.length - 1];
                    if (typeof lastMsg.content === 'string') {
                        lastMsg.content = piiResult.tokenizedText;
                    } else if (Array.isArray(lastMsg.content)) {
                        const textPart = lastMsg.content.find(p => p.type === 'text');
                        if (textPart) textPart.text = piiResult.tokenizedText;
                    }
                    piiTokenMap = piiResult.tokenMap;
                    try { require('../../core/dlp/dlpRunner').mergeTokenMap(notebookId, piiResult.tokenMap); } catch (_) { /* non-fatal */ }
                    console.warn(`[NotebookChat] 🔒 PII tokenized (${Object.keys(piiTokenMap).length} tokens)`);

                    // ── Surface the tokenisation to the client (parity w/ directChat) ──
                    // Drives the user-bubble "redacted" badge + the assistant-side
                    // "Privacy protection" panel. The exact tokenised prompt + the
                    // real-value token map are only emitted when the org opted into
                    // showRawPayload; the count/categories badge always shows.
                    _userPiiCategories = [...new Set((piiResult.entities || []).map(e => e.label || e.category).filter(Boolean))];
                    const _piiCount = Object.keys(piiTokenMap).length;
                    send('pii_tokenized', {
                        entities: (piiResult.entities || []).map(e => ({ label: e.label, category: e.category })),
                        tokenCount: _piiCount,
                    });
                    _assistantTokenisationInfo = {
                        source: 'pii', action: 'redact', count: _piiCount,
                        categories: _userPiiCategories, provider: modelId || null, automatic: true,
                    };
                    if (_showRawPayload) {
                        send('privacy_payload', { tokenizedPrompt: piiResult.tokenizedText, provider: modelId || null, source: 'pii', timestamp: Date.now() });
                        _assistantTokenisationInfo.tokenizedPrompt = piiResult.tokenizedText;
                        if (_piiCount > 0) {
                            send('privacy_token_map', { tokenMap: piiTokenMap, source: 'pii' });
                            _assistantTokenisationInfo.tokenMap = piiTokenMap;
                        }
                    }
                }
            }
        } catch (piiError) {
            if (piiError?.message?.includes('PII Detected')) {
                send('error', { error: piiError.message, violationCodes: piiError.violationCodes });
                return res.end();
            }
            // Service unavailable → fail-open
        }

        // ── Token-preservation prompt addendum ───────────────────────────
        // Teach the model to treat tokens as opaque and reuse them verbatim so it
        // doesn't invent new placeholders or mangle `[person_1]`. Must run AFTER
        // the doc/KB/message tokenization above so the map already holds this
        // turn's tokens. Mirrors directChat.
        try {
            if (messages[0]?.role === 'system' && typeof messages[0].content === 'string'
                && !messages[0].content.includes('[PII TOKEN PRESERVATION')) {
                const _add = buildTokenPreservationAddendum(dlpRunner.getConversationTokenMap(notebookId));
                if (_add) messages[0].content += _add;
            }
        } catch (_) { /* addendum is best-effort */ }

        // ── Regex Guardrails (org Privacy Shield + input check) ──────────
        // Resolve org-wide regex rules; mirrors directChat.js:2348-2393
        const orgShieldConfig = await resolveShieldFor({ orgId: userOrgForTiers, userId });
        let regexConfig = mergeWithOrgShield(orgShieldConfig, null); // no notebook-local overrides

        // Input regex check: block/redact before the model sees the message
        if (regexConfig?.enabled && regexConfig?.scope?.userInput) {
            const matches = checkRegexPatterns(message, regexConfig.rulesWithNames);
            if (matches.length > 0) {
                const ruleNames = matches.map(m => m.ruleName).join(', ');
                console.log(`[NotebookChat RegexGuard] User input violated rules: ${ruleNames}, action: ${regexConfig.action}`);

                if (regexConfig.action === 'redact') {
                    // Redact the message for the model
                    let redactedMessage = message;
                    for (const rule of regexConfig.rulesWithNames) {
                        try {
                            const regex = new RegExp(rule.pattern, 'gi');
                            redactedMessage = redactedMessage.replace(regex, `[REDACTED: ${rule.name}]`);
                        } catch (e) { /* skip invalid patterns */ }
                    }
                    send('content_redact', {
                        originalMessage: message,
                        redactedMessage,
                        rules: ruleNames,
                        autoRedactSeconds: 5
                    });
                    // Replace in messages
                    const lastMsg = messages[messages.length - 1];
                    if (typeof lastMsg.content === 'string') {
                        lastMsg.content = redactedMessage;
                    }
                    guardrailEventStore.logGuardrailEvent({
                        organization_id: userOrgForTiers || null,
                        user_id: userId || null,
                        conversation_id: notebookId || null,
                        violation_type: 'regex',
                        violation_categories: ruleNames,
                        direction: 'input',
                        action_taken: 'redacted',
                        source: 'notebook',
                    }).catch(() => {});
                } else {
                    // Block the message — don't send to model
                    send('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5 });
                    guardrailEventStore.logGuardrailEvent({
                        organization_id: userOrgForTiers || null,
                        user_id: userId || null,
                        conversation_id: notebookId || null,
                        violation_type: 'regex',
                        violation_categories: ruleNames,
                        direction: 'input',
                        action_taken: 'blocked',
                        source: 'notebook',
                    }).catch(() => {});
                    return res.end();
                }
            }
        }

        // ── Build tool list ──────────────────────────────────────────
        const notebookTools = [...NOTEBOOK_DOC_TOOLS, NOTEBOOK_ADD_SOURCE_TOOL];

        // Add KB search tool so the AI can explicitly search notebook sources
        if (kbIds.length > 0) {
            notebookTools.push(NOTEBOOK_KB_SEARCH_TOOL);
        }

        // Add web search tools if available (searchAvailable computed earlier for system prompt)
        if (searchAvailable) {
            notebookTools.push(...AGENT_SEARCH_TOOLS);
        }

        // Dutch legal research tools + matter actions (bronnenlijst, verify) —
        // only for legal matters with the beta on.
        if (legalToolsEnabled) {
            notebookTools.push(...LEGAL_TOOLS, ...LEGAL_MATTER_TOOLS);
        }



        // ── Tool calling loop ────────────────────────────────────────
        const tierSettings = tiers[resolvedTier] || {};
        const { TIER_DEFAULTS } = require('../../core/modelResolver');
        const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
            // Pass an explicit reasoning effort. Without it, Claude 4.x adaptive
            // thinking defaults to 'medium' and can burn the entire (fast-tier,
            // 4096-token) budget on thinking, ending the stream with EMPTY content
            // and no document edit — the "stuck in reasoning" symptom (BFSF-177).
            reasoningEffort: req.body.reasoningEffort || tierSettings.reasoningEffort || tierDefaults.reasoningEffort || 'low',
        };
        // Give thinking + answer headroom so a low tier doesn't share a tiny pot.
        if (chatOptions.reasoningEffort && chatOptions.reasoningEffort !== 'none') {
            chatOptions.maxTokens = Math.max(chatOptions.maxTokens || 0, 8192);
        }

        // Track mutable document content (HTML for the client) + its Markdown
        // mirror (token-efficient source the doc tools read/edit) across rounds.
        // CRITICAL: seed the mirror in TOKEN-space when the doc was tokenized, so
        // it matches what the model sees in the system prompt (scannedDocumentContent).
        // Otherwise notebook_doc_read returns RAW text while the model's find_text
        // was written against the tokenized text it saw → notebook_doc_replace misses.
        let currentDocContent = scannedDocumentContent || documentContent || '';
        let currentDocMd = docPiiTokenMap
            ? htmlToMarkdown(scannedDocumentContent)
            : (notebook.documentMd || (documentContent ? htmlToMarkdown(documentContent) : ''));
        // Set when any notebook_doc_* tool wrote this turn. The mid-turn write
        // restores tokens against whatever map existed at that instant; tokens
        // minted LATER in the same turn (source/KB/tool-result scans) would
        // otherwise leave the saved document with raw `[person_5]`/`[email]1`.
        // We re-restore the document once at end of turn against the COMPLETE map.
        let _docWritten = false;

        // Single tool executor — used for every tool the model calls, in every
        // round. Performs side-effects (doc update, source added, legal citation
        // feed-through) and returns the result object handed back to the model.
        const executeNotebookTool = async (toolName, toolArgs) => {
            if (toolName.startsWith('notebook_doc_')) {
                const r = executeNotebookDocTool(toolName, toolArgs, currentDocContent, currentDocMd);
                if (r && r._action === 'notebook_doc_update') {
                    _docWritten = true;
                    // Keep the in-memory mirror in TOKEN-space so a chained
                    // notebook_doc_read/replace later in the same turn keeps matching
                    // the tokenized text the model saw.
                    currentDocContent = r.content;
                    if (r.contentMd != null) currentDocMd = r.contentMd;
                    // Restore tokens → real values BEFORE persisting + displaying.
                    // The editor is the user's work product and must never store or
                    // show `[person_1]` (the doc-side analogue of untokeniseToolArgs
                    // for write tools). The conv map holds the doc/source/chat tokens.
                    // Rich-text restore: the document is HTML/Markdown, so a token
                    // typed in italic/bold can be split by inline markup or have its
                    // brackets/underscore escaped — restoreTokensInRichText tolerates
                    // that, where plain restoreTokens would leave `[person_1]` raw.
                    const { restoreTokensInRichText } = require('../../core/piiDetection');
                    const _docMap = dlpRunner.getConversationTokenMap(notebookId) || {};
                    const realHtml = restoreTokensInRichText(r.content, _docMap);
                    const realMd = r.contentMd != null ? restoreTokensInRichText(r.contentMd, _docMap) : null;
                    // PERSIST the AI's edit to the database. Previously this only
                    // updated the in-memory mirror and emitted the SSE below, so an
                    // AI-written document lived ONLY in the browser editor — and
                    // `onNotebookDocUpdate` doesn't trigger the interactive autosave,
                    // so the whole document was lost on refresh (the user never
                    // manually typed to save it). Snapshot for version history first,
                    // mirroring the PUT /api/notebooks/:id autosave path. All compares
                    // are real-vs-real (prev.documentContent is stored real).
                    try {
                        if (realHtml && realHtml.trim() && await notebookStore.shouldAutoVersion(notebookId).catch(() => false)) {
                            const prev = await notebookStore.getNotebook(notebookId, userId).catch(() => null);
                            if (prev?.documentContent && prev.documentContent.trim() && prev.documentContent !== realHtml) {
                                await notebookStore.createVersion(notebookId, prev.documentContent, 'AI edit').catch(() => {});
                            }
                        }
                        const ok = await notebookStore.updateNotebook(notebookId, userId, {
                            documentContent: realHtml,
                            ...(realMd != null ? { documentMd: realMd } : {}),
                        });
                        if (!ok) console.warn(`[NotebookChat] AI doc write not persisted for notebook ${notebookId}`);
                    } catch (e) {
                        console.error('[NotebookChat] AI doc persist failed:', e.message);
                    }
                    // Client applies real HTML; the real Markdown mirror is persisted
                    // alongside so a later notebook GET serves real values directly.
                    send('notebook_doc_update', { content: realHtml, title: r.title });
                }
                return r;
            }
            if (toolName === 'notebook_add_source') {
                const { ingestTextSource } = require('../../agents/notebooks/sourceIngestion');
                const sourceName = toolArgs.name || 'AI Research';
                // The model may echo tokens (`[person_1]`) in the content it asks us
                // to save as a new source. Restore to real values before ingest so the
                // stored source + its embeddings hold real text (sources are stored
                // raw/real; tokenization happens at query-time in step B4).
                const { restoreTokens } = require('../../core/piiDetection');
                const _srcMap = dlpRunner.getConversationTokenMap(notebookId) || {};
                const sourceContent = restoreTokens(toolArgs.content || '', _srcMap);
                const sourceMeta = toolArgs.metadata || {};
                if (!sourceContent.trim()) return { error: 'Content is required to add a source.' };
                const source = await notebookStore.addSource({
                    notebookId, type: 'text', name: sourceName, metadata: sourceMeta,
                    wordCount: sourceContent.split(/\s+/).length,
                });
                sources.push({ ...source, metadata: sourceMeta });
                ingestTextSource(notebookId, source.id, userId, sourceContent, sourceName)
                    .catch(err => console.error('[NotebookChat] Source ingestion failed:', err.message));
                send('notebook_source_added', { source: { id: source.id, name: sourceName, type: 'text', status: 'processing', metadata: sourceMeta } });
                return { success: true, message: `Source "${sourceName}" added and indexing.`, sourceId: source.id };
            }
            if (toolName === 'notebook_kb_search') {
                return await executeNotebookKBSearchTool(toolArgs, userId, kbIds);
            }
            if (isAgentSearchTool(toolName)) {
                return await executeAgentSearchTool(toolName, toolArgs);
            }
            if (legalToolsEnabled && isLegalTool(toolName)) {
                return await handleLegalTool(toolName, toolArgs);
            }
            if (legalToolsEnabled && isLegalMatterTool(toolName)) {
                return await executeLegalMatterTool(toolName, toolArgs, { notebookId, documentContent: currentDocContent });
            }
            return { error: `Unknown tool: ${toolName}` };
        };

        // ── Multi-round streaming agentic loop (mirrors direct chat) ──
        // Every round streams content + reasoning + tool calls; tools stay
        // enabled across rounds so the model can chain (search → get → verify →
        // draft), all streamed, with tool_start/tool_end events the shared chat
        // renderer already understands. Fixes the previous one-shot truncation.
        const MAX_TOOL_ROUNDS = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 15;
        let fullContent = '';
        emitPhase(send, 'streaming_start', modelId);

        // Un-tokenise the streamed answer for DISPLAY (Model 1): the model emits
        // tokens (it's instructed to preserve them); the user must only ever see
        // real values. LIVE getter so tokens minted mid-turn (doc/KB/tool scans)
        // are picked up. Storage (`fullContent`) stays tokenized — it is restored
        // on reload via the persisted map (see GET /:id/conversation). Mirrors
        // directChat.js. Spans the whole turn; flushed once after the loop.
        const _untok = createUntokeniser(() => dlpRunner.getConversationTokenMap(notebookId));

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            const isFinalRound = round === MAX_TOOL_ROUNDS;
            let roundText = '';
            const roundToolCalls = [];
            const streamCallback = (type, data) => {
                if (type === 'text') {
                    // Accumulate tokenized text for storage; stream un-tokenised text
                    // (buffered so a token split across SSE chunks isn't shown raw).
                    roundText += data.text; fullContent += data.text;
                    const safe = _untok.push(data.text);
                    if (safe) send('content', { text: safe });
                }
                else if (type === 'thinking') send('thinking', { text: _untok.restore(data.text) });
                else if (type === 'thinking_start') send('thinking_start', data || {});
                else if (type === 'thinking_stop') send('thinking_stop', data || {});
                else if (type === 'tool_use') {
                    roundToolCalls.push({
                        id: data.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
                        type: 'function',
                        function: { name: data.name, arguments: JSON.stringify(data.input || {}) },
                    });
                } else if (type === 'error') send('error', data);
            };

            const streamOptions = {
                ...chatOptions,
                // Tools stay enabled every round except a final safety round,
                // which forces a textual answer if the model hits the cap.
                tools: isFinalRound ? undefined : notebookTools,
                toolChoice: isFinalRound ? undefined : 'auto',
            };

            try {
                // Re-tokenise known real values across the WHOLE outbound payload
                // (client-sent history goes raw otherwise — only the last user msg
                // was tokenized) so no real PII reaches the provider. Returns a new
                // array; the canonical `messages` (mutated across rounds) is unchanged.
                const outboundMessages = applyTokenMapToMessages({ conversationId: notebookId, messages });
                await adapter.stream(apiKey, apiUrl, modelId, outboundMessages, streamOptions, streamCallback);
            } catch (err) {
                console.error('[NotebookChat] Stream error:', err.message);
                send('error', { error: err.message });
                break;
            }

            if (roundToolCalls.length === 0) break; // model produced its final answer

            // Record the assistant turn (preamble + tool calls), run the tools
            // with tool_start/tool_end, feed results back, and loop.
            messages.push({ role: 'assistant', content: roundText || null, tool_calls: roundToolCalls });
            // Run the round's tools SEQUENTIALLY, not via Promise.all. The
            // notebook_doc_* tools mutate shared closure state (currentDocContent /
            // currentDocMd) and persist to the DB; running them concurrently lets a
            // notebook_doc_read batched alongside a notebook_doc_write observe the
            // document before the write commits, so the agent "can't read what it
            // just wrote" (BFSF-234). Sequential execution makes each tool see the
            // committed result of the previous one. Order is preserved, so the
            // tool_call_id ↔ result mapping the model expects is unchanged.
            const toolResults = [];
            for (const toolCall of roundToolCalls) {
                const toolName = toolCall.function?.name || toolCall.name;
                let toolArgs = {};
                try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (_) {}
                // The model passes tokens in tool args (e.g. find_text). Restore for
                // the CLIENT-facing tool_start/tool_end previews only — the model-facing
                // result fed back below stays tokenized (token-space consistency).
                // _restoreView reads the LIVE map so tokens minted by this turn's
                // tool-result scan (below) are restored in the client preview too.
                const { restoreTokens: _rt } = require('../../core/piiDetection');
                const _restoreView = (s) => {
                    const m = dlpRunner.getConversationTokenMap(notebookId) || {};
                    return (Object.keys(m).length && typeof s === 'string') ? _rt(s, m) : s;
                };
                send('tool_start', { name: toolName, args: untokeniseToolArgs(toolArgs, dlpRunner.getConversationTokenMap(notebookId) || {}) });
                let toolResult;
                try { toolResult = await executeNotebookTool(toolName, toolArgs); }
                catch (err) { toolResult = { error: err.message }; }
                let resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                // Tokenize source/web content returned by RETRIEVAL tools before the
                // model sees it — Legal/Notebook SOURCES (notebook_kb_search) and web
                // results would otherwise reach the LLM raw. Exclude notebook_doc_*
                // (already token-space, B3) and the Dutch legal tools (public court
                // data whose exact ECLI/CELEX identifiers citation-matching needs).
                if (docShield?.enabled && resultStr && (toolName === 'notebook_kb_search' || isAgentSearchTool(toolName))) {
                    try {
                        const { scanAttachmentText } = require('../../core/dlp/attachmentScanner');
                        const r = await scanAttachmentText({ text: resultStr, filename: `${toolName}-result`, orgShield: docShield, conversationId: notebookId });
                        if (r && r.action === 'tokenize' && r.text) resultStr = r.text;
                    } catch (e) { console.warn('[NotebookChat] tool-result PII scan failed:', e.message); }
                }
                send('tool_end', { name: toolName, result: _restoreView(resultStr).slice(0, 800) });
                toolResults.push({ role: 'tool', tool_call_id: toolCall.id, content: resultStr });
            }
            messages.push(...toolResults);
        }

        // ── Un-tokenise the final answer for display ─────────────────────
        // Flush any trailing partial token, then run a full-text restore as a
        // safety net (covers tokens minted very late in the turn / any chunk the
        // streaming un-tokeniser missed). `fullContent` stays TOKENIZED for storage
        // (restored on reload via the persisted map); `displayContent` is what the
        // user sees. Mirrors directChat's end-of-stream content_replace.
        { const _tail = _untok.flush(); if (_tail) send('content', { text: _tail }); }
        let displayContent = fullContent;
        {
            const { restoreTokens } = require('../../core/piiDetection');
            const _mergedMap = {
                ...(dlpRunner.getConversationTokenMap(notebookId) || {}),
                ...(docPiiTokenMap || {}),
                ...(piiTokenMap || {}),
            };
            if (Object.keys(_mergedMap).length) {
                const restored = restoreTokens(fullContent, _mergedMap);
                if (restored !== fullContent) { displayContent = restored; send('content_replace', { text: restored }); }
            }
        }

        // ── Assistant "Privacy protection" panel (parity with directChat) ──
        // For Legal/Notebook the PII almost always comes from the SOURCES (doc/KB/
        // tool scans), not the user's chat line — so input PII rarely fires. The
        // tokens the model echoed from those sources are restored for display by
        // `_untok`; surface exactly those (token → real) so the user can SEE what
        // was tokenised. Falls back to the notebook vault's protected-state badge.
        // Skipped when input PII already populated the panel above.
        try {
            if (!_assistantTokenisationInfo) {
                const replaced = (_untok && typeof _untok.getReplacedTokens === 'function') ? _untok.getReplacedTokens() : null;
                if (replaced && replaced.size > 0) {
                    let restoredCount = 0;
                    for (const [, info] of replaced) restoredCount += info.count || 0;
                    // Show the FULL notebook map so the panel's TOKEN MAPPING lists
                    // EVERY value tokenised in this dossier (sources + document +
                    // chat), not just the few echoed in this reply — the user asked
                    // to see all converted values, not only the chat ones.
                    const convMap = dlpRunner.getConversationTokenMap(notebookId) || {};
                    const tokenMap = Object.keys(convMap).length
                        ? { ...convMap }
                        : Object.fromEntries([...replaced].map(([t, i]) => [t, i.value]));
                    const catSet = new Set();
                    for (const tok of Object.keys(tokenMap)) { const mm = /^\[([a-z0-9_]+)_\d+\]$/.exec(tok); if (mm) catSet.add(mm[1]); }
                    _assistantTokenisationInfo = {
                        source: 'restored', action: 'restore', count: Object.keys(tokenMap).length,
                        restoredCount, categories: [...catSet], provider: modelId || null, automatic: true, tokenMap,
                    };
                    send('tokenisation_info', _assistantTokenisationInfo);
                } else {
                    const convMap = dlpRunner.getConversationTokenMap(notebookId) || {};
                    const convEntries = Object.entries(convMap);
                    if (convEntries.length > 0) {
                        const catSet = new Set();
                        for (const [tok] of convEntries) { const m = /^\[([a-z0-9_]+)_\d+\]$/.exec(tok); if (m) catSet.add(m[1]); }
                        _assistantTokenisationInfo = {
                            source: 'conversation_vault', action: 'protected', count: convEntries.length,
                            categories: [...catSet], provider: modelId || null, automatic: true,
                            tokenMap: Object.fromEntries(convEntries),
                        };
                        send('tokenisation_info', _assistantTokenisationInfo);
                    }
                }
            }
        } catch (_) { /* the panel is best-effort — never break the turn */ }

        // ── Re-restore the AI-written document against the COMPLETE map ──────
        // The mid-turn notebook_doc_* write restored tokens using whatever map
        // existed at that instant. Source/KB/tool tokens minted later this turn
        // would leave the saved document with raw `[person_5]`/`[email]1` even
        // though they are now mapped (the chat reply, restored at end of turn,
        // already shows them real — this brings the document to parity). Re-run
        // the drift-tolerant restore on the TOKEN-space mirror with the final
        // (hydrated) map and re-persist + re-emit only when it actually changed.
        if (_docWritten) {
            try {
                const { restoreTokensInRichText } = require('../../core/piiDetection');
                const _finalMap = (await dlpRunner.getConversationTokenMapAsync(notebookId).catch(() => null))
                    || dlpRunner.getConversationTokenMap(notebookId) || {};
                if (Object.keys(_finalMap).length) {
                    const realHtml = restoreTokensInRichText(currentDocContent, _finalMap);
                    const realMd = currentDocMd != null ? restoreTokensInRichText(currentDocMd, _finalMap) : null;
                    const prev = await notebookStore.getNotebook(notebookId, userId).catch(() => null);
                    if (prev && typeof realHtml === 'string' && prev.documentContent !== realHtml) {
                        await notebookStore.updateNotebook(notebookId, userId, {
                            documentContent: realHtml,
                            ...(realMd != null ? { documentMd: realMd } : {}),
                        }).catch(e => console.error('[NotebookChat] end-of-turn doc re-restore persist failed:', e.message));
                        send('notebook_doc_update', { content: realHtml });
                        console.warn('[NotebookChat] 🔓 Document re-restored against final token map');
                    }
                }
            } catch (e) {
                console.warn('[NotebookChat] end-of-turn doc re-restore failed:', e.message);
            }
        }

        // ── Output Regex Guardrails (agentOutput scope) ──────────────────
        // Check the model's response for guardrail violations; apply redaction
        // or warning. Mirrors directChat.js:3753. Runs against the RESTORED text
        // (displayContent) — regex rules match real values, not `[person_1]`.
        if (regexConfig?.enabled && regexConfig?.scope?.agentOutput && displayContent) {
            const outputMatches = checkRegexPatterns(displayContent, regexConfig.rulesWithNames);
            if (outputMatches.length > 0) {
                const ruleNames = outputMatches.map(m => m.ruleName).join(', ');
                console.log(`[NotebookChat RegexGuard] Output violated rules: ${ruleNames}, action: ${regexConfig.action}`);

                if (regexConfig.action === 'redact') {
                    // Redact the output
                    let redactedOutput = displayContent;
                    for (const rule of regexConfig.rulesWithNames) {
                        try {
                            const regex = new RegExp(rule.pattern, 'gi');
                            redactedOutput = redactedOutput.replace(regex, `[REDACTED: ${rule.name}]`);
                        } catch (e) { /* skip invalid patterns */ }
                    }
                    send('content_redact', {
                        originalMessage: displayContent.slice(0, 500),
                        redactedMessage: redactedOutput.slice(0, 500),
                        rules: ruleNames,
                        autoRedactSeconds: 5
                    });
                    guardrailEventStore.logGuardrailEvent({
                        organization_id: userOrgForTiers || null,
                        user_id: userId || null,
                        conversation_id: notebookId || null,
                        violation_type: 'regex',
                        violation_categories: ruleNames,
                        direction: 'output',
                        action_taken: 'redacted',
                        source: 'notebook',
                    }).catch(() => {});
                } else {
                    // Block: emit violation warning
                    send('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5 });
                    guardrailEventStore.logGuardrailEvent({
                        organization_id: userOrgForTiers || null,
                        user_id: userId || null,
                        conversation_id: notebookId || null,
                        violation_type: 'regex',
                        violation_categories: ruleNames,
                        direction: 'output',
                        action_taken: 'blocked',
                        source: 'notebook',
                    }).catch(() => {});
                }
            }
        }

        // Never end a notebook turn with a silent empty bubble. The reasoningEffort
        // fix above prevents the common "thinking consumed the whole budget" case;
        // if content is still empty (and no doc edit was made), emit a clear
        // fallback so the message finalizes instead of hanging on "Thinking…"
        // (BFSF-177).
        if (!fullContent || !fullContent.trim()) {
            const _fallback = "I couldn't produce a response for that. Please try rephrasing your request.";
            send('content', { text: _fallback });
            fullContent = _fallback;
        }

        // ── Persist the turn (audit-grade, encrypted) ──────────────────────
        // In-notebook chat — for regular notebooks AND legal_matter dossiers —
        // is now durable: the user message + final assistant answer are appended
        // to the encrypted notebook_conversations blob so the conversation
        // survives a refresh / notebook switch / restart. This is the Dutch-law
        // drafting record for legal matters. Best-effort: a persist failure must
        // never break the response the user just received.
        try {
            const encryptionKey = req.session?.encryptionKey || null;
            const nowIso = new Date().toISOString();
            const userContent = typeof message === 'string' ? message : String(message ?? '');
            const attachmentNames = Array.isArray(attachments)
                ? attachments.map(a => a?.name || a?.filename).filter(Boolean)
                : [];
            // Persist the privacy metadata alongside the turn so the redacted
            // badge + "Privacy protection" panel render identically after a
            // refresh (the blob is JSON, so these extra fields round-trip; GET
            // /conversation returns them and the client reads them). Assistant
            // `content` stays TOKENISED here and is restored on load via the
            // persisted notebook token map (mirrors directChat).
            const userMsg = {
                role: 'user',
                content: userContent,
                createdAt: nowIso,
                ...(attachmentNames.length ? { attachments: attachmentNames } : {}),
            };
            if (piiTokenMap && Object.keys(piiTokenMap).length) {
                userMsg.piiTokenizedCount = Object.keys(piiTokenMap).length;
                userMsg.piiCategories = _userPiiCategories;
            }
            const assistantMsg = { role: 'assistant', content: fullContent || '', createdAt: nowIso, modelId, modelTier };
            if (_assistantTokenisationInfo) assistantMsg.tokenisationInfo = _assistantTokenisationInfo;
            const turn = [userMsg, assistantMsg];
            await notebookConversationStore.appendMessages(notebookId, userId, encryptionKey, turn);
        } catch (persistErr) {
            console.error('[NotebookChat] conversation persist failed:', persistErr.message);
        }

        send('done', {});
        res.end();

    } catch (err) {
        console.error('[NotebookChat] Error:', err);
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

module.exports = router;
