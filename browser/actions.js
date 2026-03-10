/**
 * Browser Agent — Action Execution, Retries & Cookie Consent
 *
 * Supports elementId resolution: when a tool call provides { elementId: "btn_3" },
 * we resolve it via the coordinator's elementMap to get the CSS selector and frame.
 */

const { ACTION_TIMEOUTS } = require('./constants');
const { createElementMap, getStructuredObservation } = require('./observation');

// ─── Smart Page Stability Waiting ────────────────────────────────────────────

/**
 * Wait until the page is "stable" — no pending network requests and DOM
 * text content has stopped changing.  Works for SPAs, chatbot responses,
 * AJAX-loaded content, streaming responses, etc.
 *
 * Strategy:
 *  1. Track in-flight network requests (fetch/XHR/doc).
 *  2. Poll DOM body text length every 400ms.
 *  3. Page is stable when: network has been idle for 500ms AND DOM text
 *     hasn't changed for one poll interval.
 *  4. Hard cap of `maxWait` ms (default 8s) to avoid hanging forever.
 */
async function waitForPageStable(page, { maxWait = 8000, networkQuietMs = 500, pollInterval = 400 } = {}) {
    const start = Date.now();
    let inflight = 0;
    let networkIdleSince = Date.now();
    let lastTextLength = -1;
    let domStableSince = 0;

    // Track network requests
    const onRequest = () => { inflight++; networkIdleSince = 0; };
    const onDone = () => {
        inflight = Math.max(0, inflight - 1);
        if (inflight === 0) networkIdleSince = Date.now();
    };

    page.on('request', onRequest);
    page.on('requestfinished', onDone);
    page.on('requestfailed', onDone);

    // Snapshot initial network idle time
    if (inflight === 0) networkIdleSince = Date.now();

    try {
        while (Date.now() - start < maxWait) {
            await page.waitForTimeout(pollInterval);

            // Check DOM stability
            let textLen = 0;
            try {
                textLen = await page.evaluate(() => document.body?.innerText?.length || 0);
            } catch (e) { break; } // page navigated away or crashed

            if (textLen === lastTextLength && textLen > 0) {
                if (!domStableSince) domStableSince = Date.now();
            } else {
                domStableSince = 0;
                lastTextLength = textLen;
            }

            // Stable when: network quiet for networkQuietMs AND DOM stable for one interval
            const networkQuiet = inflight === 0 && networkIdleSince > 0 && (Date.now() - networkIdleSince >= networkQuietMs);
            const domStable = domStableSince > 0 && (Date.now() - domStableSince >= pollInterval);

            if (networkQuiet && domStable) {
                const elapsed = Date.now() - start;
                if (elapsed > 600) { // Only log if we actually waited meaningful time
                    console.log(`[BrowserAgent] ⏱ Page stable after ${elapsed}ms (network idle + DOM stable)`);
                }
                return;
            }
        }
        console.log(`[BrowserAgent] ⏱ Page stability timeout after ${maxWait}ms (inflight: ${inflight})`);
    } finally {
        page.removeListener('request', onRequest);
        page.removeListener('requestfinished', onDone);
        page.removeListener('requestfailed', onDone);
    }
}

// ─── Element ID Resolution ───────────────────────────────────────────────────

/**
 * Resolve an elementId to a Playwright locator.
 * Returns { locator, frameCtx } or throws if not found.
 */
function resolveElementId(page, elementId, elementMap) {
    if (!elementMap || !elementMap.has(elementId)) {
        throw new Error(`Element "${elementId}" not found. Call observe() first to refresh the element map.`);
    }
    const entry = elementMap.get(elementId);
    let ctx = page;

    // If the element is in an iframe, get the right frame context
    if (entry.frameIndex && entry.frameIndex > 0) {
        const frames = page.frames().filter(f => f !== page.mainFrame());
        const frame = frames[entry.frameIndex - 1];
        if (!frame) {
            throw new Error(`Frame ${entry.frameIndex} for element "${elementId}" is no longer available.`);
        }
        ctx = frame;
    }

    return { locator: ctx.locator(entry.selector).first(), frameCtx: ctx, entry };
}

// ─── Action Execution with Retries ───────────────────────────────────────────

async function executeWithRetries(page, actionName, args, onEvent, config, step, maxSteps, screenshotStreaming, elementMap, maxRetries = 1, retryEscalation = true) {
    // Per-action timeout from map
    const actionTimeout = ACTION_TIMEOUTS[actionName] || 5000;

    // Actions that shouldn't be retried — fail fast
    const NO_RETRY_ACTIONS = new Set(['wait', 'observe', 'extract_text', 'scroll', 'press_key', 'go_back', 'take_screenshot']);
    const effectiveRetries = NO_RETRY_ACTIONS.has(actionName) ? 0 : maxRetries;
    let lastError = null;

    const actionStart = Date.now();

    for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
        let currentArgs = { ...args };
        let currentMethod = args.method || 'css';

        // Escalation on retries for click actions (only when NOT using elementId)
        if (attempt > 0 && retryEscalation && actionName === 'click' && !args.elementId) {
            if (currentMethod === 'css') {
                currentArgs = { ...args, method: 'text' };
                currentMethod = 'text';
                console.log(`[BrowserAgent] Retry ${attempt}: escalating click to text method`);
            }
        }

        const result = await executeBrowserAction(page, actionName, currentArgs, onEvent, config, step, maxSteps, screenshotStreaming, elementMap, attempt, actionTimeout);

        if (!result.error) {
            console.log(`[BrowserAgent] ⏱ ${actionName} completed in ${Date.now() - actionStart}ms`);
            return result;
        }

        lastError = result.error;
        console.log(`[BrowserAgent] Action "${actionName}" attempt ${attempt + 1} failed (${Date.now() - actionStart}ms): ${lastError}`);

        // Fast-fail: don't retry visibility/not-found errors — they won't resolve on retry
        if (lastError.includes('not visible') || lastError.includes('not found') ||
            lastError.includes('No elements match') || lastError.includes('strict mode violation') ||
            lastError.includes('Element "')) {
            break;
        }
    }

    console.log(`[BrowserAgent] ⏱ ${actionName} FAILED in ${Date.now() - actionStart}ms`);
    return { error: lastError, retriesExhausted: true };
}

// ─── Single Action Executor ──────────────────────────────────────────────────

async function executeBrowserAction(page, actionName, args, onEvent, config, step, maxSteps, screenshotStreaming, elementMap, attempt = 0, actionTimeout = 5000) {
    const isRetry = attempt > 0;

    try {
        switch (actionName) {
            case 'navigate': {
                if (!isRetry) onEvent('browser_action', { action: 'navigate', params: args, step, maxSteps, message: `Navigating to ${args.url}` });
                await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: actionTimeout });
                // Wait for dynamic content to finish loading
                await waitForPageStable(page);
                // Auto-dismiss cookie consent overlays on new pages
                await autoDismissConsent(page);
                const newUrl = page.url();
                const newTitle = await page.title();
                return { success: true, url: newUrl, title: newTitle };
            }

            case 'click': {
                // ── ElementId path (preferred) ──
                if (args.elementId) {
                    const label = args.elementId;
                    if (!isRetry) onEvent('browser_action', { action: 'click', params: { elementId: label }, step, maxSteps, message: `Clicking element [${label}]` });

                    try {
                        const { locator, entry } = resolveElementId(page, args.elementId, elementMap);
                        const urlBefore = page.url();
                        await locator.click({ timeout: actionTimeout });
                        await waitForPageStable(page);
                        const urlAfter = page.url();
                        return {
                            success: true,
                            clicked: `[${label}] ${entry.name || entry.selector}`,
                            urlChanged: urlBefore !== urlAfter,
                            url: urlAfter,
                            title: await page.title()
                        };
                    } catch (eIdErr) {
                        // If elementId fails and we have a selector fallback in the map entry, try it
                        console.warn(`[BrowserAgent] elementId "${label}" failed: ${eIdErr.message}`);
                        return { error: eIdErr.message };
                    }
                }

                // ── Legacy selector/text/role path ──
                const method = args.method || 'css';
                if (!isRetry) onEvent('browser_action', { action: 'click', params: { ...args, method }, step, maxSteps, message: `Clicking "${args.selector || args.name || ''}" (${method})` });

                // Build locator for a given frame/page context
                function buildLocator(ctx) {
                    if (method === 'text') {
                        return ctx.getByText(args.selector, { exact: false }).first();
                    } else if (method === 'role') {
                        const role = args.role || 'button';
                        const nameOpt = args.name ? { name: args.name, exact: false } : {};
                        return ctx.getByRole(role, nameOpt).first();
                    } else {
                        return ctx.locator(args.selector).first();
                    }
                }

                const urlBefore = page.url();

                // Try main frame first
                let clicked = false;
                try {
                    const locator = buildLocator(page);
                    await locator.click({ timeout: actionTimeout });
                    clicked = true;
                } catch (mainErr) {
                    // If main frame click failed, try child frames (cookie consent iframes etc.)
                    const frames = page.frames();
                    for (const frame of frames) {
                        if (frame === page.mainFrame()) continue;
                        try {
                            const frameLoc = buildLocator(frame);
                            const count = await frameLoc.count();
                            if (count > 0) {
                                await frameLoc.click({ timeout: Math.min(actionTimeout, 2000) });
                                clicked = true;
                                console.log(`[BrowserAgent] Clicked "${args.selector || args.name}" in iframe: ${frame.url()}`);
                                break;
                            }
                        } catch (frameErr) { /* try next frame */ }
                    }
                    if (!clicked) throw mainErr; // Re-throw original error
                }

                // Wait for page to stabilize after click
                await waitForPageStable(page);

                const urlAfter = page.url();
                const titleAfter = await page.title();
                return {
                    success: true,
                    clicked: args.selector || args.name || '',
                    urlChanged: urlBefore !== urlAfter,
                    url: urlAfter,
                    title: titleAfter
                };
            }

            case 'type_text': {
                let locator;
                let label;

                // ── ElementId path (preferred) ──
                if (args.elementId) {
                    const resolved = resolveElementId(page, args.elementId, elementMap);
                    locator = resolved.locator;
                    label = `[${args.elementId}] ${resolved.entry.name || resolved.entry.selector}`;
                } else {
                    locator = page.locator(args.selector).first();
                    label = args.selector;
                }

                if (!isRetry) onEvent('browser_action', { action: 'type', params: args, step, maxSteps, message: `Typing into "${label}"` });
                await locator.waitFor({ state: 'visible', timeout: actionTimeout });
                // Click to focus/activate the input first (some inputs need this)
                try { await locator.click({ timeout: 2000 }); } catch (e) { /* focus via click failed, continue anyway */ }
                if (args.clear !== false) {
                    await locator.fill('', { timeout: actionTimeout });
                }
                await locator.fill(args.text, { timeout: actionTimeout });
                // Read back value to verify
                const actualValue = await locator.inputValue().catch(() => null);
                return {
                    success: true,
                    typed: `${args.text.length} chars into ${label}`,
                    verified: actualValue === args.text
                };
            }

            case 'scroll': {
                const amount = args.amount || 500;
                const delta = args.direction === 'up' ? -amount : amount;
                if (!isRetry) onEvent('browser_action', { action: 'scroll', params: { ...args, amount }, step, maxSteps, message: `Scrolling ${args.direction}` });
                await page.mouse.wheel(0, delta);
                await page.waitForTimeout(150);
                return { success: true, scrolled: `${args.direction} by ${amount}px` };
            }

            case 'extract_text': {
                if (!isRetry) onEvent('browser_action', { action: 'extract', params: args, step, maxSteps, message: 'Extracting text...' });
                // Use page.evaluate with textContent for full DOM text (not viewport-dependent)
                const extractedText = await page.evaluate((selector) => {
                    let el;
                    if (selector) {
                        el = document.querySelector(selector);
                        if (!el) el = document.body; // Auto-fallback to full page
                    } else {
                        el = document.body;
                    }
                    // Clone and strip non-text elements
                    const clone = el.cloneNode(true);
                    clone.querySelectorAll('script, style, noscript, svg, link, meta').forEach(n => n.remove());
                    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
                }, args.selector || null);
                const MAX_EXTRACT = 15000;
                const result = { success: true, text: extractedText.slice(0, MAX_EXTRACT), charCount: extractedText.length };
                if (extractedText.length > MAX_EXTRACT) {
                    result.note = 'Text was truncated to 15000 chars. This is the maximum — do NOT call extract_text again to get more.';
                } else {
                    result.note = 'Complete page text extracted. No need to extract again.';
                }
                return result;
            }

            case 'observe': {
                if (!isRetry) onEvent('browser_action', { action: 'observe', params: {}, step, maxSteps, message: 'Observing page structure...' });
                // Use the new createElementMap — returns elements with IDs
                const { observation, elementMap: newMap } = await createElementMap(page);

                // Build structured result for LLM — compact element list with IDs
                const elemList = observation.elements.map(el => {
                    let line = `[${el.id}] ${el.role} "${el.name || el.text}"`;
                    if (el.inputType) line += ` [${el.inputType}]`;
                    if (el.value) line += ` = "${el.value}"`;
                    if (el.href) line += ` → ${el.href}`;
                    if (el.selector) line += ` (${el.selector})`;
                    if (el.disabled) line += ' [disabled]';
                    if (el.frameIndex > 0) line += ` [frame ${el.frameIndex}]`;
                    return line;
                });

                return {
                    success: true,
                    url: observation.url,
                    title: observation.title,
                    headings: observation.headings.map(h => `${h.tag}: ${h.text}`),
                    elements: elemList,
                    alerts: observation.alerts,
                    contentPreview: observation.mainText.slice(0, 500),
                    iframes: observation.iframes,
                    _elementMap: newMap,         // Internal: stored on coordinator by orchestrator
                    _observation: observation    // Internal: cached observation for planner
                };
            }

            case 'take_screenshot': {
                if (!isRetry) onEvent('browser_action', { action: 'screenshot', params: args, step, maxSteps, message: 'Taking screenshot...' });
                const screenshot = await page.screenshot({ type: 'jpeg', quality: 30, fullPage: args.fullPage || false });
                if (screenshotStreaming) {
                    onEvent('browser_screenshot', { image: screenshot.toString('base64'), label: 'Page screenshot' });
                }
                return { success: true, screenshotTaken: true };
            }

            case 'wait': {
                if (args.selector) {
                    if (!isRetry) onEvent('browser_action', { action: 'wait', params: args, step, maxSteps, message: `Waiting for "${args.selector}"` });
                    const count = await page.locator(args.selector).count();
                    if (count > 0) {
                        await page.locator(args.selector).first().waitFor({ state: 'visible', timeout: actionTimeout });
                    } else {
                        await page.waitForSelector(args.selector, { state: 'visible', timeout: actionTimeout });
                    }
                } else {
                    const ms = Math.min(args.ms || 2000, 15000);
                    if (!isRetry) onEvent('browser_action', { action: 'wait', params: { ms }, step, maxSteps, message: `Waiting ${ms}ms` });
                    await page.waitForTimeout(ms);
                }
                return { success: true };
            }

            case 'go_back': {
                if (!isRetry) onEvent('browser_action', { action: 'go_back', params: {}, step, maxSteps, message: 'Going back' });
                await page.goBack({ waitUntil: 'domcontentloaded' });
                await waitForPageStable(page);
                return { success: true, url: page.url(), title: await page.title() };
            }

            case 'press_key': {
                const key = args.key || 'Enter';
                if (!isRetry) onEvent('browser_action', { action: 'press_key', params: args, step, maxSteps, message: `Pressing ${key}` });
                await page.keyboard.press(key);
                // Wait for potential navigation after Enter
                if (key === 'Enter') {
                    await waitForPageStable(page);
                } else {
                    await page.waitForTimeout(200);
                }
                return {
                    success: true,
                    pressed: key,
                    url: page.url(),
                    title: await page.title()
                };
            }

            default:
                return { error: `Unknown action: ${actionName}` };
        }
    } catch (err) {
        console.error(`[BrowserAgent] Action "${actionName}" failed:`, err.message);
        if (!isRetry) onEvent('browser_action', { action: actionName, params: args, step, maxSteps, error: err.message, message: `Action failed: ${err.message}` });
        // Include frame info in error for better replanning context
        let frameInfo = [];
        try { frameInfo = page.frames().filter(f => f !== page.mainFrame()).map(f => f.url()); } catch (e) { /* ignore */ }
        return {
            error: err.message,
            ...(frameInfo.length > 0 ? { iframes: frameInfo } : {})
        };
    }
}

// ─── Auto Cookie Consent Dismissal ─────────────────────────────────────────

// Track which URLs have already had consent dismissed
const _consentDismissedURLs = new Set();

/**
 * Auto-dismiss cookie consent dialogs and blocking overlays.
 * - Runs once per page URL (re-runs after navigation)
 * - 3s time cap
 * - Searches all frames including cross-origin consent iframes
 * - Broad button text matching for international sites
 */
async function autoDismissConsent(page) {
    const consentStart = Date.now();

    // Once per URL path (allows re-run after navigation to a new page)
    try {
        const urlKey = new URL(page.url()).origin + new URL(page.url()).pathname;
        if (_consentDismissedURLs.has(urlKey)) return;
        _consentDismissedURLs.add(urlKey);
    } catch (e) { return; }

    // Fast check: does the page have any consent-like overlay or iframe?
    try {
        const hasConsentDialog = await page.evaluate(() => {
            const selectors = [
                '[class*="consent"]', '[class*="cookie"]', '[id*="consent"]', '[id*="cookie"]',
                '[role="dialog"]', '[aria-modal="true"]', '.cc-banner', '.cc-window',
                '#onetrust-consent-sdk', '#CybotCookiebotDialog', '.didomi-popup',
                '.qc-cmp2-container', '[class*="popup"]', '[class*="overlay"]',
                '[class*="gdpr"]', '[class*="privacy"]'
            ];
            return selectors.some(s => document.querySelector(s) !== null);
        });

        const hasConsentFrame = page.frames().some(f => {
            const url = f.url();
            return url && (url.includes('consent') || url.includes('cookie') || url.includes('gdpr') || url.includes('privacy-mgmt'));
        });

        if (!hasConsentDialog && !hasConsentFrame) return;
    } catch (e) { return; }

    // Broad consent button texts — EN, NL, DE, FR + common patterns
    const CONSENT_TEXTS = [
        // English
        'Accept', 'Accept all', 'Accept All Cookies', 'I agree', 'Allow all',
        'Allow', 'Got it', 'OK', 'Continue', 'Close', 'Agree', 'Yes',
        'Allow all cookies', 'Accept & close', 'Agree and proceed',
        // Dutch
        'Accepteren', 'Alles accepteren', 'Akkoord', 'Doorgaan', 'Is goed',
        'Ik ga akkoord', 'Alle cookies accepteren', 'Ja', 'Sluiten',
        'Toestaan', 'Alles toestaan',
        // German
        'Alle akzeptieren', 'Akzeptieren', 'Zustimmen', 'Einverstanden',
        // French
        'Tout accepter', 'Accepter', "J'accepte", 'Continuer'
    ];

    const frames = page.frames();
    for (const text of CONSENT_TEXTS) {
        if (Date.now() - consentStart > 3000) {
            console.log(`[BrowserAgent] ⏱ Consent scan timed out after 3000ms`);
            return;
        }
        for (const frame of frames) {
            try {
                // Try button role first
                const btn = frame.getByRole('button', { name: text, exact: false });
                if (await btn.count() > 0 && await btn.first().isVisible({ timeout: 100 })) {
                    await btn.first().click({ timeout: 1500 });
                    console.log(`[BrowserAgent] ✅ Auto-dismissed consent (button): "${text}" in ${Date.now() - consentStart}ms`);
                    await page.waitForTimeout(300);
                    return;
                }
                // Try link role (many consent UIs use <a> tags)
                const link = frame.getByRole('link', { name: text, exact: false });
                if (await link.count() > 0 && await link.first().isVisible({ timeout: 100 })) {
                    await link.first().click({ timeout: 1500 });
                    console.log(`[BrowserAgent] ✅ Auto-dismissed consent (link): "${text}" in ${Date.now() - consentStart}ms`);
                    await page.waitForTimeout(300);
                    return;
                }
                // Try by exact text content (catches custom elements)
                const byText = frame.getByText(text, { exact: false });
                if (await byText.count() > 0 && await byText.first().isVisible({ timeout: 100 })) {
                    const tag = await byText.first().evaluate(el => el.tagName).catch(() => '');
                    if (['BUTTON', 'A', 'SPAN', 'DIV', 'INPUT'].includes(tag)) {
                        await byText.first().click({ timeout: 1500 });
                        console.log(`[BrowserAgent] ✅ Auto-dismissed consent (text): "${text}" in ${Date.now() - consentStart}ms`);
                        await page.waitForTimeout(300);
                        return;
                    }
                }
            } catch (e) { /* next */ }
        }
    }
    console.log(`[BrowserAgent] ⏱ Consent scan completed in ${Date.now() - consentStart}ms (nothing found)`);
}

module.exports = {
    executeWithRetries,
    executeBrowserAction,
    autoDismissConsent,
    resolveElementId,
    waitForPageStable
};
