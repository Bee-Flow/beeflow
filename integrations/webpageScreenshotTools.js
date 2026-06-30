/**
 * Webpage screenshot tool — lets the Webpages builder AI render the current
 * page in a real headless browser and SEE it (Claude is vision-capable), plus
 * read any console/runtime errors. Works for react-mui and vanilla projects.
 *
 * The executor returns a MULTIMODAL result `{ _isMultimodal, content:[image,text] }`.
 * webpageChat.js's dispatch passes that `content` array straight through to the
 * model (the Claude provider converts the image_url block to a native image);
 * it must NOT be JSON-stringified (see compactWebpageToolResult passthrough).
 */

const { captureWebpage } = require('../services/webpageRender');

const WEBPAGE_SCREENSHOT_TOOL = {
    type: 'function',
    function: {
        name: 'webpage_screenshot',
        description:
            "Render the CURRENT webpage in a real headless browser and return a PNG screenshot of what it actually looks like, plus any console/runtime errors. Use it to SEE your work and iterate on layout, spacing, colour, contrast and responsiveness, and to catch runtime errors. Works for both vanilla and react-mui projects. NOTE: platform data bridges (beeflowDB/beeflowApp) are STUBBED to empty in this render, so data-driven lists appear empty — judge the layout and chrome, not the data. Call it after a BATCH of edits (not every tiny change), and re-check the 'mobile' and 'tablet' viewports for responsive pages.",
        parameters: {
            type: 'object',
            properties: {
                viewport: {
                    type: 'string',
                    enum: ['desktop', 'tablet', 'mobile'],
                    description: 'Preset viewport: desktop=1280x800, tablet=834x1112, mobile=390x844. Defaults to desktop. Ignored if width/height are given.',
                },
                width: { type: 'integer', description: 'Custom viewport width in px (320–1920). Use with height.' },
                height: { type: 'integer', description: 'Custom viewport height in px (320–1600).' },
                fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of just the viewport. Default false.' },
            },
        },
    },
};

const SCREENSHOT_TOOL_NAMES = new Set(['webpage_screenshot']);
function isScreenshotTool(name) { return SCREENSHOT_TOOL_NAMES.has(name); }

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function pickViewport(args) {
    const w = Number(args?.width);
    const h = Number(args?.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return { width: clamp(Math.round(w), 320, 1920), height: clamp(Math.round(h), 320, 1600) };
    }
    const preset = String(args?.viewport || 'desktop').toLowerCase();
    return ['desktop', 'tablet', 'mobile'].includes(preset) ? preset : 'desktop';
}

function viewportLabel(vp) {
    if (typeof vp === 'string') return vp.charAt(0).toUpperCase() + vp.slice(1);
    return `${vp.width}×${vp.height}`;
}

function formatDiagnostics(r, vpLabel, modelSupportsVision) {
    const parts = [`${vpLabel} (${r.width}×${r.height}) screenshot captured.`];
    if (modelSupportsVision) {
        parts.push('The image is attached below — look at it and judge the layout, spacing, colour and alignment.');
    } else {
        parts.push('NOTE: your current model cannot see images, so you cannot visually inspect this screenshot — it has been shown to the user instead. Switch to a vision-capable model (e.g. a Claude model) to have me analyse the page visually. You can still act on the console/runtime diagnostics below.');
    }
    if (r.renderedEmpty) {
        parts.push('WARNING: #root rendered empty — likely a failed import (React/MUI from the CDN), a component returning nothing, or a runtime error. See errors below.');
    }
    if (r.guardPanel) parts.push(`Error panel shown on the page:\n${r.guardPanel}`);
    if (r.pageErrors && r.pageErrors.length) parts.push(`Runtime errors (${r.pageErrors.length}):\n- ${r.pageErrors.join('\n- ')}`);
    if (r.consoleErrors && r.consoleErrors.length) parts.push(`Console messages (${r.consoleErrors.length}):\n- ${r.consoleErrors.join('\n- ')}`);
    if (!r.pageErrors?.length && !r.consoleErrors?.length && !r.renderedEmpty) parts.push('No console or runtime errors detected.');
    parts.push('(Data bridges are stubbed in this render, so data-driven lists appear empty — judge layout, not data.)');
    return parts.join('\n\n');
}

// Soft per-webpage spam guard.
const _lastCall = new Map();
const MIN_INTERVAL_MS = 1500;

async function executeScreenshotTool(toolName, args, { webpageId, userId, modelSupportsVision = false } = {}) {
    if (!isScreenshotTool(toolName)) return { content: `Unknown screenshot tool: ${toolName}` };
    if (!webpageId || !userId) return { content: 'Cannot screenshot: missing webpage context.' };

    const now = Date.now();
    const last = _lastCall.get(webpageId) || 0;
    if (now - last < MIN_INTERVAL_MS) {
        return { content: 'You just took a screenshot moments ago. Make more edits before re-checking — repeated screenshots of the same state add nothing.' };
    }
    _lastCall.set(webpageId, now);

    try {
        const viewport = pickViewport(args);
        const r = await captureWebpage({ webpageId, userId, viewport, fullPage: !!args?.fullPage });

        if (r.empty) return { content: 'The page is empty — there is nothing to screenshot yet. Add content first.' };
        if (r.buildError) {
            return { content: `Screenshot skipped — the React app failed to build:\n\n${r.buildError}\n\nFix the build error, then screenshot again.` };
        }

        // The tool RESULT is always a plain string (provider-portable — Mistral/
        // OpenAI tool messages must be strings). The actual image is delivered
        // separately: shown to the user via an 'image' SSE event, and — only for
        // a vision-capable model — appended to the conversation as a user image.
        const dataUrl = `data:image/png;base64,${r.pngBuffer.toString('base64')}`;
        return {
            content: formatDiagnostics(r, viewportLabel(viewport), modelSupportsVision),
            _screenshotDataUrl: dataUrl,
            _screenshotViewport: viewportLabel(viewport),
        };
    } catch (err) {
        return { content: `Could not capture a screenshot: ${err.message}. The render engine may be temporarily unavailable — this does not indicate a problem with your code. Try again shortly.` };
    }
}

module.exports = { WEBPAGE_SCREENSHOT_TOOL, executeScreenshotTool, isScreenshotTool, pickViewport };
