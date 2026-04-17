/**
 * Browser Agent Loop — Claude agent loop for the Chrome extension.
 *
 * The user types a message in the side panel. We call Claude with the
 * browser tool set, it returns tool_use blocks, we dispatch them to the
 * extension (which executes them via CDP + content script), feed the
 * results back, and loop until Claude returns no more tool_use.
 *
 * Safety: no send_email tool, no browser_navigate. Draft-only by design.
 * The extension also guards every mutating tool with a fresh URL check
 * (background/cdp.js#guardGmail).
 */

const llmClient = require('../core/llmClient');
const { BROWSER_TOOLS, executeBrowserTool } = require('../integrations/browserTools');

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_ITERATIONS = 15;

const SYSTEM_PROMPT = `You are the BeeFlow Gmail assistant. You operate on the user's live Gmail page via a Chrome extension.

Tools you have:
- browser_read_page: Read the accessibility tree of the page. Scope with rootRef or rootSelector to keep snapshots small.
- browser_find: Locate an element by natural-language description. Returns a ref ID.
- browser_click, browser_type, browser_key, browser_scroll: Interact with elements via ref IDs.
- browser_screenshot: Last-resort visual fallback when the a11y tree is ambiguous.
- gmail_expand_thread, gmail_compose_reply, gmail_save_draft: Gmail-specific shortcuts.

Rules:
1. Start by calling browser_read_page to orient yourself. Prefer a scoped read (rootSelector: 'div[role="main"]').
2. Prefer the accessibility tree over screenshots — it is cheaper, faster, and more reliable.
3. You can only save drafts. You cannot send mail. If the user asks you to "send", explain that you can only draft — they must click Send themselves.
4. Before any click/type on a different thread, re-read the page so you have fresh ref IDs.
5. When drafting replies, keep them concise and match the user's typical tone unless instructed otherwise.
6. If a tool returns { error: "tab_changed" }, the user navigated away from Gmail — stop and ask them to go back.
7. When you're finished, stop calling tools and summarise what you did.`;

/**
 * Run one turn of the browser agent loop.
 *
 * @param {object} opts
 * @param {string} opts.userId            - The authenticated user id
 * @param {string} opts.message           - User's natural-language instruction
 * @param {string} [opts.conversationId]  - For persisting history (future; unused today)
 * @param {object} [opts.context]         - Free-form context (e.g. current thread subject)
 * @param {object} opts.session           - req.session (for org id, oauth tokens)
 * @param {object} opts.dispatch          - { sendEvent, dispatchToExtension }
 * @param {AbortController} opts.abortController
 */
async function runBrowserAgentLoop({
    userId,
    message,
    conversationId: _conversationId,
    context = {},
    session,
    dispatch,
    abortController,
}) {
    const { sendEvent } = dispatch;
    const orgId = session?.user?.organizationId || session?.organizationId || null;

    const systemPrompt = SYSTEM_PROMPT + (context.threadSummary
        ? `\n\nCurrent Gmail context: ${JSON.stringify(context).slice(0, 1500)}`
        : '');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
    ];

    const tools = BROWSER_TOOLS.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        },
    }));

    sendEvent('start', { model: DEFAULT_MODEL });

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        if (abortController.signal.aborted) {
            sendEvent('aborted', {});
            return;
        }

        let result;
        try {
            result = await llmClient.chat(DEFAULT_MODEL, messages, {
                tools,
                toolChoice: 'auto',
                maxTokens: 4000,
                temperature: 0.3,
            });
        } catch (err) {
            console.error('[BrowserAgent] model error:', err.message);
            sendEvent('error', { error: `model_error: ${err.message}` });
            return;
        }

        const assistantText = result.content || '';
        const toolCalls = result.toolCalls || [];

        if (assistantText) sendEvent('text', { text: assistantText });

        // No more tool calls → agent is done
        if (toolCalls.length === 0) {
            sendEvent('done', { iterations: iteration + 1 });
            return;
        }

        // Record the assistant turn with tool_calls so the next iteration can
        // reference them via tool_call_id on the tool_result messages.
        messages.push({
            role: 'assistant',
            content: assistantText,
            tool_calls: toolCalls,
        });

        // Execute tool calls sequentially. The extension can only run one CDP
        // command at a time, and sequential execution is easier to reason about
        // for error recovery.
        for (const tc of toolCalls) {
            if (abortController.signal.aborted) {
                sendEvent('aborted', {});
                return;
            }

            const toolName = tc.function.name;
            let input;
            try {
                input = typeof tc.function.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : (tc.function.arguments || {});
            } catch {
                input = {};
            }

            sendEvent('tool_use', { id: tc.id, name: toolName, input });

            let toolResult;
            try {
                toolResult = await executeBrowserTool(toolName, input, { userId, orgId });
            } catch (err) {
                toolResult = { error: err.message };
            }

            // Truncate large tool results before sending to the client so the
            // side panel UI never has to render a 30 KB a11y tree.
            const summary = summariseResult(toolName, toolResult);
            sendEvent('tool_result', { id: tc.id, name: toolName, summary });

            // Feed the FULL result back to the model.
            messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: JSON.stringify(toolResult).slice(0, 60_000),
            });
        }
    }

    sendEvent('done', { reason: 'max_iterations', iterations: MAX_ITERATIONS });
}

function summariseResult(toolName, result) {
    if (!result || typeof result !== 'object') return { ok: true };
    if (result.error) return { error: result.error };

    switch (toolName) {
        case 'browser_read_page':
            return {
                ok: true,
                url: result.url,
                title: result.title,
                truncated: result.truncated,
                nodeCount: countNodes(result.tree),
            };
        case 'browser_find':
            return { ok: true, ref: result.ref, reason: result.reason };
        case 'browser_screenshot':
            return { ok: true, bytes: (result.imageBase64 || '').length };
        case 'gmail_save_draft':
            return { ok: !!result.ok, message: 'Draft saved (user must send manually)' };
        default:
            return { ok: result.ok !== false };
    }
}

function countNodes(node) {
    if (!node) return 0;
    return 1 + (node.children || []).reduce((s, c) => s + countNodes(c), 0);
}

module.exports = { runBrowserAgentLoop };
