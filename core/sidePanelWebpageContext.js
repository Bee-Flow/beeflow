/**
 * Side-panel webpage context — builds the system-prompt block describing the
 * webpage the user has open in their right-side chat panel.
 *
 * Shared between direct chat (server/routes/ai/directChat.js) and agent chat
 * (server/core/agentRuntime/contextBuilder.js) so both paths stay in sync.
 *
 * The chat client only ships the id (plus name/description hints) — we fetch
 * the latest html/css/js bytes server-side from RustFS so chat payloads stay
 * small and the AI always sees the current version.
 *
 * Visibility is enforced via canReadWebpage: a viewer in the same org or a
 * shared group can read; everyone else gets nothing injected.
 */

const webpageStore = require('../stores/webpageStore');
const userStore = require('../stores/userStore');

// Cap the per-slot length we inject. Long pages would otherwise eat the
// context window. The model can still call follow-up tools / ask the user to
// open the editor if it needs the full source.
const MAX_SLOT_CHARS = 6000;
function truncate(s, max = MAX_SLOT_CHARS) {
    if (typeof s !== 'string') return '';
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n…[truncated, full file is ${s.length} chars]`;
}

async function buildSidePanelWebpageContext(sidePanel, userId) {
    const id = sidePanel?.id;
    if (!id) return '';

    const wp = await webpageStore.getWebpageRaw(id);
    if (!wp) return '';

    // Visibility check — owner OR org/group published visibility.
    if (wp.userId !== userId) {
        try {
            const user = await userStore.getUser(userId);
            const groups = Array.isArray(user?.groups) ? user.groups
                : (() => { try { return JSON.parse(user?.groups || '[]'); } catch { return []; } })();
            const orgIds = user?.organizationId ? [user.organizationId] : [];
            if (!webpageStore.canReadWebpage(wp, userId, groups, orgIds)) return '';
        } catch (_) {
            return '';
        }
    }

    // Pull the at-rest html/css/js from the owner's RustFS prefix.
    let files = { html: '', css: '', js: '' };
    try {
        files = await webpageStore.readAllSlots(wp.userId, wp.id);
    } catch (e) {
        // Reading slots can fail (RustFS offline, etc.) — surface only metadata
        // so the model still knows which page the user is looking at.
        console.warn('[sidePanelWebpageContext] readAllSlots failed:', e.message);
    }

    const lines = [];
    lines.push('\n\n[OPEN WEBPAGE IN SIDE PANEL]');
    lines.push(`The user is currently viewing this webpage in their right-side panel — they can see it next to the chat.`);
    lines.push(`- Name: ${wp.name || 'Untitled webpage'}`);
    lines.push(`- Webpage ID: ${wp.id}`);
    if (wp.description) lines.push(`- Description: ${wp.description}`);
    lines.push(`- Editor URL: /app/studio/webpages/${wp.id}`);
    lines.push(`When the user says "this page", "deze pagina", "the webpage I have open", or similar, they mean this one. Use webpage tools (if available) to modify it, or point them to the editor URL for manual edits. Do not invent content that isn't on the page.`);

    const html = truncate(files.html);
    const css = truncate(files.css);
    const js = truncate(files.js);
    if (html) lines.push(`\n--- index.html ---\n\`\`\`html\n${html}\n\`\`\``);
    if (css)  lines.push(`\n--- style.css ---\n\`\`\`css\n${css}\n\`\`\``);
    if (js)   lines.push(`\n--- script.js ---\n\`\`\`javascript\n${js}\n\`\`\``);
    if (!html && !css && !js) {
        lines.push(`\n(The page has no html/css/js content yet — it's empty.)`);
    }
    return lines.join('\n');
}

module.exports = { buildSidePanelWebpageContext };
