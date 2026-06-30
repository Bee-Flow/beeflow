/**
 * server/core/markdown — server-side BFM (BeeFlow-Flavored Markdown) converters.
 *
 * `editorSerialization.cjs` is a self-contained esbuild bundle of the SAME
 * client serialization core (agent-hub/src/editor/serialization), so the server
 * and the new editor speak an identical Markdown dialect with zero hand-kept
 * duplication and zero runtime coupling to the frontend source tree.
 *
 *   Regenerate after changing the client serializers:
 *     cd server && npm run build:editor-md
 */
const S = require('./editorSerialization.cjs');

let _DOMParser = null;
function domParser() {
  if (_DOMParser) return _DOMParser;
  const { JSDOM } = require('jsdom');
  _DOMParser = new JSDOM('').window.DOMParser;
  return _DOMParser;
}

/** BFM Markdown → HTML (engine/export-shaped: mermaid base64 div, <img data-*>, etc.). */
function markdownToHtml(md) {
  try { return S.astToHtml(S.markdownToAst(md || '')); } catch (e) { return md || ''; }
}

/** HTML → BFM Markdown (token-efficient; understands legacy TipTap node shapes). */
function htmlToMarkdown(html) {
  try { return S.astToMarkdown(S.htmlToAst(html || '', domParser())); } catch (e) { return ''; }
}

module.exports = {
  markdownToHtml,
  htmlToMarkdown,
  markdownToAst: (md) => S.markdownToAst(md || ''),
  astToMarkdown: (ast) => S.astToMarkdown(ast),
  astToHtml: (ast) => S.astToHtml(ast),
};
