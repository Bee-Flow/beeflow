/**
 * Browser Agent — Structured Observation with Element IDs
 *
 * Each observe() call returns an element map: every actionable element gets a
 * stable-within-call ID (btn_0, link_3, input_5, …) that click/type_text can
 * reference directly, so the LLM chooses from a menu instead of guessing selectors.
 */

// ─── Element Map Builder ─────────────────────────────────────────────────────

/**
 * Scan a page (and its same-origin iframes) for all actionable elements.
 * Returns { observation, elementMap }.
 *
 * - observation: full structured obs (headings, elements[], alerts, mainText, iframes)
 * - elementMap:  Map<id, { selector, frameIndex, role, name }> used by actions.js
 */
async function createElementMap(page) {
    // Scan main frame
    const mainResult = await _scanFrame(page, 0);

    // Scan same-origin child frames
    const frames = page.frames().filter(f => f !== page.mainFrame());
    const frameInfos = [];
    let elementCounter = mainResult.elements.length;

    for (let fi = 0; fi < frames.length; fi++) {
        const frame = frames[fi];
        const url = frame.url();
        if (!url || url === 'about:blank') continue;

        // Only scan same-origin frames (cross-origin will throw)
        try {
            const frameResult = await _scanFrame(frame, fi + 1, elementCounter);
            // Re-number elements with the running counter
            for (const el of frameResult.elements) {
                mainResult.elements.push(el);
            }
            elementCounter = mainResult.elements.length;
            frameInfos.push({ index: fi + 1, url, elementCount: frameResult.elements.length });
        } catch (e) {
            // Cross-origin — just record the URL
            frameInfos.push({ index: fi + 1, url, crossOrigin: true });
        }
    }

    // Build the lookup map: id → { selector, frameIndex, role, name }
    const elementMap = new Map();
    for (const el of mainResult.elements) {
        elementMap.set(el.id, {
            selector: el.selector,
            frameIndex: el.frameIndex || 0,
            role: el.role,
            name: el.name
        });
    }

    const observation = {
        url: mainResult.url,
        title: mainResult.title,
        headings: mainResult.headings,
        elements: mainResult.elements,
        alerts: mainResult.alerts,
        overlay: mainResult.overlay,
        mainText: mainResult.mainText,
        iframes: frameInfos
    };

    return { observation, elementMap };
}

/**
 * Scan a single frame context for actionable elements.
 * Runs one page.evaluate() collecting everything in a single pass.
 */
async function _scanFrame(ctx, frameIndex, startId = 0) {
    try {
        const raw = await ctx.evaluate(({ _startId, _frameIndex }) => {
            // ── Visibility helper ──
            // Checks element AND ancestors for display/visibility/opacity/overflow clipping
            function isVisible(el) {
                // 1. Modern API: checks display, visibility, content-visibility, opacity on element + all ancestors
                if (typeof el.checkVisibility === 'function') {
                    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
                } else {
                    // Fallback for older contexts
                    if (!el.getClientRects || el.getClientRects().length === 0) return false;
                    const style = getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden') return false;
                    if (parseFloat(style.opacity) === 0) return false;
                }
                // 2. Must have actual rendered size
                const rect = el.getBoundingClientRect();
                if (rect.width < 2 || rect.height < 2) return false;
                // 3. Must be at least partially within the viewport
                const vw = window.innerWidth || document.documentElement.clientWidth;
                const vh = window.innerHeight || document.documentElement.clientHeight;
                if (rect.right < 0 || rect.left > vw || rect.bottom < 0 || rect.top > vh) return false;
                // 4. Check for clip/clip-path hiding
                const elStyle = getComputedStyle(el);
                if (elStyle.clip === 'rect(0px, 0px, 0px, 0px)' || elStyle.clipPath === 'inset(100%)') return false;
                // 5. Check ancestor overflow clipping (catches collapsed containers)
                let parent = el.parentElement;
                while (parent && parent !== document.body && parent !== document.documentElement) {
                    const ps = getComputedStyle(parent);
                    if (ps.overflow === 'hidden' || ps.overflowX === 'hidden' || ps.overflowY === 'hidden') {
                        const pr = parent.getBoundingClientRect();
                        if (pr.width < 2 || pr.height < 2) return false;
                        // Element must intersect the parent's visible area
                        if (rect.right <= pr.left || rect.left >= pr.right ||
                            rect.bottom <= pr.top || rect.top >= pr.bottom) return false;
                    }
                    parent = parent.parentElement;
                }
                return true;
            }

            // ── Label resolution (#5) ──
            function resolveLabel(el) {
                // 1. <label for="id"> text
                if (el.id) {
                    const label = document.querySelector(`label[for="${el.id}"]`);
                    if (label) {
                        const t = label.innerText?.trim();
                        if (t) return t;
                    }
                }
                // 2. aria-label
                const ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel) return ariaLabel.trim();
                // 3. aria-labelledby
                const labelledBy = el.getAttribute('aria-labelledby');
                if (labelledBy) {
                    const parts = labelledBy.split(/\s+/).map(id => {
                        const ref = document.getElementById(id);
                        return ref ? ref.innerText?.trim() : '';
                    }).filter(Boolean);
                    if (parts.length > 0) return parts.join(' ');
                }
                // 4. labels property (HTML label association)
                if (el.labels && el.labels.length > 0) {
                    const t = el.labels[0].innerText?.trim();
                    if (t) return t;
                }
                // 5. placeholder
                const ph = el.getAttribute('placeholder');
                if (ph) return ph.trim();
                // 6. name attribute as last resort
                return el.name || '';
            }

            // ── Selector generation (#5) ──
            function bestSelector(el) {
                // 1. data-testid
                const testId = el.getAttribute('data-testid') ||
                    el.getAttribute('data-test-id') ||
                    el.getAttribute('data-cy');
                if (testId) return `[data-testid="${testId}"]`;
                // 2. id
                if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${el.id}`;
                // 3. name (for inputs)
                if (el.name && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
                    return `[name="${el.name}"]`;
                }
                // 4. aria-label (careful with quotes)
                const al = el.getAttribute('aria-label');
                if (al && al.length < 60 && !al.includes('"')) return `[aria-label="${al}"]`;
                // 5. Generated CSS path (nth-child walk)
                return _cssPath(el);
            }

            function _cssPath(el) {
                const parts = [];
                let cur = el;
                while (cur && cur !== document.body && cur !== document.documentElement) {
                    let seg = cur.tagName.toLowerCase();
                    if (cur.id && /^[a-zA-Z][\w-]*$/.test(cur.id)) {
                        parts.unshift(`#${cur.id}`);
                        break;
                    }
                    // nth-child for disambiguation
                    const parent = cur.parentElement;
                    if (parent) {
                        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
                        if (siblings.length > 1) {
                            const idx = siblings.indexOf(cur) + 1;
                            seg += `:nth-of-type(${idx})`;
                        }
                    }
                    parts.unshift(seg);
                    cur = cur.parentElement;
                }
                return parts.join(' > ') || 'body';
            }

            // ── Bounding box ──
            function getBBox(el) {
                try {
                    const r = el.getBoundingClientRect();
                    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
                } catch { return null; }
            }

            // ── ARIA role inference ──
            function inferRole(el) {
                // Explicit role
                const explicit = el.getAttribute('role');
                if (explicit) return explicit;
                // Implicit from tag
                const tag = el.tagName;
                if (tag === 'BUTTON' || el.type === 'submit' || el.type === 'button') return 'button';
                if (tag === 'A') return 'link';
                if (tag === 'INPUT') {
                    const t = el.type || 'text';
                    if (t === 'checkbox') return 'checkbox';
                    if (t === 'radio') return 'radio';
                    if (t === 'search') return 'searchbox';
                    return 'textbox';
                }
                if (tag === 'TEXTAREA') return 'textbox';
                if (tag === 'SELECT') return 'combobox';
                if (tag === 'IMG') return 'img';
                return el.tagName.toLowerCase();
            }

            // ── Accessible name ──
            function accessibleName(el) {
                // aria-label first
                const al = el.getAttribute('aria-label');
                if (al) return al.trim();
                // aria-labelledby
                const lb = el.getAttribute('aria-labelledby');
                if (lb) {
                    const parts = lb.split(/\s+/).map(id => {
                        const ref = document.getElementById(id);
                        return ref ? ref.innerText?.trim() : '';
                    }).filter(Boolean);
                    if (parts.length > 0) return parts.join(' ');
                }
                // Inner text / value
                const text = (el.innerText || el.value || el.getAttribute('title') || '').trim();
                return text.slice(0, 80);
            }

            // ── Collect elements ──
            const elements = [];
            let counter = _startId;
            const seen = new Set(); // Avoid duplicate registrations

            function addElement(el, kind) {
                if (seen.has(el) || !isVisible(el)) return;
                // Skip tiny / zero-size elements
                const rect = el.getBoundingClientRect();
                if (rect.width < 4 || rect.height < 4) return;
                seen.add(el);

                const role = inferRole(el);
                const prefix = kind === 'button' ? 'btn' :
                    kind === 'link' ? 'link' :
                        kind === 'input' || kind === 'select' || kind === 'textarea' ? 'input' :
                            kind === 'heading' ? 'heading' : 'el';
                const id = `${prefix}_${counter++}`;

                const entry = {
                    id,
                    kind,
                    role,
                    name: kind === 'input' || kind === 'select' || kind === 'textarea'
                        ? resolveLabel(el) : accessibleName(el),
                    text: (el.innerText || el.value || '').trim().slice(0, 100),
                    selector: bestSelector(el),
                    disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || false,
                    bbox: getBBox(el),
                    frameIndex: _frameIndex
                };

                // Input-specific fields
                if (kind === 'input' || kind === 'textarea') {
                    entry.inputType = el.type === 'password' ? 'password' : (el.type || 'text');
                    entry.value = el.type === 'password' ? '***' : (el.value || '').slice(0, 50);
                } else if (kind === 'select') {
                    entry.inputType = 'select';
                    entry.value = el.options?.[el.selectedIndex]?.text?.slice(0, 50) || '';
                }

                // Link-specific
                if (kind === 'link') {
                    entry.href = (el.href || '').slice(0, 150);
                }

                elements.push(entry);
            }

            // Buttons (including role="button", submit, etc.)
            document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach(el => {
                addElement(el, 'button');
            });

            // Links
            document.querySelectorAll('a[href]').forEach(el => {
                addElement(el, 'link');
            });

            // Inputs
            document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea').forEach(el => {
                addElement(el, el.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'input');
            });

            // Selects
            document.querySelectorAll('select').forEach(el => {
                addElement(el, 'select');
            });

            // Headings (h1-h3 only — keep observation compact)
            const headings = [];
            document.querySelectorAll('h1, h2, h3').forEach(el => {
                const text = el.innerText?.trim();
                if (text && text.length < 200 && isVisible(el)) {
                    headings.push({ tag: el.tagName.toLowerCase(), text });
                }
            });

            // Alerts / error banners
            const alerts = [];
            document.querySelectorAll('[role="alert"], .alert, .error, .warning, .toast, .notification').forEach(el => {
                const text = el.innerText?.trim();
                if (text && text.length < 300 && isVisible(el)) alerts.push(text);
            });

            // Detect blocking overlays (cookie consent, paywalls, subscription popups)
            let overlay = null;
            const overlayCandidates = document.querySelectorAll(
                '[role="dialog"], [aria-modal="true"], .modal, .overlay, ' +
                '[class*="modal"], [class*="overlay"], [class*="popup"], [class*="consent"], ' +
                '[class*="cookie"], [class*="paywall"], [class*="subscribe"], ' +
                '[id*="consent"], [id*="cookie"], [id*="modal"], [id*="popup"]'
            );
            for (const oc of overlayCandidates) {
                if (!isVisible(oc)) continue;
                const r = oc.getBoundingClientRect();
                // Must be large enough to be a real overlay
                if (r.width > 200 && r.height > 150) {
                    const text = (oc.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
                    // Find buttons inside the overlay
                    const btns = [];
                    oc.querySelectorAll('button, [role="button"], a.btn, a.button, input[type="submit"]').forEach(b => {
                        const label = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
                        if (label && label.length < 60) btns.push(label);
                    });
                    overlay = { text: text.slice(0, 200), buttons: btns.slice(0, 5) };
                    break;
                }
            }

            // Main content preview
            let mainText = '';
            const main = document.querySelector('main, [role="main"], article, .content, #content');
            if (main) {
                const clone = main.cloneNode(true);
                clone.querySelectorAll('script, style, nav, footer, header').forEach(n => n.remove());
                mainText = (clone.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800);
            } else {
                const body = document.body.cloneNode(true);
                body.querySelectorAll('script, style, nav, footer, header, noscript, svg, iframe').forEach(n => n.remove());
                mainText = (body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800);
            }

            return {
                url: location.href,
                title: document.title,
                headings,
                elements,
                alerts,
                overlay,
                mainText
            };
        }, { _startId: startId, _frameIndex: frameIndex });

        return raw;
    } catch (e) {
        // Frame not accessible (cross-origin, detached, etc.)
        throw e;
    }
}


// ─── Legacy Structured Observation (kept for planner/formatObservation compat) ─

/**
 * Legacy getStructuredObservation — now delegates to createElementMap and
 * converts elements back to the old format for planner compatibility.
 */
async function getStructuredObservation(page) {
    try {
        const { observation } = await createElementMap(page);
        return observation;
    } catch (e) {
        return {
            url: 'unknown', title: 'unknown', headings: [], elements: [],
            alerts: [], iframes: [], mainText: '(page not accessible)'
        };
    }
}


// ─── Observation Formatting ──────────────────────────────────────────────────

function formatObservation(obs) {
    let s = `URL: ${obs.url}\nTitle: ${obs.title}`;

    // Surface overlay/popup warning prominently at the top
    if (obs.overlay) {
        s += `\n\n⚠️ OVERLAY/POPUP DETECTED — Dismiss this FIRST before interacting with the page:`;
        s += `\n  "${obs.overlay.text}"`;
        if (obs.overlay.buttons && obs.overlay.buttons.length > 0) {
            s += `\n  Available buttons: ${obs.overlay.buttons.map(b => `"${b}"`).join(', ')}`;
        }
        s += `\n  → Click the accept/continue/close button or press Escape to dismiss.`;
    }

    if (obs.headings && obs.headings.length > 0) {
        s += '\n\nHeadings:';
        obs.headings.forEach(h => { s += `\n  ${h.tag}: ${h.text}`; });
    }

    // New: element-based list with IDs
    if (obs.elements && obs.elements.length > 0) {
        const buttons = obs.elements.filter(e => e.kind === 'button');
        const links = obs.elements.filter(e => e.kind === 'link');
        const inputs = obs.elements.filter(e => ['input', 'textarea', 'select'].includes(e.kind));

        if (buttons.length > 0) {
            s += '\n\nButtons:';
            buttons.forEach(el => {
                const dis = el.disabled ? ' [disabled]' : '';
                s += `\n  [${el.id}] "${el.text || el.name}"${dis}`;
            });
        }


        if (inputs.length > 0) {
            s += '\n\nForm fields:';
            inputs.forEach(el => {
                const type = el.inputType || el.kind;
                const val = el.value ? ` = "${el.value}"` : '';
                const sel = el.selector ? ` (${el.selector})` : '';
                s += `\n  [${el.id}] [${type}] "${el.name}"${sel}${val}`;
            });
        }
    }

    if (obs.alerts && obs.alerts.length > 0) {
        s += `\n\nAlerts/Errors:\n  ${obs.alerts.join('\n  ')}`;
    }

    if (obs.mainText) {
        s += `\n\nContent preview: ${obs.mainText.slice(0, 500)}`;
        if (obs.mainText.length > 500) s += '...';
    }

    if (obs.iframes && obs.iframes.length > 0) {
        s += `\n\nIframes (${obs.iframes.length}):`;
        obs.iframes.forEach(f => {
            if (f.crossOrigin) {
                s += `\n  frame[${f.index}]: ${f.url} (cross-origin)`;
            } else {
                s += `\n  frame[${f.index}]: ${f.url} (${f.elementCount || 0} elements)`;
            }
        });
    }

    return s;
}

function pageSignature(obs) {
    const headingText = obs.headings ? obs.headings.map(h => h.text).join(',') : '';
    return `${obs.url}|${obs.title}|${headingText}`;
}

/**
 * Cheap page signature for stale detection — avoids full DOM observation.
 * Uses only url + title + body text length (one fast page.evaluate).
 */
async function cheapSignature(page) {
    try {
        return await page.evaluate(() => {
            const u = location.href;
            const t = document.title || '';
            const len = document.body?.innerText?.length || 0;
            return `${u}|${t}|${len}`;
        });
    } catch (e) {
        return 'error';
    }
}

/**
 * Capture a screenshot with element ID labels overlaid (Set-of-Mark).
 * Only labels high-priority interactive elements to avoid clutter:
 *  - inputs, textareas, selects  → always (green)
 *  - buttons                     → always (blue)
 *  - links                       → only large/prominent ones (gray)
 * Returns { screenshotB64, observation, elementMap }.
 */
async function captureAnnotatedScreenshot(page) {
    const { observation, elementMap } = await createElementMap(page);

    // Collect main-frame elements, tagged with priority
    const labelData = [];
    for (const [id, entry] of elementMap.entries()) {
        if (entry.frameIndex !== 0) continue;
        const prefix = id.split('_')[0]; // btn, input, link, select, etc.
        let priority = 0; // 0 = skip, 1 = always, 2 = conditional
        if (prefix === 'input' || prefix === 'select' || prefix === 'textarea') priority = 1;
        else if (prefix === 'btn') priority = 1;
        if (priority > 0) {
            labelData.push({ id, selector: entry.selector, priority, prefix });
        }
    }

    // Inject labels onto the page — with smart filtering inside the browser context
    await page.evaluate((elements) => {
        const container = document.createElement('div');
        container.id = '__som_labels__';
        container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647';

        const viewW = window.innerWidth;
        const viewH = window.innerHeight;

        // Detect if there's a modal/overlay blocking the page
        let modalRect = null;
        const modalCandidates = document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, .overlay, [class*="modal"], [class*="overlay"], [class*="popup"], [class*="consent"]');
        for (const mc of modalCandidates) {
            const r = mc.getBoundingClientRect();
            if (r.width > 200 && r.height > 150) {
                modalRect = r;
                break;
            }
        }

        // Color scheme per type
        const colors = {
            input: '#16a34a', select: '#16a34a', textarea: '#16a34a', // green
            btn: '#2563eb',   // blue
            link: '#6b7280'   // gray
        };

        const placed = []; // Track placed label positions to avoid overlap
        let count = 0;
        const MAX_LABELS = 30;

        for (const { id, selector, priority, prefix } of elements) {
            if (count >= MAX_LABELS) break;
            try {
                const el = document.querySelector(selector);
                if (!el) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width < 2 || rect.height < 2) continue;

                // Skip elements outside viewport
                if (rect.right < 0 || rect.left > viewW || rect.bottom < 0 || rect.top > viewH) continue;

                // For links (priority 2): skip small/navigation links
                if (priority === 2) {
                    if (rect.width < 60 || rect.height < 20) continue;
                    // Skip links behind modal
                    if (modalRect) {
                        const cx = rect.left + rect.width / 2;
                        const cy = rect.top + rect.height / 2;
                        if (cx < modalRect.left || cx > modalRect.right || cy < modalRect.top || cy > modalRect.bottom) continue;
                    }
                }

                // For inputs/buttons behind modal: skip if modal present and element is behind it
                if (priority === 1 && modalRect) {
                    const cx = rect.left + rect.width / 2;
                    const cy = rect.top + rect.height / 2;
                    // Skip elements clearly outside modal bounds
                    if (cx < modalRect.left - 20 || cx > modalRect.right + 20 || cy < modalRect.top - 20 || cy > modalRect.bottom + 20) continue;
                }

                // Check overlap with already-placed labels
                const labelTop = Math.max(0, rect.top + window.scrollY - 16);
                const labelLeft = Math.max(0, rect.left + window.scrollX);
                const tooClose = placed.some(([px, py]) => Math.abs(px - labelLeft) < 50 && Math.abs(py - labelTop) < 14);
                if (tooClose && priority === 2) continue; // Skip overlapping links, but keep inputs/buttons

                const color = colors[prefix] || '#e22';

                // Label badge
                const label = document.createElement('div');
                label.style.cssText = `position:absolute;left:${labelLeft}px;top:${labelTop}px;background:${color};color:#fff;font:bold 10px/1.2 monospace;padding:1px 4px;border-radius:3px;white-space:nowrap;pointer-events:none;z-index:2147483647;box-shadow:0 1px 3px rgba(0,0,0,.4)`;
                label.textContent = id;
                container.appendChild(label);

                // Subtle border
                const border = document.createElement('div');
                border.style.cssText = `position:absolute;left:${rect.left + window.scrollX}px;top:${rect.top + window.scrollY}px;width:${rect.width}px;height:${rect.height}px;border:2px solid ${color};border-radius:3px;pointer-events:none;z-index:2147483646;opacity:0.7`;
                container.appendChild(border);

                placed.push([labelLeft, labelTop]);
                count++;
            } catch (e) { /* skip */ }
        }

        document.body.appendChild(container);
    }, labelData);

    // Take screenshot with labels visible
    let screenshotB64 = null;
    try {
        const shot = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
        screenshotB64 = shot.toString('base64');
    } catch (e) { /* page may not be ready */ }

    // Remove labels
    await page.evaluate(() => {
        const el = document.getElementById('__som_labels__');
        if (el) el.remove();
    }).catch(() => { });

    return { screenshotB64, observation, elementMap };
}

module.exports = {
    createElementMap,
    captureAnnotatedScreenshot,
    getStructuredObservation,
    formatObservation,
    pageSignature,
    cheapSignature
};
