/**
 * Server-side React + Material UI bundle + document assembly.
 *
 * This is the SERVER twin of agent-hub/src/utils/buildWebpagePreview.js — it
 * produces the SAME single-inline-module + esm.sh import-map document the client
 * preview renders, but with NATIVE esbuild (not esbuild-wasm) so headless
 * Chromium (server/services/webpageRender.js) can screenshot a react-mui page
 * exactly as the user sees it.
 *
 * ⚠️  KEEP IN SYNC with agent-hub/src/utils/buildWebpagePreview.js — the version
 * pins, import map, externalisation rules, virtual-fs resolution, runtimeGuard
 * and assetResolver must stay byte-identical so the screenshot matches the live
 * preview. esbuild's onResolve/onLoad plugin API is identical between wasm and
 * native, so the only difference here is `require('esbuild')` vs lazy wasm init,
 * and the bridge head scripts (stubbed for the headless render).
 */

const esbuild = require('esbuild');

// Pinned runtime versions — MUST match buildWebpagePreview.js.
const REACT_VERSION = '18.3.1';
const MUI_VERSION = '5.16.7';
const MUI_ICONS_VERSION = '5.16.7';
const EMOTION_REACT_VERSION = '11.13.5';
const EMOTION_STYLED_VERSION = '11.13.5';
const ESM_BASE = 'https://esm.sh';
const REACT_ENTRY = 'src/main.jsx';

const EXTERNAL_SINGLETONS = 'react,react-dom,@emotion/react,@emotion/styled';

function buildImportMap() {
    return {
        imports: {
            'react': `${ESM_BASE}/react@${REACT_VERSION}`,
            'react/': `${ESM_BASE}/react@${REACT_VERSION}/`,
            'react-dom': `${ESM_BASE}/react-dom@${REACT_VERSION}?external=react`,
            'react-dom/client': `${ESM_BASE}/react-dom@${REACT_VERSION}/client?external=react`,
            '@emotion/react': `${ESM_BASE}/@emotion/react@${EMOTION_REACT_VERSION}?external=react`,
            '@emotion/react/jsx-runtime': `${ESM_BASE}/@emotion/react@${EMOTION_REACT_VERSION}/jsx-runtime?external=react`,
            '@emotion/styled': `${ESM_BASE}/@emotion/styled@${EMOTION_STYLED_VERSION}?external=react,@emotion/react`,
        },
    };
}

function isSharedSingleton(spec) {
    return spec === 'react' || spec.startsWith('react/')
        || spec === 'react-dom' || spec.startsWith('react-dom/')
        || spec === '@emotion/react' || spec.startsWith('@emotion/react/')
        || spec === '@emotion/styled' || spec.startsWith('@emotion/styled/');
}

const MUI_PINS = {
    '@mui/material': `@mui/material@${MUI_VERSION}`,
    '@mui/icons-material': `@mui/icons-material@${MUI_ICONS_VERSION}`,
    '@mui/system': `@mui/system@${MUI_VERSION}`,
    '@mui/lab': '@mui/lab@5.0.0-alpha.173',
    '@mui/base': '@mui/base@5.0.0-beta.40',
    '@mui/utils': '@mui/utils@5.16.6',
};
function pinnedSpec(spec) {
    for (const k of Object.keys(MUI_PINS)) {
        if (spec === k) return MUI_PINS[k];
        if (spec.startsWith(k + '/')) return MUI_PINS[k] + spec.slice(k.length);
    }
    return spec;
}
function esmExternalUrl(spec) {
    return `${ESM_BASE}/${pinnedSpec(spec)}?external=${EXTERNAL_SINGLETONS}`;
}

// ── Virtual filesystem resolution ──────────────────────────────────────────
const LOADER_BY_EXT = {
    jsx: 'jsx', tsx: 'tsx', ts: 'ts', mjs: 'js', cjs: 'js', js: 'jsx', json: 'json',
};
function loaderForPath(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    return LOADER_BY_EXT[ext] || 'text';
}
function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function normalize(p) {
    const parts = [];
    for (const seg of p.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
    }
    return parts.join('/');
}
function resolveImport(importer, spec, files) {
    const base = spec.startsWith('/')
        ? normalize(spec.slice(1))
        : normalize((importer ? dirname(importer) + '/' : '') + spec);
    const candidates = [
        base,
        base + '.jsx', base + '.js', base + '.tsx', base + '.ts', base + '.mjs', base + '.json', base + '.css',
        base + '/index.jsx', base + '/index.js', base + '/index.tsx', base + '/index.ts',
    ];
    for (const c of candidates) {
        if (Object.prototype.hasOwnProperty.call(files, c)) return c;
    }
    return null;
}
function cssInjectModule(css) {
    return `const __c=${JSON.stringify(css)};const __s=document.createElement('style');__s.setAttribute('data-beeflow','imported-css');__s.textContent=__c;document.head.appendChild(__s);`;
}
function virtualFsPlugin(files) {
    return {
        name: 'beeflow-virtual-fs',
        setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
                if (args.kind === 'entry-point') {
                    const resolved = resolveImport('', args.path, files);
                    if (!resolved) return { errors: [{ text: `Entry point not found: ${args.path}` }] };
                    return { path: resolved, namespace: 'vfs' };
                }
                if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
                    if (isSharedSingleton(args.path)) return { path: args.path, external: true };
                    return { path: esmExternalUrl(args.path), external: true };
                }
                const resolved = resolveImport(args.importer, args.path, files);
                if (!resolved) {
                    return { errors: [{ text: `Cannot resolve "${args.path}" from "${args.importer || 'entry'}". Create that file (imports must include the extension, e.g. './App.jsx').` }] };
                }
                return { path: resolved, namespace: 'vfs' };
            });

            build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
                const entry = files[args.path];
                if (!entry) return { errors: [{ text: `File not found: ${args.path}` }] };
                if (/\.css$/i.test(args.path)) {
                    return { contents: cssInjectModule(entry.content || ''), loader: 'js' };
                }
                if (entry.isText) {
                    return { contents: entry.content || '', loader: loaderForPath(args.path) };
                }
                return { contents: `export default ${JSON.stringify(entry.dataUrl || '')};`, loader: 'js' };
            });
        },
    };
}

/**
 * Bundle the react-mui project (files map) into one ESM string. Throws an Error
 * whose `.formatted` carries readable esbuild diagnostics on failure.
 */
async function buildReactBundle({ entry = REACT_ENTRY, files }) {
    let result;
    try {
        result = await esbuild.build({
            entryPoints: [entry],
            bundle: true,
            format: 'esm',
            jsx: 'automatic',
            write: false,
            logLevel: 'silent',
            target: 'es2020',
            plugins: [virtualFsPlugin(files)],
        });
    } catch (e) {
        const msgs = Array.isArray(e?.errors) && e.errors.length
            ? e.errors.map((x) => x.text).join('\n')
            : (e?.message || String(e));
        const err = new Error('esbuild bundle failed');
        err.formatted = msgs;
        throw err;
    }
    const out = result.outputFiles && result.outputFiles[0];
    return { code: out ? out.text : '', warnings: result.warnings || [] };
}

// ── Document assembly (ported from buildWebpagePreview.js) ──────────────────
function defangScriptClose(jsContent) {
    return String(jsContent || '').replace(/<\/script/gi, '<\\/script');
}

function runtimeGuardScript() {
    return `<script>(function(){
  var shown = false;
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function rootEmpty(){ var r=document.getElementById('root'); return r && (!r.children || r.children.length===0); }
  function show(title, detail){
    if (shown || !rootEmpty()) return; shown = true;
    var r = document.getElementById('root');
    r.innerHTML = '<div data-beeflow-guard="1" style="position:fixed;inset:0;display:flex;align-items:flex-start;justify-content:center;padding:24px;background:#fef2f2;color:#b91c1c;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto">'
      + '<div style="max-width:680px;width:100%"><div style="font-weight:600;margin-bottom:8px">'+esc(title)+'</div>'
      + (detail ? '<pre style="white-space:pre-wrap;word-break:break-word;margin:0">'+esc(detail)+'</pre>' : '')
      + '</div></div>';
  }
  window.addEventListener('error', function(e){
    var where = e && e.filename ? ' ('+e.filename+(e.lineno?':'+e.lineno:'')+')' : '';
    show('The app crashed while loading', ((e && e.message) || 'Script error') + where);
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    var reason = e && e.reason; show('Unhandled error', (reason && (reason.stack || reason.message)) || String(reason));
  });
  // NOTE: unlike the client preview, the SERVER render intentionally OMITS the
  // timed "rendered nothing" fallback — the screenshot service controls timing
  // and waits for a real mount, so a slow (cold esm.sh) MUI load must not be
  // painted as a false error. The error handlers above still catch real crashes.
})();<\/script>`;
}

function assetResolverScript(assetMap) {
    if (!assetMap || Object.keys(assetMap).length === 0) return '';
    return `<script>(function(){
  var M = ${JSON.stringify(assetMap)};
  function lookup(u){
    if(!u) return null;
    u = String(u);
    var low = u.toLowerCase();
    if(low.indexOf('data:')===0 || low.indexOf('blob:')===0 || low.indexOf('http')===0 || low.indexOf('//')===0) return null;
    var key = u.split('?')[0].split('#')[0];
    if(key.indexOf('./')===0) key = key.slice(2);
    while(key.indexOf('/')===0) key = key.slice(1);
    if(M[key]) return M[key];
    if(M['assets/'+key]) return M['assets/'+key];
    var seg = key.split('/').pop();
    if(seg && M['assets/'+seg]) return M['assets/'+seg];
    return null;
  }
  function fixEl(el){
    if(!el || el.nodeType!==1 || !el.getAttribute) return;
    var s = el.getAttribute('src');
    if(s){ var d=lookup(s); if(d && d!==s) el.setAttribute('src', d); }
    if(el.tagName==='LINK'){ var h=el.getAttribute('href'); if(h){ var dh=lookup(h); if(dh) el.setAttribute('href', dh); } }
    var st = el.getAttribute('style');
    if(st && st.indexOf('url(')>-1){
      var ns = st.replace(/url\\(([^)]*)\\)/g, function(m,p){ var c=p.replace(/['"]/g,'').trim(); var du=lookup(c); return du?('url('+du+')'):m; });
      if(ns!==st) el.setAttribute('style', ns);
    }
  }
  function scan(root){ try{ fixEl(root); if(root.querySelectorAll){ var all=root.querySelectorAll('[src],link[href],[style]'); for(var i=0;i<all.length;i++) fixEl(all[i]); } }catch(e){} }
  try{
    var mo = new MutationObserver(function(muts){ for(var i=0;i<muts.length;i++){ var m=muts[i]; if(m.type==='attributes') fixEl(m.target); var an=m.addedNodes; if(an) for(var j=0;j<an.length;j++) scan(an[j]); } });
    function start(){ scan(document); try{ mo.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href','style']}); }catch(e){} }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', start); else start();
  }catch(e){}
  document.addEventListener('error', function(e){
    var t = e.target;
    if(t && t.tagName==='IMG'){ var d=lookup(t.getAttribute('src')); if(d && t.getAttribute('src')!==d){ t.setAttribute('src', d); } }
  }, true);
})();<\/script>`;
}

/**
 * No-op platform bridges for the HEADLESS render. The bf-browser is network-
 * isolated from the API, so a page that calls window.beeflowDB/App on mount
 * would hang/throw and render blank. Stub them to resolve to empty data so the
 * page renders its shell/chrome. (NOT the real buildBridgeHeadScripts — that
 * returns '' when tokens are missing, leaving the bridges undefined.)
 */
function buildStubBridgeScript() {
    return `<script>(function(){
  var noop = function(){ return Promise.resolve(); };
  window.beeflowDB = { query:function(){return Promise.resolve([]);}, exec:function(){return Promise.resolve({changes:0});}, batch:function(){return Promise.resolve([]);} };
  window.beeflowApp = { call:function(){return Promise.resolve({});} };
  window.beeflowAI = { complete:noop, ground:noop, generate:noop };
  window.beeflowAutomations = { run:noop, list:function(){return Promise.resolve([]);} };
  try { window.beeflowIntegrations = new Proxy({}, { get:function(){ return noop; } }); }
  catch(e){ window.beeflowIntegrations = {}; }
})();<\/script>`;
}

function shellDoc({ headScripts, importMap, bodyHtml }) {
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${headScripts}
<script type="importmap">${JSON.stringify(importMap)}<\/script>
<style>html,body{height:100%;margin:0}#root{min-height:100%}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}</style>
</head><body>
${bodyHtml}
</body></html>`;
}

/**
 * Compose the full react-mui HTML document for a headless screenshot. Returns
 * { doc } on success, or { buildError } (esbuild diagnostics) on bundle failure.
 *
 * @param {object} opts
 * @param {Object<string,{isText:boolean,content?:string,dataUrl?:string}>} opts.files
 * @param {Object<string,string>} opts.assetMap  path → data: URL for binary assets
 */
async function composeReactDoc({ files, assetMap = {} }) {
    if (!files[REACT_ENTRY]) {
        return { buildError: `No entry point: ${REACT_ENTRY} is missing. A react-mui project must have src/main.jsx that mounts the app into #root.` };
    }
    let bundle;
    try {
        const r = await buildReactBundle({ entry: REACT_ENTRY, files });
        bundle = r.code;
    } catch (e) {
        return { buildError: e.formatted || e.message || String(e) };
    }
    const bodyHtml = `<div id="root"></div>
${runtimeGuardScript()}
${assetResolverScript(assetMap)}
<script type="module">
${defangScriptClose(bundle)}
<\/script>`;
    const doc = shellDoc({
        headScripts: buildStubBridgeScript(),
        importMap: buildImportMap(),
        bodyHtml,
    });
    return { doc };
}

module.exports = {
    REACT_ENTRY,
    buildReactBundle,
    buildImportMap,
    composeReactDoc,
    buildStubBridgeScript,
    // test/debug
    _internals: { virtualFsPlugin, resolveImport, esmExternalUrl, pinnedSpec },
};
