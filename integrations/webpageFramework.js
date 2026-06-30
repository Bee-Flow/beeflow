/**
 * Webpage framework + runtime-tier model.
 *
 * A webpage project is one of two FRAMEWORKS:
 *   • 'vanilla'   — plain HTML/CSS/JS, inlined into a sandboxed srcdoc (the classic behaviour)
 *   • 'react-mui' — a React + Material UI app, authored as ES-module source under src/
 *
 * ...and runs in one of two RUNTIME tiers:
 *   • 'light' — no server container. Vanilla srcdoc, or (react-mui) an in-browser
 *               esbuild-wasm bundle. api/*.js handlers run in a constrained isolate.
 *   • 'full'  — a real per-project Node.js container (Vite dev server + Node backend),
 *               for arbitrary npm packages and a real custom server.
 *
 * Both live in the existing `webpages.settings` JSONB (no schema change). An
 * absent/unknown value resolves to 'vanilla' / 'light', so every pre-existing
 * webpage keeps behaving exactly as before.
 *
 * Single source of truth for: the defaults, the prompt blocks that tell the AI
 * how to build for each framework, and the tools that switch a project's mode.
 * Reused by routes/ai/webpageChat.js (and, later, the compose + runtime layers).
 */

const webpageStore = require('../stores/webpageStore');

const FRAMEWORKS = ['vanilla', 'react-mui'];
const RUNTIMES = ['light', 'full'];

const DEFAULT_FRAMEWORK = 'vanilla';
const DEFAULT_RUNTIME = 'light';

// What a brand-NEW project is created as. React + MUI is the product default
// (the WS-B esbuild-wasm light-tier preview is in place). A brand-new react-mui
// project has no src/main.jsx yet, so its preview shows a friendly "create
// src/main.jsx" overlay until the AI scaffolds the app on the first request.
// To revert to the classic static builder default, set this back to 'vanilla'.
const DEFAULT_NEW_FRAMEWORK = 'react-mui';

function resolveFramework(webpage) {
    const f = webpage?.settings?.framework;
    return FRAMEWORKS.includes(f) ? f : DEFAULT_FRAMEWORK;
}

function resolveRuntime(webpage) {
    const r = webpage?.settings?.runtime;
    return RUNTIMES.includes(r) ? r : DEFAULT_RUNTIME;
}

const DIVIDER = '────────────────────────────────────────';

/**
 * Shared IMAGES & ASSETS rule (both frameworks). Now that users can upload
 * binary assets, the model should enumerate + reference them instead of being
 * told to avoid real images entirely.
 */
function sharedImageRule() {
    return `IMAGES & ASSETS — the user can upload images, fonts and other binary files into this project. Call \`webpage_list_assets\` to see what exists (each asset's path + MIME type) and USE those uploaded assets at their real path. Only when no suitable uploaded asset exists, fall back to inline SVG, CSS gradients/shapes or emoji for decoration, or a deterministic placeholder (https://placehold.co/WIDTHxHEIGHT) when a raster is genuinely needed. NEVER invent or hotlink arbitrary external <img> URLs (random unsplash/example.com/stock paths) — they 404 or load the wrong picture. Add an onerror handler to any external <img> so a failed load degrades gracefully, e.g. onerror="this.style.visibility='hidden'". For internal navigation, only link to anchor ids that actually exist in the page (every href="#x" must have a matching id="x").`;
}

/**
 * VANILLA runtime block — the classic HTML/CSS/JS contract. Kept faithful to the
 * long-standing prompt so vanilla projects behave exactly as before; only the
 * IMAGES rule is swapped for the asset-aware shared version above.
 */
function vanillaRuntimePrompt({ filesBlock }) {
    return `${DIVIDER}
RUNTIME CONSTRAINTS — READ ONCE, OBEY ALWAYS
${DIVIDER}
1. Vanilla HTML / CSS / JavaScript only. There is NO build step. (If the user wants React or Material UI, call \`webpage_set_framework({ framework: "react-mui" })\` first — that switches this project to a React runtime with a different file layout.)
2. NO package installation. No \`npm install\`, no \`yarn add\`, no \`require()\` of node modules, no bundler. If you need a library, use a CDN \`<script>\` tag inside the HTML (e.g. \`<script src="https://cdn.jsdelivr.net/...">\`).
3. NO TypeScript, JSX, SCSS, LESS, or any language that needs compilation.
4. The preview iframe runs with \`sandbox="allow-scripts allow-forms"\` and NO \`allow-same-origin\`. That means:
   - \`document.cookie\`, \`localStorage\`, \`sessionStorage\` are unavailable inside the page.
   - \`fetch()\` to the host app or any same-origin URL fails (CORS / opaque origin).
   - \`parent.window\` access throws SecurityError.
   - \`<form>\` is allowed but submission cannot navigate to a real URL (target origin is \`null\`). ALWAYS call \`event.preventDefault()\` in the form's submit handler and do the actual work via \`window.beeflowDB\` / fetch-to-CDN / in-page state. Never rely on the form's \`action\` attribute.
   Use in-memory variables for state. CDN fetches are allowed.
5. Reference styles and scripts however you like — \`<link href="style.css">\` and \`<script src="script.js"></script>\` work in the downloaded zip; the in-app preview inlines them automatically.
6. Default to a clean, modern aesthetic when the user's brief is sparse: sensible spacing, readable typography, accessible color contrast (WCAG AA), responsive on mobile.
7. BEE FLOW HOUSE STYLE — apply this by default unless the user specifies their own look. A calm, professional productivity-tool aesthetic: a restrained palette declared as CSS custom properties in :root (a single brand accent colour, a dark neutral for text, light neutrals for surfaces), generous whitespace, a modern sans-serif system font stack, rounded corners and subtle shadows. Do NOT use purple, violet, or indigo. Define tokens once in modules/theme.css (or style.css :root) and reference them everywhere so the page is consistently branded.
8. ${sharedImageRule()}

${DIVIDER}
FILES — DEFAULT TO MODULAR LAYOUTS
${DIVIDER}
${filesBlock}

The three primary slots (\`index.html\`, \`style.css\`, \`script.js\`) are the entry points. They should stay small — wire components together, hold the top-level layout, declare the runtime config. Anything bigger than a few sections of CSS, more than a handful of UI sections, or any logic that has its own identity belongs in its own file under a sensible folder. Smaller files = surgical partial edits, less context noise per turn, less risk of clobbering unrelated code.

Recommended starter layout, even for "small" pages:
  components/        HTML partials for individual sections (hero, features, footer, …) — see RUNTIME CONTRACT below
  modules/           Focused JS files (state.js, ui.js, api.js, …) referenced from index.html via <script src="…">
  modules/           …or stylesheet partials (theme.css, layout.css, components.css) referenced via <link href="…">
  data/              .json content the script reads (menu.json, copy.json, …)
  assets/            images, fonts, SVGs

Rule of thumb: aim for files under ~200 lines. If a slot or extra file is creeping past that and the content is coherent enough to split, split it.

${DIVIDER}
RUNTIME CONTRACT FOR EXTRAS — read carefully, get this wrong and the preview breaks
${DIVIDER}
The preview iframe runs sandboxed with NO same-origin, so it CANNOT \`fetch()\` extra files. Extras are inlined into the page at compose time, only when their path is referenced by a recognised tag in \`index.html\`:

• CSS extras → reference via \`<link rel="stylesheet" href="modules/theme.css">\` in index.html. The compiler substitutes the link with an inline <style> block.
• JS extras → reference via \`<script src="modules/state.js"></script>\` in index.html. Substituted with an inline <script>.
• Binary assets (images, fonts, SVGs, audio…) → reference via \`src=\` / \`href=\` on any tag. Substituted with a data: URL.
• .json / .md / other text extras → only usable by JS that embeds them as a string at build/edit time. They are NOT auto-fetched. If script.js needs the JSON, paste the parsed object into a \`<script>\` block in index.html (e.g. \`<script>window.__menu = { ... };</script>\`) or hardcode it in modules/state.js. Do NOT write \`fetch("data/menu.json")\` — it will fail silently.
• HTML partials in \`components/*.html\` are NOT auto-inlined. Treat them as your own reference scratchpad: write the component there, then copy/paste the markup into index.html at the right location. Updating the partial alone will NOT update the page; you must edit index.html for the change to show.`;
}

/**
 * REACT-MUI runtime block — React 18 + Material UI authored as ES-module source.
 * The light tier bundles this in the browser (esbuild-wasm) with imports resolved
 * via an import map; the full tier runs a real Vite dev server in a container.
 */
function reactMuiRuntimePrompt({ filesBlock, runtime }) {
    const runtimeNote = runtime === 'full'
        ? `RUNTIME TIER: FULL — this project runs in a real per-project Node.js container with a Vite dev server. You MAY use any npm package (add it to package.json dependencies) and author a real Node backend under \`server/\` or \`api/\`. The container is resource-capped and idle-reaped, so keep dependencies lean.`
        : `RUNTIME TIER: LIGHT — the React app is bundled in the browser (esbuild) and the only importable packages are the ones listed below. There is no npm install. For a backend, write \`api/*.js\` request handlers (they run in a constrained server-side isolate with the per-page SQLite + the platform bridges). If the user needs an arbitrary npm package or a real custom Node server, call \`webpage_set_runtime({ runtime: "full" })\` first.`;

    return `${DIVIDER}
RUNTIME — REACT + MATERIAL UI (no manual install, no hand-rolled build)
${DIVIDER}
This project renders as a React app. ${runtimeNote}

WHAT IS IMPORTABLE (already wired — never add CDN <script> tags for these):
• \`react\`, \`react-dom\`, \`react-dom/client\`
• \`@mui/material\` and any subpath (\`@mui/material/Button\`, \`@mui/material/styles\`, …)
• \`@mui/icons-material\` and any icon subpath (\`@mui/icons-material/Home\`)
• \`@emotion/react\`, \`@emotion/styled\` (MUI's styling engine — already wired)

FILE LAYOUT (create these as extras with \`webpage_create_file\`):
• \`src/main.jsx\` — REQUIRED entry. Mounts <App/> into #root:
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import App from './App.jsx';
    createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
• \`src/App.jsx\` — top-level component.
• \`src/components/*.jsx\`, \`src/hooks/*.js\`, \`src/lib/*.js\`, \`src/theme.js\` — split components + logic into their own files.
• \`src/*.css\` — \`import './styles.css'\` for side-effect styles (injected as <style>).

IMPORT CONTRACT (get this wrong and the app shows a blank screen):
• Relative imports MUST include the extension: \`import Header from './components/Header.jsx'\` (NOT \`'./components/Header'\`). The resolver is exact-match.
• Every \`.jsx\`/\`.js\` you import MUST exist as a project file before the app can render — create the imported file in the SAME turn you reference it.
• In the light tier, the ONLY bare imports allowed are the importable packages above; any other bare import fails (there is no installer — switch to the full tier for npm packages).

THE THREE PRIMARY SLOTS in a react-mui project — IMPORTANT:
• \`index.html\`, \`style.css\` and \`script.js\` are IGNORED by the React preview. Anything you write into them does NOT render. NEVER call webpage_file_write on them and never try to build the page there — the preview auto-generates index.html (with <div id="root">, the import map and the entry bootstrap). Build the ENTIRE app under \`src/\`.
• So the very first files to create for a new page are \`src/main.jsx\` (the entry) and \`src/App.jsx\`. Styling lives in MUI \`sx\`/\`styled\` or imported \`src/*.css\`; all logic lives in \`src/*.jsx\`.

HOUSE STYLE in MUI: build a theme with \`createTheme\` in \`src/theme.js\`, wrap <App/> in <ThemeProvider> + <CssBaseline/>. MUI's DEFAULT palette is indigo/purple — that violates the house style — so you MUST override \`palette.primary\` (and \`secondary\`) to a calm brand accent with dark-neutral text on light-neutral surfaces, and never import the \`indigo\`/\`deepPurple\` colour modules. Generous spacing, rounded corners (\`shape.borderRadius\`), subtle shadows, a system sans-serif \`typography.fontFamily\`. Do NOT use purple, violet or indigo anywhere.

PLATFORM BRIDGES from React: \`window.beeflowDB\`, \`window.beeflowAI\`, \`window.beeflowAutomations\`, \`window.beeflowIntegrations\` are defined on \`window\` BEFORE your entry module runs. Call them from effects/handlers exactly as in vanilla, e.g. \`useEffect(() => { window.beeflowDB.query('SELECT * FROM notes').then(setRows); }, [])\`. They are async (return Promises); the same acts-as-author + bridge-grant rules apply (see PLATFORM BRIDGES below).

CUSTOM BACKEND — \`api/<route>.js\` handlers (light tier): write a server-side endpoint as an extra file \`api/save.js\` that exports \`async function main(req, ctx)\`:
   • \`req\` = { method, path, query, body }   (body is the parsed JSON the page POSTed)
   • \`ctx.db.query(sql, params)\` / \`ctx.db.exec(...)\` / \`ctx.db.batch(...)\` — the per-page SQLite
   • \`ctx.integrations.<granted_tool>(args)\` — the author's granted integrations (acts-as-author)
   • \`ctx.http(url, opts)\` — HTTPS-only fetch; \`ctx.log(...)\`
   • return \`{ status: 200, body: {...} }\` (or just return a value → 200)
The handler runs server-side in a sandbox (no npm, no Node APIs, hard CPU/memory/time limits). The React app calls it with \`await window.beeflowApp.call("save", { ... })\` → resolves to the handler's body. Use this for logic that must stay server-side (writing to the DB transactionally, calling an integration with secrets) instead of doing it from the page. For arbitrary npm packages or a long-running server, switch to the full runtime tier.

${sharedImageRule()}

CURRENT FILES:
${filesBlock}`;
}

/**
 * Build the framework-specific middle of the system prompt (runtime constraints
 * + file layout + contract). Everything else in the prompt (editing tools,
 * SQLite, bridges, planning, knowledge) is shared and stays in webpageChat.js.
 */
function buildRuntimePromptBlock({ framework, runtime, filesBlock }) {
    if (framework === 'react-mui') {
        return reactMuiRuntimePrompt({ filesBlock, runtime });
    }
    return vanillaRuntimePrompt({ filesBlock });
}

// ── Tools: switch a project's framework / runtime ──────────────────────────

const WEBPAGE_SET_FRAMEWORK_TOOL = {
    type: 'function',
    function: {
        name: 'webpage_set_framework',
        description: "Set this webpage project's framework. 'vanilla' = plain HTML/CSS/JS (CDN libs, inlined extras — the classic mode). 'react-mui' = a React + Material UI app: you author src/main.jsx (entry), src/App.jsx and components under src/, imports of react / react-dom / @mui/material / @mui/icons-material / @emotion resolve automatically, and index.html is generated for you. Call this BEFORE building when the user asks for React or Material UI, or to convert an existing project. Switching does NOT delete files, but the two modes use different entry layouts — after switching to react-mui, create src/main.jsx and src/App.jsx.",
        parameters: {
            type: 'object',
            properties: {
                framework: { type: 'string', enum: FRAMEWORKS, description: 'The framework to use for this project.' },
            },
            required: ['framework'],
        },
    },
};

const WEBPAGE_SET_RUNTIME_TOOL = {
    type: 'function',
    function: {
        name: 'webpage_set_runtime',
        description: "Set this project's runtime tier. 'light' (default) = NO server container — the page runs in the sandboxed preview and api/*.js handlers run in a constrained isolate; ideal for forms, CRUD over the per-page SQLite, and the platform bridges. 'full' = a real per-project Node.js container with a Vite dev server and a real backend — use ONLY when the user needs npm packages, a custom Node server, or capabilities the light tier can't provide. The full tier consumes real server resources (capped + idle-reaped), so stay on 'light' unless a real backend is genuinely required.",
        parameters: {
            type: 'object',
            properties: {
                runtime: { type: 'string', enum: RUNTIMES, description: 'The runtime tier to use.' },
            },
            required: ['runtime'],
        },
    },
};

const FRAMEWORK_TOOL_NAMES = new Set(['webpage_set_framework', 'webpage_set_runtime']);
function isFrameworkTool(name) {
    return FRAMEWORK_TOOL_NAMES.has(name);
}

/**
 * Execute a framework/runtime switch. Reads the current settings and MERGES
 * (settings is a wholesale-overwrite column, so a naive write would clobber
 * other keys). Returns an envelope with `_action` so the chat handler can emit
 * the matching SSE event and the preview can recompose/relaunch.
 */
async function executeFrameworkTool(toolName, args, { webpageId, userId }) {
    const wp = await webpageStore.getWebpage(webpageId, userId);
    if (!wp) return { error: 'Webpage not found.' };
    const settings = { ...(wp.settings || {}) };

    if (toolName === 'webpage_set_framework') {
        const framework = args?.framework;
        if (!FRAMEWORKS.includes(framework)) return { error: `framework must be one of: ${FRAMEWORKS.join(', ')}.` };
        settings.framework = framework;
        await webpageStore.updateWebpageMetadata(webpageId, userId, { settings });
        return {
            _action: 'webpage_framework_changed',
            framework,
            message: framework === 'react-mui'
                ? 'Project switched to React + Material UI. Now create src/main.jsx (the entry) and src/App.jsx, then build the app under src/.'
                : 'Project switched to vanilla HTML/CSS/JS. Put your markup back in index.html.',
        };
    }

    if (toolName === 'webpage_set_runtime') {
        const runtime = args?.runtime;
        if (!RUNTIMES.includes(runtime)) return { error: `runtime must be one of: ${RUNTIMES.join(', ')}.` };
        settings.runtime = runtime;
        await webpageStore.updateWebpageMetadata(webpageId, userId, { settings });
        return {
            _action: 'webpage_runtime_changed',
            runtime,
            message: runtime === 'full'
                ? 'Project switched to the FULL runtime tier (a real per-project Node.js container). You can now use npm packages and a real Node backend. Keep dependencies lean.'
                : 'Project switched to the LIGHT runtime tier (no container). Backends run as api/*.js handlers in a constrained isolate.',
        };
    }

    return { error: `Unknown framework tool: ${toolName}` };
}

module.exports = {
    FRAMEWORKS,
    RUNTIMES,
    DEFAULT_FRAMEWORK,
    DEFAULT_RUNTIME,
    DEFAULT_NEW_FRAMEWORK,
    resolveFramework,
    resolveRuntime,
    sharedImageRule,
    buildRuntimePromptBlock,
    WEBPAGE_SET_FRAMEWORK_TOOL,
    WEBPAGE_SET_RUNTIME_TOOL,
    isFrameworkTool,
    executeFrameworkTool,
};
