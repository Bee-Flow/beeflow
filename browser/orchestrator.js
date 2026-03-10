/**
 * Browser Agent Runtime v2 — Coordinator Architecture
 * 
 * Architecture:
 *   Planner (LLM, low frequency) → produces milestones + strategy
 *   Executor (LLM + Playwright, high frequency) → executes actions following the plan
 *   Coordinator (deterministic) → detects stuck loops, triggers replanning, manages memory
 *
 * Key optimizations over v1:
 *   - Rolling message window (last N turns) + memory summary → bounded token use
 *   - Structured `observe()` tool → headings, buttons, forms, alerts instead of raw text
 *   - Conditional resource blocking (images/fonts/styles when screenshots off)
 *   - Proper getByRole usage for accessibility-based clicking
 *   - Click/type retries with method escalation
 *   - Structured tool results (URL changes, titles, form values)
 *   - Fail-fast: loop detection, repeated-action detection
 *   - Domain restriction fix (exact match or subdomain)
 *   - Password field redaction in page state
 *   - Proper Playwright auto-waits instead of random timeouts
 */

const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const browserAgentStore = require('../stores/browserAgentStore');

const { DEFAULTS, PAGE_CHANGING_ACTIONS, normalizeActionName } = require('./constants');
const { BROWSER_TOOLS } = require('./tools');
const { callLLM } = require('./llm');
const { createElementMap, captureAnnotatedScreenshot, getStructuredObservation, cheapSignature } = require('./observation');
const usageStore = require('../stores/usageStore');
const { runPlanner } = require('./planner');
const { buildExecutorMessages } = require('./executor');
const { pushRecent, buildMemorySummary } = require('./memory');
const { detectLoop } = require('./loopDetection');
const { executeWithRetries, autoDismissConsent } = require('./actions');

// ─── Main Entry Point ────────────────────────────────────────────────────────

async function executeBrowserTask(agentId, userMessage, userAuth, onEvent = () => { }, signal = null) {
    const agentConfig = browserAgentStore.getBrowserAgent(agentId);
    if (!agentConfig) throw new Error(`Browser agent not found: ${agentId}`);

    const config = agentConfig.config || {};
    const maxActions = config.maxActions || 20;
    const headless = config.headless !== false;
    const startingUrl = config.startingUrl || '';
    const allowedDomains = config.allowedDomains || [];
    const viewportWidth = config.viewport?.width || 1280;
    const viewportHeight = config.viewport?.height || 720;
    const timeout = config.timeout || 60000;
    const screenshotStreaming = config.screenshotStreaming !== false;
    const screenshotPerStep = !!config.screenshotPerStep; // Send annotated screenshot on every LLM call

    // Coordinator/Planner/Executor config (admin overrides)
    const plannerEnabled = config.plannerEnabled !== false;
    const maxMilestones = config.maxMilestones || DEFAULTS.maxMilestones;
    const actionBatchSize = config.actionBatchSize || DEFAULTS.actionBatchSize;
    const maxRetries = config.maxRetriesPerAction ?? DEFAULTS.maxRetriesPerAction;
    const retryEscalation = config.retryEscalation !== false;
    const replanAfterErrors = config.replanAfterErrors ?? DEFAULTS.replanAfterErrors;
    const replanAfterStale = config.replanAfterStale ?? DEFAULTS.replanAfterStale;
    const loopDetection = config.loopDetection !== false;
    const rollingWindowSize = config.rollingWindowSize || DEFAULTS.rollingWindowSize;
    const memorySummaryInterval = config.memorySummaryInterval || DEFAULTS.memorySummaryInterval;

    // Resolve models
    const globalConfig = await getAIConfig();
    const modelToUse = agentConfig.model || globalConfig.model;
    const plannerModel = config.plannerModel || modelToUse;
    const providerConfig = await getProviderForModel(modelToUse);
    const plannerProviderConfig = plannerModel !== modelToUse
        ? await getProviderForModel(plannerModel)
        : providerConfig;

    console.log(`[BrowserAgent] Starting task for agent ${agentId} with model ${modelToUse}`);
    onEvent('browser_status', { status: 'launching', message: 'Launching browser...' });

    let playwright;
    try {
        playwright = require('playwright');
    } catch (e) {
        throw new Error('Playwright is not installed. Run: npm install playwright && npx playwright install chromium');
    }

    let browser = null;
    let screenshotInterval = null;

    try {
        browser = await playwright.chromium.launch({
            headless,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const context = await browser.newContext({
            viewport: { width: viewportWidth, height: viewportHeight }
        });

        // Resource blocking — conditional on screenshot needs
        await context.route('**/*', route => {
            const type = route.request().resourceType();
            // Always block media
            if (type === 'media') return route.abort();
            // When screenshots are off, block images, fonts, stylesheets for speed
            if (!screenshotStreaming && (type === 'image' || type === 'font' || type === 'stylesheet')) {
                return route.abort();
            }
            // Always block known tracker patterns
            const url = route.request().url();
            if (/google-analytics|googletagmanager|facebook\.net\/tr|doubleclick\.net/.test(url)) {
                return route.abort();
            }
            return route.continue();
        });

        const page = await context.newPage();
        page.setDefaultTimeout(timeout);

        // Navigate to starting URL
        let initialScreenshotB64 = null;
        let initialScreenshotSent = false;
        let initialObsFromScreenshot = null;
        if (startingUrl) {
            onEvent('browser_action', { action: 'navigate', params: { url: startingUrl }, step: 0, maxSteps: maxActions, message: `Navigating to ${startingUrl}` });
            await page.goto(startingUrl, { waitUntil: 'domcontentloaded', timeout });
            // Auto-dismiss cookie consent overlays
            await autoDismissConsent(page);
            // Capture annotated screenshot for the AI's first context (with element labels)
            if (screenshotStreaming) {
                try {
                    const ann = await captureAnnotatedScreenshot(page);
                    initialScreenshotB64 = ann.screenshotB64;
                    // Pre-populate element map and observation from the annotated scan
                    coordinator.elementMap = ann.elementMap;
                    initialObsFromScreenshot = ann.observation;
                    console.log(`[BrowserAgent] 📸 Initial annotated screenshot captured (${Math.round((initialScreenshotB64 || '').length / 1024)}KB, ${ann.elementMap.size} elements labeled)`);
                    if (initialScreenshotB64) {
                        onEvent('browser_screenshot', { image: initialScreenshotB64, label: 'annotated' });
                        onEvent('browser_action', { action: 'screenshot', params: {}, step: 0, maxSteps: maxActions, message: '📸 Annotated screenshot captured', screenshot: initialScreenshotB64 });
                    }
                } catch (e) {
                    console.warn(`[BrowserAgent] ⚠ Initial annotated screenshot failed: ${e.message}`);
                }
            }
        }

        // ─── Live Screenshot Streaming ─────────────────
        // Stream screenshots every 1.5s so the user sees a live feed in the chat
        let _screenshotBusy = false;
        if (screenshotStreaming) {
            screenshotInterval = setInterval(async () => {
                if (_screenshotBusy) return; // Skip if previous capture is still running
                _screenshotBusy = true;
                try {
                    const frame = await page.screenshot({ type: 'jpeg', quality: 50 });
                    onEvent('browser_screenshot', { image: frame.toString('base64'), label: 'live' });
                } catch (e) { /* page may be navigating */ }
                _screenshotBusy = false;
            }, 500);
        }

        // ─── Coordinator State ─────────────────────────
        const coordinator = {
            goal: userMessage,
            plan: null,
            memorySummary: '',
            recentMessages: [],
            actionsExecuted: 0,
            consecutiveErrors: 0,
            staleCount: 0,
            lastPageSignature: '',
            actionHistory: [],  // For loop detection: [{action, args_key}]
            isDone: false,
            finalResult: '',
            elementMap: null    // Map<elementId, {selector, frameIndex, role, name}> — refreshed by observe()
        };

        // ─── Phase 1: Plan ─────────────────────────────
        const initialObs = initialObsFromScreenshot || await getStructuredObservation(page);

        if (plannerEnabled) {
            onEvent('browser_status', { status: 'planning', message: 'Creating execution plan...' });
            coordinator.plan = await runPlanner(plannerProviderConfig, plannerModel, coordinator, initialObs, agentConfig, '', maxMilestones, signal);
        }
        coordinator.lastPageSignature = await cheapSignature(page);

        onEvent('browser_status', { status: 'executing', message: 'Executing plan...' });

        // ─── Phase 2: Execute loop ─────────────────────
        let cachedObservation = initialObs; // Reuse observations instead of re-fetching
        while (coordinator.actionsExecuted < maxActions && !coordinator.isDone) {
            // Check if client disconnected
            if (signal?.aborted) {
                console.log('[BrowserAgent] Aborting — client disconnected');
                coordinator.isDone = true;
                coordinator.finalResult = 'Task cancelled by user.';
                break;
            }
            // Build executor messages: system + goal + memory + plan + recent + current observation
            const observation = cachedObservation || await getStructuredObservation(page);
            cachedObservation = null; // Consume cache
            const execMessages = buildExecutorMessages(agentConfig, coordinator, observation, config);

            // Inject screenshot into LLM context (vision)
            if (screenshotPerStep && screenshotStreaming) {
                // Per-step mode: capture a fresh annotated screenshot every iteration
                try {
                    const ann = await captureAnnotatedScreenshot(page);
                    if (ann.screenshotB64) {
                        const userMsg = execMessages.find(m => m.role === 'user');
                        if (userMsg) {
                            const textContent = typeof userMsg.content === 'string' ? userMsg.content : userMsg.content;
                            userMsg.content = [
                                ...(typeof textContent === 'string' ? [{ type: 'text', text: textContent }] : textContent),
                                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${ann.screenshotB64}` } }
                            ];
                        }
                        // Update element map from the screenshot scan
                        coordinator.elementMap = ann.elementMap;
                        console.log(`[BrowserAgent] 📸 Step screenshot injected (${Math.round(ann.screenshotB64.length / 1024)}KB, ${ann.elementMap.size} elements)`);
                        onEvent('browser_screenshot', { image: ann.screenshotB64, label: 'annotated' });
                        onEvent('browser_action', { action: 'screenshot', params: {}, step: coordinator.actionsExecuted, maxSteps: maxActions, message: '📸 Annotated screenshot', screenshot: ann.screenshotB64 });
                    }
                } catch (e) {
                    console.warn(`[BrowserAgent] ⚠ Step screenshot failed: ${e.message}`);
                }
                // Consume initial screenshot if it was pending
                initialScreenshotB64 = null;
                initialScreenshotSent = true;
            } else if (initialScreenshotB64) {
                // First-only mode: inject the initial screenshot once
                const userMsg = execMessages.find(m => m.role === 'user');
                if (userMsg) {
                    const textContent = userMsg.content;
                    userMsg.content = [
                        { type: 'text', text: textContent },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${initialScreenshotB64}` } }
                    ];
                    console.log(`[BrowserAgent] 📸 Injected initial screenshot into first LLM context`);
                }
                initialScreenshotB64 = null; // Consume — only send once
                initialScreenshotSent = true;
            }

            // Call LLM
            const llmStart = Date.now();
            const { message: llmResponse, usage: llmUsage } = await callLLM(providerConfig, modelToUse, execMessages, BROWSER_TOOLS, 0, 800, signal);
            const llmDuration = Date.now() - llmStart;
            console.log(`[BrowserAgent] ⏱ LLM call: ${llmDuration}ms`);
            if (!llmResponse) throw new Error('No response from LLM');

            // Log browser executor usage
            try {
                usageStore.logUsage({
                    agent_id: agentId,
                    agent_name: agentConfig.name || agentId,
                    agent_type: 'browser',
                    model: modelToUse,
                    prompt_tokens: llmUsage?.prompt_tokens || 0,
                    completion_tokens: llmUsage?.completion_tokens || 0,
                    total_tokens: llmUsage?.total_tokens || 0,
                    tool_name: llmResponse.tool_calls?.[0]?.function?.name || null,
                    source: 'browser-executor',
                    duration_ms: llmDuration,
                    user_id: userAuth?.userId || null,
                    organization_id: agentConfig.organization_id || null
                });
            } catch (e) { console.error('[BrowserAgent] Usage log error:', e.message); }

            if (llmResponse.tool_calls && llmResponse.tool_calls.length > 0) {
                // Add assistant message to recent window
                pushRecent(coordinator, llmResponse, rollingWindowSize);

                for (const toolCall of llmResponse.tool_calls) {
                    if (coordinator.isDone) break;

                    const actionName = normalizeActionName(toolCall.function.name);
                    let args = {};
                    try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch (e) { args = {}; }

                    // Invalid tool name from LLM — skip and log error
                    if (!actionName) {
                        const errMsg = `Invalid tool name from LLM: "${toolCall.function.name}". Skipping.`;
                        console.warn(`[BrowserAgent] ${errMsg}`);
                        pushRecent(coordinator, { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: errMsg }) }, rollingWindowSize);
                        coordinator.consecutiveErrors++;
                        continue;
                    }

                    // Domain restriction check (fixed: exact or subdomain match)
                    if (actionName === 'navigate' && allowedDomains.length > 0) {
                        try {
                            const targetDomain = new URL(args.url).hostname;
                            const isAllowed = allowedDomains.some(d =>
                                targetDomain === d || targetDomain.endsWith('.' + d)
                            );
                            if (!isAllowed) {
                                const errMsg = `Domain "${targetDomain}" is not allowed. Allowed: ${allowedDomains.join(', ')}`;
                                onEvent('browser_action', { action: actionName, params: args, step: coordinator.actionsExecuted, maxSteps: maxActions, error: errMsg });
                                pushRecent(coordinator, { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: errMsg }) }, rollingWindowSize);
                                coordinator.consecutiveErrors++;
                                continue;
                            }
                        } catch (e) { /* invalid URL, let it fail */ }
                    }

                    coordinator.actionsExecuted++;
                    const step = coordinator.actionsExecuted;
                    console.log(`[BrowserAgent] Action ${step}/${maxActions}: ${actionName}`, args);

                    // Handle done
                    if (actionName === 'done') {
                        coordinator.isDone = true;
                        // If LLM didn't provide a result, synthesize from recent extracted text
                        let result = args.result;
                        if (!result || result.trim() === '') {
                            const extractedTexts = coordinator.recentMessages
                                .filter(m => m.role === 'tool')
                                .map(m => { try { return JSON.parse(m.content); } catch { return null; } })
                                .filter(r => r && r.text && !r.error)
                                .map(r => r.text);
                            result = extractedTexts.length > 0
                                ? extractedTexts.join('\n\n').slice(0, 4000)
                                : 'Task completed.';
                        }
                        coordinator.finalResult = result;
                        onEvent('browser_action', {
                            action: 'done', params: args, result: coordinator.finalResult,
                            step, maxSteps: maxActions,
                            message: `Task completed after ${step} actions.`
                        });
                        pushRecent(coordinator, { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ status: 'completed', result: coordinator.finalResult }) }, rollingWindowSize);
                        break;
                    }

                    // Execute with retries
                    const actionResult = await executeWithRetries(page, actionName, args, onEvent, config, step, maxActions, screenshotStreaming, coordinator.elementMap, maxRetries, retryEscalation);

                    // Capture annotated screenshot after first successful navigate if we don't have one yet
                    if (!initialScreenshotB64 && !initialScreenshotSent && actionName === 'navigate' && actionResult.success && screenshotStreaming) {
                        try {
                            const ann = await captureAnnotatedScreenshot(page);
                            initialScreenshotB64 = ann.screenshotB64;
                            coordinator.elementMap = ann.elementMap;
                            cachedObservation = ann.observation;
                            console.log(`[BrowserAgent] 📸 Post-navigate annotated screenshot captured (${Math.round((initialScreenshotB64 || '').length / 1024)}KB, ${ann.elementMap.size} elements labeled)`);
                            if (initialScreenshotB64) {
                                onEvent('browser_screenshot', { image: initialScreenshotB64, label: 'annotated' });
                                onEvent('browser_action', { action: 'screenshot', params: {}, step, maxSteps: maxActions, message: '📸 Annotated screenshot captured', screenshot: initialScreenshotB64 });
                            }
                        } catch (e) {
                            console.warn(`[BrowserAgent] ⚠ Post-navigate annotated screenshot failed: ${e.message}`);
                        }
                    }

                    // If observe() returned a new element map, store it on the coordinator
                    if (actionResult._elementMap) {
                        coordinator.elementMap = actionResult._elementMap;
                        // Cache the observation for the next loop iteration
                        if (actionResult._observation) {
                            cachedObservation = actionResult._observation;
                        }
                        // Strip internal fields before storing in rolling window
                        delete actionResult._elementMap;
                        delete actionResult._observation;
                    }

                    // Truncate large results (e.g. extract_text) before storing in rolling window
                    // to prevent context bloat on subsequent LLM calls
                    let storedResult = actionResult;
                    if (actionResult.text && actionResult.text.length > 3000) {
                        storedResult = { ...actionResult, text: actionResult.text.slice(0, 3000) + '... [truncated for context window]' };
                    }
                    pushRecent(coordinator, { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(storedResult) }, rollingWindowSize);

                    // Track for loop detection
                    const actionKey = `${actionName}:${JSON.stringify(args)}`;
                    coordinator.actionHistory.push(actionKey);

                    if (actionResult.error) {
                        coordinator.consecutiveErrors++;
                        coordinator.staleCount++;
                    } else {
                        coordinator.consecutiveErrors = 0;

                        // Check for stale page using cheap signature (no full DOM observation)
                        if (PAGE_CHANGING_ACTIONS.has(actionName)) {
                            const newSig = await cheapSignature(page);
                            if (newSig === coordinator.lastPageSignature) {
                                coordinator.staleCount++;
                            } else {
                                coordinator.staleCount = 0;
                                coordinator.lastPageSignature = newSig;
                            }
                            // Invalidate caches so next loop does a fresh observe
                            cachedObservation = null;
                            coordinator.elementMap = null; // Element IDs are stale after page change
                        }
                    }

                    // ─── Coordinator checks ─────────────────
                    // Update memory summary periodically
                    if (coordinator.actionsExecuted % memorySummaryInterval === 0) {
                        coordinator.memorySummary = buildMemorySummary(coordinator);
                    }

                    // Detect repeated action loops
                    if (loopDetection && detectLoop(coordinator.actionHistory)) {
                        console.log('[BrowserAgent] Loop detected, replanning...');
                        onEvent('browser_status', { status: 'replanning', message: 'Detected repeated actions, replanning...' });
                        const obs = cachedObservation || await getStructuredObservation(page);
                        coordinator.memorySummary = buildMemorySummary(coordinator);
                        coordinator.plan = await runPlanner(plannerProviderConfig, plannerModel, coordinator, obs, agentConfig, 'Loop detected: the agent repeated the same actions. Try a different approach.', maxMilestones);
                        coordinator.actionHistory = [];
                        coordinator.consecutiveErrors = 0;
                        coordinator.staleCount = 0;
                        cachedObservation = obs; // Reuse for next iteration
                        break; // Break inner for-loop to restart with new plan
                    }

                    // Replan on consecutive errors
                    if (coordinator.consecutiveErrors >= replanAfterErrors) {
                        console.log('[BrowserAgent] Consecutive errors, replanning...');
                        onEvent('browser_status', { status: 'replanning', message: 'Errors encountered, adjusting plan...' });
                        const obs = cachedObservation || await getStructuredObservation(page);
                        coordinator.memorySummary = buildMemorySummary(coordinator);
                        coordinator.plan = await runPlanner(plannerProviderConfig, plannerModel, coordinator, obs, agentConfig, `${coordinator.consecutiveErrors} consecutive action failures. Try alternative selectors or approach.`, maxMilestones);
                        coordinator.consecutiveErrors = 0;
                        coordinator.staleCount = 0;
                        cachedObservation = obs;
                        break;
                    }

                    // Replan on stale page
                    if (coordinator.staleCount >= replanAfterStale) {
                        console.log('[BrowserAgent] Stale page, replanning...');
                        onEvent('browser_status', { status: 'replanning', message: 'Page not changing, adjusting approach...' });
                        const obs = cachedObservation || await getStructuredObservation(page);
                        coordinator.memorySummary = buildMemorySummary(coordinator);
                        coordinator.plan = await runPlanner(plannerProviderConfig, plannerModel, coordinator, obs, agentConfig, `Page state unchanged after ${coordinator.staleCount} actions. The current approach is not working.`, maxMilestones);
                        coordinator.staleCount = 0;
                        cachedObservation = obs;
                        break;
                    }
                }
            } else if (llmResponse.content) {
                // LLM gave text instead of tool calls → final answer
                coordinator.isDone = true;
                coordinator.finalResult = llmResponse.content;
                pushRecent(coordinator, { role: 'assistant', content: llmResponse.content }, rollingWindowSize);
                onEvent('browser_action', {
                    action: 'done', params: {}, result: coordinator.finalResult,
                    step: coordinator.actionsExecuted, maxSteps: maxActions,
                    message: 'Task completed.'
                });
            } else {
                // Nothing returned — break to avoid infinite loop
                console.warn('[BrowserAgent] LLM returned no content and no tool calls');
                break;
            }
        }

        // Max actions reached — ask the LLM for a final summary instead of a generic error
        if (!coordinator.isDone && coordinator.actionsExecuted >= maxActions) {
            onEvent('browser_action', {
                action: 'max_actions_reached', params: {}, result: `Action limit (${maxActions}) reached — generating final summary...`,
                step: coordinator.actionsExecuted, maxSteps: maxActions
            });

            try {
                const summaryMessages = [
                    {
                        role: 'system',
                        content: `You are a browser automation agent that has reached its action limit. Summarize what you accomplished and what you found. Be thorough — include ALL data, findings, and results you gathered. If the task is incomplete, mention what remains.`
                    },
                    {
                        role: 'user',
                        content: `Original task: ${coordinator.goal}\n\nMemory so far:\n${coordinator.memorySummary || '(none)'}\n\nRecent actions:\n${coordinator.recentMessages.filter(m => m.role === 'tool').slice(-6).map(m => m.content).join('\n')}\n\nProvide your final summary of everything accomplished and found.`
                    }
                ];

                const summaryStart = Date.now();
                const { message: summaryResponse, usage: summaryUsage } = await callLLM(providerConfig, modelToUse, summaryMessages, [], 0.2, 4000);
                const summaryDuration = Date.now() - summaryStart;
                console.log(`[BrowserAgent] ⏱ Final summary LLM call: ${summaryDuration}ms`);

                // Log browser summary usage
                try {
                    usageStore.logUsage({
                        agent_id: agentId,
                        agent_name: agentConfig.name || agentId,
                        agent_type: 'browser',
                        model: modelToUse,
                        prompt_tokens: summaryUsage?.prompt_tokens || 0,
                        completion_tokens: summaryUsage?.completion_tokens || 0,
                        total_tokens: summaryUsage?.total_tokens || 0,
                        source: 'browser-summary',
                        duration_ms: summaryDuration,
                        user_id: userAuth?.userId || null,
                        organization_id: agentConfig.organization_id || null
                    });
                } catch (e) { console.error('[BrowserAgent] Usage log error:', e.message); }

                coordinator.finalResult = summaryResponse.content || `Reached maximum action limit (${maxActions}). The task may not be fully completed.`;
            } catch (e) {
                console.error('[BrowserAgent] Final summary call failed:', e.message);
                coordinator.finalResult = `Reached maximum action limit (${maxActions}). The task may not be fully completed.\n\nMemory: ${coordinator.memorySummary || 'none'}`;
            }

            onEvent('browser_action', {
                action: 'done', params: {}, result: coordinator.finalResult,
                step: coordinator.actionsExecuted, maxSteps: maxActions,
                message: 'Task completed (action limit reached).'
            });
        }

        // Stop live screenshot feed + send one final frame
        if (screenshotInterval) clearInterval(screenshotInterval);
        if (screenshotStreaming) {
            try {
                const finalFrame = await page.screenshot({ type: 'jpeg', quality: 70 });
                onEvent('browser_screenshot', { image: finalFrame.toString('base64'), label: 'final' });
            } catch (e) { /* page may already be closed */ }
        }

        return { result: coordinator.finalResult, actionsExecuted: coordinator.actionsExecuted };

    } finally {
        if (screenshotInterval) clearInterval(screenshotInterval);
        if (browser) {
            try { await browser.close(); } catch (e) { console.error('[BrowserAgent] Browser close error:', e.message); }
        }
    }
}

module.exports = { executeBrowserTask };
