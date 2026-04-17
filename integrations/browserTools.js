/**
 * Browser tools — the tool definitions the server-side Claude agent calls
 * to interact with the live Gmail page through the Chrome extension.
 *
 * Each tool handler dispatches a job to the connected extension session via
 * routes/browserAgent.dispatchToolCall(), then awaits the result.
 *
 * The extension (background/channel.js) receives the job, routes it to
 * background/cdp.js or a content-script message, and POSTs the result back.
 *
 * Tool set is intentionally Gmail-scoped. There is no browser_navigate or
 * send_email tool — the agent can only save drafts.
 */

const llmClient = require('../core/llmClient');
const { dispatchToolCall, isExtensionConnected } = require('../routes/browserAgent');

// ── Tool schemas (OpenAI function-calling format, normalised by Claude provider) ──

const BROWSER_TOOLS = [
    {
        name: 'browser_read_page',
        description: 'Read the accessibility tree of the current Gmail page (or a sub-tree). Returns a JSON tree of roles, names, values and ref IDs. Use rootRef to scope to a specific element, or rootSelector for a CSS role selector. Prefer scoping to avoid huge trees.',
        parameters: {
            type: 'object',
            properties: {
                rootRef: { type: 'number', description: 'Ref ID returned by a previous call to scope the snapshot.' },
                rootSelector: { type: 'string', description: 'ARIA-role–based CSS selector to scope the snapshot, e.g. div[role="main"].' },
                maxChars: { type: 'number', description: 'Token budget for the tree (default 20000). Reduce if the tree is truncated.' },
            },
        },
    },
    {
        name: 'browser_find',
        description: 'Find an element on the page by natural-language description, e.g. "the Reply button for the first email". Returns a ref ID you can pass to browser_click or browser_type. Use scopeRef to narrow search.',
        parameters: {
            type: 'object',
            required: ['description'],
            properties: {
                description: { type: 'string', description: 'Natural-language description of the element to find.' },
                scopeRef: { type: 'number', description: 'Ref ID to scope the search.' },
            },
        },
    },
    {
        name: 'browser_click',
        description: 'Click an element identified by its ref ID.',
        parameters: {
            type: 'object',
            required: ['ref'],
            properties: {
                ref: { type: 'number', description: 'Ref ID of the element to click.' },
            },
        },
    },
    {
        name: 'browser_type',
        description: 'Type text into a focused or identified element. Appends to existing content unless clearFirst is true.',
        parameters: {
            type: 'object',
            required: ['text'],
            properties: {
                ref: { type: 'number', description: 'Ref ID of the input element (optional — types at current focus if omitted).' },
                text: { type: 'string', description: 'Text to type.' },
                clearFirst: { type: 'boolean', description: 'Select-all + delete before typing (default false).' },
            },
        },
    },
    {
        name: 'browser_key',
        description: 'Send a keyboard chord, e.g. "ctrl+enter", "Escape", "shift+Tab".',
        parameters: {
            type: 'object',
            required: ['keys'],
            properties: {
                keys: { type: 'string', description: 'Space-separated chord, e.g. "ctrl+enter".' },
            },
        },
    },
    {
        name: 'browser_scroll',
        description: 'Scroll the page or a specific element.',
        parameters: {
            type: 'object',
            properties: {
                ref: { type: 'number', description: 'Ref ID of element to scroll (defaults to the page).' },
                direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction.' },
                amount: { type: 'number', description: 'Pixels to scroll (default 300).' },
            },
        },
    },
    {
        name: 'browser_screenshot',
        description: 'Take a screenshot of the current page (JPEG, base64). Use sparingly — only when the accessibility tree is ambiguous.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'gmail_expand_thread',
        description: 'Expand all collapsed messages in the currently open Gmail thread so their full bodies appear in the accessibility tree.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'gmail_compose_reply',
        description: 'Open Gmail\'s Reply (or Reply-all) compose window for the currently open thread. Returns a composeRef pointing to the compose body so you can type into it.',
        parameters: {
            type: 'object',
            properties: {
                replyAll: { type: 'boolean', description: 'Open Reply-all instead of Reply (default: auto-detect based on participant count).' },
            },
        },
    },
    {
        name: 'gmail_save_draft',
        description: 'Insert HTML body text into an open compose window. Gmail auto-saves as a draft. The user reviews and sends manually — this tool never sends mail.',
        parameters: {
            type: 'object',
            required: ['bodyHtml'],
            properties: {
                composeRef: { type: 'number', description: 'Ref ID of the compose body returned by gmail_compose_reply (optional — uses the currently focused compose if omitted).' },
                bodyHtml: { type: 'string', description: 'HTML content for the draft body.' },
            },
        },
    },
];

// ── Handler implementations ────────────────────────────────────────────────

async function handleBrowserReadPage(userId, input) {
    return dispatchToolCall(userId, 'browser_read_page', {
        rootRef: input.rootRef,
        rootSelector: input.rootSelector || 'div[role="main"]',
        maxChars: input.maxChars || 20000,
    });
}

async function handleBrowserFind(userId, input, orgId) {
    // 1. Get a11y snapshot (scoped if scopeRef provided)
    const snap = await dispatchToolCall(userId, 'browser_read_page', {
        rootRef: input.scopeRef,
        rootSelector: input.scopeRef ? undefined : 'div[role="main"]',
        maxChars: 10000,
    });

    if (snap.error) return { error: snap.error };

    // 2. Small nested model call to locate the element by description.
    //    Haiku 4.5 is fast and cheap for this.
    const FIND_MODEL = 'claude-haiku-4-5-20251001';
    const treeText = JSON.stringify(snap.tree, null, 0);
    const prompt = `You are given an accessibility tree of a Gmail page as compact JSON.
Find the element that best matches this description: "${input.description}"
Return ONLY a JSON object with a single field "ref" set to the ref number of the matching element.
If no element matches, return {"ref": null, "reason": "<short explanation>"}.

Accessibility tree:
${treeText.slice(0, 8000)}`;

    try {
        const result = await llmClient.chat(FIND_MODEL, [
            { role: 'user', content: prompt }
        ], { maxTokens: 200, temperature: 0 });

        const text = result.content || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { error: 'find_model_no_json' };
        const parsed = JSON.parse(jsonMatch[0]);
        return { ref: parsed.ref, reason: parsed.reason || undefined };
    } catch (err) {
        return { error: `find_model_error: ${err.message}` };
    }
}

async function handleBrowserClick(userId, input) {
    // First resolve geometry in the content script, then dispatch CDP click
    const geo = await dispatchToolCall(userId, 'a11y_resolve_ref', { ref: input.ref });
    if (geo?.error) return { error: geo.error };
    return dispatchToolCall(userId, 'cdp_click', { x: geo.geometry.x, y: geo.geometry.y });
}

async function handleBrowserType(userId, input) {
    if (input.ref) {
        const geo = await dispatchToolCall(userId, 'a11y_resolve_ref', { ref: input.ref });
        if (geo?.error) return { error: geo.error };
        // Click to focus first
        await dispatchToolCall(userId, 'cdp_click', { x: geo.geometry.x, y: geo.geometry.y });
    }
    if (input.clearFirst) {
        await dispatchToolCall(userId, 'cdp_key', { keys: 'ctrl+a' });
        await dispatchToolCall(userId, 'cdp_key', { keys: 'Delete' });
    }
    return dispatchToolCall(userId, 'cdp_type', { text: input.text });
}

async function handleBrowserKey(userId, input) {
    return dispatchToolCall(userId, 'cdp_key', { keys: input.keys });
}

async function handleBrowserScroll(userId, input) {
    const direction = input.direction || 'down';
    const amount = input.amount || 300;
    const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
    const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;

    if (input.ref) {
        const geo = await dispatchToolCall(userId, 'a11y_resolve_ref', { ref: input.ref });
        if (geo?.error) return { error: geo.error };
        return dispatchToolCall(userId, 'cdp_scroll', { x: geo.geometry.x, y: geo.geometry.y, deltaX, deltaY });
    }
    return dispatchToolCall(userId, 'cdp_scroll', { x: 400, y: 400, deltaX, deltaY });
}

async function handleBrowserScreenshot(userId) {
    return dispatchToolCall(userId, 'cdp_screenshot', {});
}

async function handleGmailExpandThread(userId) {
    return dispatchToolCall(userId, 'gmail_expand_thread', {});
}

async function handleGmailComposeReply(userId, input) {
    return dispatchToolCall(userId, 'gmail_compose_reply', { replyAll: input.replyAll });
}

async function handleGmailSaveDraft(userId, input) {
    return dispatchToolCall(userId, 'gmail_save_draft', {
        composeRef: input.composeRef,
        bodyHtml: input.bodyHtml,
    });
}

// ── Router: dispatch to handler by tool name ───────────────────────────────

const HANDLERS = {
    browser_read_page: handleBrowserReadPage,
    browser_click: handleBrowserClick,
    browser_type: handleBrowserType,
    browser_key: handleBrowserKey,
    browser_scroll: handleBrowserScroll,
    browser_screenshot: handleBrowserScreenshot,
    gmail_expand_thread: handleGmailExpandThread,
    gmail_compose_reply: handleGmailComposeReply,
    gmail_save_draft: handleGmailSaveDraft,
};

async function executeBrowserTool(toolName, input, { userId, orgId }) {
    if (!isExtensionConnected(userId)) {
        return { error: 'Extension not connected. Open the BeeFlow side panel on Gmail.' };
    }

    if (toolName === 'browser_find') {
        return handleBrowserFind(userId, input, orgId);
    }

    const handler = HANDLERS[toolName];
    if (!handler) return { error: `Unknown browser tool: ${toolName}` };

    try {
        return await handler(userId, input);
    } catch (err) {
        const code = err.code || 'tool_error';
        console.error(`[BrowserTools] ${toolName} failed (${code}):`, err.message);
        return { error: `${code}: ${err.message}` };
    }
}

module.exports = { BROWSER_TOOLS, executeBrowserTool };
