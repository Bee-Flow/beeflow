"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../agent-hub/src/editor/serialization/index.js
var index_exports = {};
__export(index_exports, {
  astToHtml: () => astToHtml,
  astToMarkdown: () => astToMarkdown,
  decodeFromAttr: () => decodeFromAttr,
  encodeForAttr: () => encodeForAttr,
  escapeAttr: () => escapeAttr,
  escapeHtml: () => escapeHtml,
  escapeMdText: () => escapeMdText,
  htmlToAst: () => htmlToAst,
  markdownToAst: () => markdownToAst
});
module.exports = __toCommonJS(index_exports);

// ../agent-hub/src/editor/model/schema.js
var NODE_SCHEMA = {
  doc: { group: "block", content: "block" },
  paragraph: { group: "block", content: "inline", textblock: true, marks: "_all_", defaults: { align: null } },
  heading: { group: "block", content: "inline", textblock: true, marks: "_all_", defaults: { level: 1, align: null } },
  bulletList: { group: "block", content: "block", defaults: { tight: true } },
  orderedList: { group: "block", content: "block", defaults: { start: 1, tight: true } },
  listItem: { group: "block", content: "block" },
  taskList: { group: "block", content: "block" },
  taskItem: { group: "block", content: "block", defaults: { checked: false } },
  blockquote: { group: "block", content: "block" },
  codeBlock: { group: "block", content: "text", textblock: true, code: true, marks: "none", defaults: { language: null } },
  horizontalRule: { group: "block", atom: true },
  table: { group: "block", content: "block" },
  tableRow: { group: "block", content: "block" },
  tableCell: { group: "block", content: "block", defaults: { header: false, align: null, colspan: 1, rowspan: 1, colwidth: null } },
  image: { group: "block", atom: true, defaults: { src: null, alt: null, title: null, width: null, alignment: "center", textWrap: false } },
  mermaid: { group: "block", atom: true, defaults: { code: "" } },
  mathBlock: { group: "block", atom: true, defaults: { latex: "" } },
  // Data chart (built from a table snapshot). `spec` is a JSON string
  // {type,title,labels,series}; round-trips Markdown as a ```chart fenced block.
  chart: { group: "block", atom: true, defaults: { spec: "" } },
  text: { group: "inline" },
  hardBreak: { group: "inline", atom: true },
  mathInline: { group: "inline", atom: true, defaults: { latex: "" } },
  // Spreadsheet formula (table cells). `src` is the canonical `=…` text (round-trips
  // Markdown); `value`/`error` are transient computed display, set by normalize.
  formula: { group: "inline", atom: true, defaults: { src: "", value: "", error: false } }
};
var MARK_SCHEMA = {
  link: { order: 0, defaults: { href: "", target: "_blank", rel: "noopener noreferrer" } },
  highlight: { order: 1, defaults: { color: null } },
  textStyle: { order: 2, defaults: { color: null, fontFamily: null } },
  underline: { order: 3 },
  bold: { order: 4 },
  italic: { order: 5 },
  strike: { order: 6 },
  code: { order: 7, excludes: ["bold", "italic", "underline", "strike", "link", "highlight", "textStyle"] }
};
function nodeDefaults(type) {
  return { ...NODE_SCHEMA[type]?.defaults || {} };
}
function markDefaults(type) {
  return { ...MARK_SCHEMA[type]?.defaults || {} };
}
function markOrder(type) {
  return MARK_SCHEMA[type]?.order ?? 99;
}

// ../agent-hub/src/editor/model/marks.js
function mark(type, attrs) {
  const d = markDefaults(type);
  const a = { ...d, ...attrs || {} };
  for (const k of Object.keys(a)) {
    if (a[k] === d[k]) delete a[k];
  }
  return Object.keys(a).length ? { type, attrs: a } : { type };
}
function markEq(a, b) {
  if (a.type !== b.type) return false;
  const aa = a.attrs || {}, ba = b.attrs || {};
  const keys = /* @__PURE__ */ new Set([...Object.keys(aa), ...Object.keys(ba)]);
  for (const k of keys) {
    if (aa[k] !== ba[k]) return false;
  }
  return true;
}
function sameMarkSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((m) => b.some((n) => markEq(m, n)));
}
function sortMarks(marks = []) {
  return [...marks].sort((a, b) => markOrder(a.type) - markOrder(b.type));
}
function addMark(marks = [], m) {
  const excl = new Set(MARK_SCHEMA[m.type]?.excludes || []);
  const kept = marks.filter((x) => x.type !== m.type && !excl.has(x.type));
  const filtered = kept.filter((x) => !(MARK_SCHEMA[x.type]?.excludes || []).includes(m.type));
  return sortMarks([...filtered, m]);
}
function getMark(marks = [], type) {
  return marks.find((x) => x.type === type) || null;
}

// ../agent-hub/src/editor/model/nodes.js
function node(type, attrs, content) {
  const out = { type };
  if (attrs) {
    const d = nodeDefaults(type);
    const a = {};
    for (const k of Object.keys(attrs)) {
      if (attrs[k] !== void 0 && attrs[k] !== d[k]) a[k] = attrs[k];
    }
    if (Object.keys(a).length) out.attrs = a;
  }
  if (content !== void 0) out.content = content;
  return out;
}
var doc = (content = []) => node("doc", null, content);
var emptyParagraph = () => node("paragraph", null, []);
function attr(n, key) {
  if (n.attrs && key in n.attrs) return n.attrs[key];
  return nodeDefaults(n.type)[key];
}

// ../agent-hub/src/editor/serialization/mdToAst.js
function markdownToAst(md) {
  const src = String(md == null ? "" : md).replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const blocks = parseBlocks(lines);
  if (!blocks.length) blocks.push(emptyParagraph());
  return doc(blocks);
}
function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (isBlank(ln)) {
      i++;
      continue;
    }
    const fence = ln.match(/^( {0,3})(`{3,}|~{3,})\s*([^\n]*)$/);
    if (fence) {
      const r2 = parseFence(lines, i, fence);
      out.push(r2.node);
      i = r2.next;
      continue;
    }
    if (/^\$\$/.test(ln)) {
      const r2 = parseMathBlock(lines, i);
      out.push(r2.node);
      i = r2.next;
      continue;
    }
    const h = ln.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      out.push(parseHeading(h));
      i++;
      continue;
    }
    if (/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(ln)) {
      out.push(node("horizontalRule"));
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(ln)) {
      const r2 = parseBlockquote(lines, i);
      out.push(r2.node);
      i = r2.next;
      continue;
    }
    if (ln.includes("|") && i + 1 < lines.length && isAlignRow(lines[i + 1])) {
      const r2 = parseTable(lines, i);
      out.push(r2.node);
      i = r2.next;
      continue;
    }
    if (matchListMarker(ln)) {
      const r2 = parseList(lines, i);
      out.push(r2.node);
      i = r2.next;
      continue;
    }
    const r = parseParagraph(lines, i);
    if (r.node) out.push(r.node);
    i = r.next;
  }
  return out;
}
function parseFence(lines, i, fence) {
  const marker = fence[2][0];
  const len = fence[2].length;
  const info = fence[3].trim();
  const body = [];
  let j = i + 1;
  while (j < lines.length) {
    const cl = lines[j].match(/^( {0,3})(`{3,}|~{3,})\s*$/);
    if (cl && cl[2][0] === marker && cl[2].length >= len) {
      j++;
      break;
    }
    body.push(lines[j]);
    j++;
  }
  const code = body.join("\n");
  if (/^mermaid$/i.test(info)) return { node: node("mermaid", { code }), next: j };
  if (/^chart$/i.test(info)) return { node: node("chart", { spec: code }), next: j };
  return { node: node("codeBlock", info ? { language: info } : null, [{ type: "text", text: code }]), next: j };
}
function parseMathBlock(lines, i) {
  const single = lines[i].match(/^\$\$(.+)\$\$\s*$/);
  if (single) return { node: node("mathBlock", { latex: single[1].trim() }), next: i + 1 };
  const body = [];
  let j = i + 1;
  while (j < lines.length) {
    if (/^\$\$\s*$/.test(lines[j])) {
      j++;
      break;
    }
    body.push(lines[j]);
    j++;
  }
  return { node: node("mathBlock", { latex: body.join("\n").trim() }), next: j };
}
function parseHeading(h) {
  const level = Math.min(3, h[1].length);
  const { text, align } = extractBlockAlign(h[2]);
  return node("heading", { level, align }, parseInline(text));
}
function extractBlockAlign(text) {
  const m = text.match(/^(.*?)\s*\{align=(left|center|right)\}\s*$/);
  if (m) return { text: m[1], align: m[2] === "left" ? null : m[2] };
  return { text, align: null };
}
function parseBlockquote(lines, i) {
  const inner = [];
  let j = i;
  while (j < lines.length && /^ {0,3}>/.test(lines[j])) {
    inner.push(lines[j].replace(/^ {0,3}>\s?/, ""));
    j++;
  }
  return { node: node("blockquote", null, parseBlocks(inner)), next: j };
}
function parseParagraph(lines, i) {
  const buf = [];
  let j = i;
  while (j < lines.length) {
    const ln = lines[j];
    if (isBlank(ln)) break;
    if (j !== i && isBlockStart(lines, j)) break;
    buf.push(ln);
    j++;
  }
  const raw = buf.join("\n");
  const { text, align } = extractBlockAlign(raw);
  const imgOnly = text.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)(\{[^}]*\})?$/);
  if (imgOnly) return { node: parseImageMatch(imgOnly), next: j };
  return { node: node("paragraph", align ? { align } : null, parseInline(text)), next: j };
}
function isBlockStart(lines, j) {
  const ln = lines[j];
  if (/^ {0,3}(`{3,}|~{3,})/.test(ln)) return true;
  if (/^#{1,6}\s+/.test(ln)) return true;
  if (/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/.test(ln)) return true;
  if (/^ {0,3}>/.test(ln)) return true;
  if (matchListMarker(ln)) return true;
  if (/^\$\$/.test(ln)) return true;
  if (ln.includes("|") && j + 1 < lines.length && isAlignRow(lines[j + 1])) return true;
  return false;
}
function matchListMarker(line) {
  const mb = line.match(/^( *)([-*+]) +/);
  if (mb) {
    const indent = mb[1].length;
    const markerEnd = mb[0].length;
    const rest = line.slice(markerEnd);
    const task = rest.match(/^\[([ xX])\]\s+/);
    if (task) {
      const contentCol = markerEnd + task[0].length;
      return { indent, ordered: false, task: true, checked: task[1].toLowerCase() === "x", contentCol, content: line.slice(contentCol) };
    }
    return { indent, ordered: false, task: false, contentCol: markerEnd, content: rest };
  }
  const mo = line.match(/^( *)(\d+)([.)]) +/);
  if (mo) {
    return { indent: mo[1].length, ordered: true, start: parseInt(mo[2], 10), task: false, contentCol: mo[0].length, content: line.slice(mo[0].length) };
  }
  return null;
}
function parseList(lines, i) {
  const base = matchListMarker(lines[i]);
  const ordered = base.ordered;
  const baseIndent = base.indent;
  const isTask = base.task;
  const start = base.start || 1;
  const items = [];
  while (i < lines.length) {
    const lm = matchListMarker(lines[i]);
    if (!lm || lm.ordered !== ordered || lm.indent !== baseIndent || lm.task !== isTask) break;
    const contentCol = lm.contentCol;
    const itemLines = [lm.content];
    i++;
    while (i < lines.length) {
      const ln = lines[i];
      if (isBlank(ln)) {
        let k = i;
        while (k < lines.length && isBlank(lines[k])) k++;
        if (k < lines.length && leadingSpaces(lines[k]) >= contentCol) {
          itemLines.push("");
          i++;
          continue;
        }
        break;
      }
      const child = matchListMarker(ln);
      if (child && child.indent <= baseIndent) break;
      if (leadingSpaces(ln) >= contentCol || child) {
        itemLines.push(ln.length >= contentCol ? ln.slice(contentCol) : ln.trimStart());
        i++;
        continue;
      }
      itemLines.push(ln.trimStart());
      i++;
    }
    const blocks = parseBlocks(itemLines);
    const content = blocks.length ? blocks : [emptyParagraph()];
    items.push(isTask ? node("taskItem", { checked: lm.checked }, content) : node("listItem", null, content));
  }
  const type = isTask ? "taskList" : ordered ? "orderedList" : "bulletList";
  return { node: node(type, ordered ? { start } : null, items), next: i };
}
function isAlignRow(line) {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}
function parseTable(lines, i) {
  const aligns = splitRow(lines[i + 1]).map(parseAlign);
  const rows = [makeRow(splitRow(lines[i]), aligns, true)];
  let j = i + 2;
  while (j < lines.length && lines[j].includes("|") && !isBlank(lines[j])) {
    if (/^#{1,6}\s+/.test(lines[j]) || matchListMarker(lines[j])) break;
    rows.push(makeRow(splitRow(lines[j]), aligns, false));
    j++;
  }
  return { node: node("table", null, rows), next: j };
}
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (s[k] === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += s[k];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}
function parseAlign(spec) {
  const s = spec.trim();
  const l = s.startsWith(":"), r = s.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return null;
}
function makeRow(cells, aligns, header) {
  const tcs = cells.map((c, idx) => {
    const trimmed = (c || "").trim();
    const inline2 = !header && /^=\S/.test(trimmed) ? [node("formula", { src: trimmed })] : parseInline(c);
    return node("tableCell", { header, align: aligns[idx] || null }, [node("paragraph", null, inline2)]);
  });
  return node("tableRow", null, tcs);
}
function parseInline(text, marks = []) {
  const out = [];
  let buf = "";
  const s = text;
  const flush = () => {
    if (buf !== "") {
      out.push(makeText(buf, marks));
      buf = "";
    }
  };
  let p = 0;
  while (p < s.length) {
    const c = s[p];
    if (c === "\\" && s[p + 1] === "\n") {
      flush();
      out.push({ type: "hardBreak" });
      p += 2;
      continue;
    }
    if (c === "\n") {
      flush();
      out.push({ type: "hardBreak" });
      p++;
      continue;
    }
    if (c === "\\" && p + 1 < s.length && /[\\`*_~=[\]$<>!]/.test(s[p + 1])) {
      buf += s[p + 1];
      p += 2;
      continue;
    }
    const sub = s.slice(p);
    let m;
    if (c === "`" && (m = sub.match(/^(`+)([\s\S]*?)\1/))) {
      flush();
      out.push(makeText(m[2], addM(marks, "code")));
      p += m[0].length;
      continue;
    }
    if (c === "!" && (m = sub.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)(\{[^}]*\})?/))) {
      flush();
      out.push(parseImageMatch(m));
      p += m[0].length;
      continue;
    }
    if (c === "$" && s[p + 1] !== "$" && (m = sub.match(/^\$([^$\n]+?)\$/))) {
      flush();
      out.push({ type: "mathInline", attrs: { latex: m[1].trim() } });
      p += m[0].length;
      continue;
    }
    if (c === "[" && (m = sub.match(/^\[((?:[^\][]|\[[^\]]*\])*)\]\(([^)\s]*)(?:\s+"([^"]*)")?\)/))) {
      flush();
      out.push(...parseInline(m[1], addM(marks, "link", { href: m[2] })));
      p += m[0].length;
      continue;
    }
    if (c === "[" && (m = sub.match(/^\[((?:[^\][]|\[[^\]]*\])*)\]\{([^}]*)\}/))) {
      flush();
      let mm = marks;
      for (const sp of parseSpanAttrs(m[2])) mm = addMark(mm, sp);
      out.push(...parseInline(m[1], mm));
      p += m[0].length;
      continue;
    }
    if (c === "*" && s.slice(p, p + 3) === "***" && (m = sub.match(/^\*\*\*([\s\S]+?)\*\*\*/))) {
      flush();
      out.push(...parseInline(m[1], addMark(addM(marks, "bold"), mark("italic"))));
      p += m[0].length;
      continue;
    }
    if (c === "*" && s[p + 1] === "*" && (m = sub.match(/^\*\*([\s\S]+?)\*\*/))) {
      flush();
      out.push(...parseInline(m[1], addM(marks, "bold")));
      p += m[0].length;
      continue;
    }
    if (c === "~" && s[p + 1] === "~" && (m = sub.match(/^~~([\s\S]+?)~~/))) {
      flush();
      out.push(...parseInline(m[1], addM(marks, "strike")));
      p += m[0].length;
      continue;
    }
    if (c === "=" && s[p + 1] === "=" && (m = sub.match(/^==([\s\S]+?)==/))) {
      flush();
      out.push(...parseInline(m[1], addM(marks, "highlight")));
      p += m[0].length;
      continue;
    }
    if ((c === "*" || c === "_") && (m = sub.match(c === "*" ? /^\*([^\s*][\s\S]*?)\*/ : /^_([^\s_][\s\S]*?)_/))) {
      flush();
      out.push(...parseInline(m[1], addM(marks, "italic")));
      p += m[0].length;
      continue;
    }
    buf += c;
    p++;
  }
  flush();
  return mergeAdjacentText(out);
}
function parseImageMatch(m) {
  const attrs = { src: m[2], alt: m[1] || null, title: m[3] || null };
  if (m[4]) Object.assign(attrs, parseImageAttrs(m[4].slice(1, -1)));
  return node("image", attrs);
}
function parseImageAttrs(str) {
  const out = {};
  for (const t of str.trim().split(/\s+/)) {
    if (t.startsWith("w=")) out.width = parseInt(t.slice(2), 10) || null;
    else if (t.startsWith("align=")) out.alignment = t.slice(6);
    else if (t === "wrap") out.textWrap = true;
  }
  return out;
}
function parseSpanAttrs(str) {
  let color = null, font = null, hl = false, hlColor = null, u = false;
  for (const t of str.trim().split(/\s+/)) {
    if (t === "hl") hl = true;
    else if (t === "u") u = true;
    else if (t.startsWith("bg=")) {
      hl = true;
      hlColor = t.slice(3);
    } else if (t.startsWith("color=")) color = t.slice(6);
    else if (t.startsWith("font=")) font = t.slice(5).replace(/_/g, " ");
  }
  const marks = [];
  if (hl) marks.push(mark("highlight", hlColor ? { color: hlColor } : {}));
  if (color || font) marks.push(mark("textStyle", { color, fontFamily: font }));
  if (u) marks.push(mark("underline"));
  return marks;
}
var addM = (marks, type, attrs) => addMark(marks, mark(type, attrs));
function makeText(str, marks) {
  return marks && marks.length ? { type: "text", text: str, marks: sortMarks(marks) } : { type: "text", text: str };
}
function mergeAdjacentText(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === "text" && last && last.type === "text" && sameMarkSet(last.marks || [], n.marks || [])) {
      last.text += n.text;
    } else out.push(n);
  }
  return out.filter((n) => !(n.type === "text" && n.text === ""));
}
var isBlank = (s) => /^\s*$/.test(s);
var leadingSpaces = (s) => (s.match(/^ */) || [""])[0].length;

// ../agent-hub/src/editor/serialization/util.js
function encodeForAttr(str) {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch {
    return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
}
function decodeFromAttr(str) {
  if (!str) return "";
  try {
    const decoded = decodeURIComponent(escape(atob(str)));
    if (decoded && !decoded.includes("\uFFFD")) return decoded;
  } catch {
  }
  return String(str).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function escapeHtml(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, "&#39;");
}
function safeUrl(url) {
  if (url == null) return url;
  const s = String(url).trim();
  if (/^(javascript|vbscript|file):/i.test(s)) return "";
  if (/^data:/i.test(s) && !/^data:image\//i.test(s)) return "";
  return s;
}
var MD_INLINE_SPECIAL = /[\\`*_~=[\]$<>]/g;
function escapeMdText(str) {
  return String(str ?? "").replace(MD_INLINE_SPECIAL, (c) => "\\" + c);
}

// ../agent-hub/src/editor/serialization/astToMd.js
function astToMarkdown(docNode) {
  const blocks = docNode?.content || [];
  return serializeBlocks(blocks).replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}
function serializeBlocks(nodes) {
  const out = [];
  for (const n of nodes) out.push(serializeBlock(n));
  return out.join("\n\n");
}
function serializeBlock(n) {
  switch (n.type) {
    case "paragraph":
      return withAlign(escapeParaStart(inline(n.content)), n);
    case "heading":
      return withAlign("#".repeat(attr(n, "level")) + " " + inline(n.content), n);
    case "blockquote":
      return prefixLines(serializeBlocks(n.content), "> ");
    case "bulletList":
      return serializeList(n, null);
    case "orderedList":
      return serializeList(n, attr(n, "start") || 1);
    case "taskList":
      return serializeTaskList(n);
    case "codeBlock":
      return serializeCodeBlock(n);
    case "horizontalRule":
      return "---";
    case "table":
      return serializeTable(n);
    case "image":
      return serializeImage(n);
    case "mermaid":
      return "```mermaid\n" + (attr(n, "code") || "").replace(/\s+$/, "") + "\n```";
    case "mathBlock":
      return "$$\n" + (attr(n, "latex") || "").trim() + "\n$$";
    case "chart":
      return "```chart\n" + (attr(n, "spec") || "").replace(/\s+$/, "") + "\n```";
    default:
      return n.content ? serializeBlocks(n.content) : "";
  }
}
function withAlign(str, n) {
  const a = attr(n, "align");
  if (a === "center" || a === "right") return `${str} {align=${a}}`;
  return str;
}
function serializeCodeBlock(n) {
  const lang = attr(n, "language") || "";
  const body = (n.content || []).map((c) => c.text || "").join("");
  const longest = (body.match(/`+/g) || []).reduce((m, s) => Math.max(m, s.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}
${body.replace(/\n$/, "")}
${fence}`;
}
function serializeList(listNode, start) {
  const items = listNode.content || [];
  const lines = items.map((item, i) => {
    const marker = start == null ? "- " : `${start + i}. `;
    return serializeListItem(item, marker);
  });
  return lines.join("\n");
}
function serializeTaskList(listNode) {
  const items = listNode.content || [];
  return items.map((item) => {
    const box = attr(item, "checked") ? "[x]" : "[ ]";
    return serializeListItem(item, `- ${box} `);
  }).join("\n");
}
var isListType = (t) => t === "bulletList" || t === "orderedList" || t === "taskList";
function serializeListItem(item, marker) {
  const blocks = item.content || [];
  let inner = "";
  blocks.forEach((b, idx) => {
    const s = serializeBlock(b);
    inner += idx === 0 ? s : (isListType(b.type) ? "\n" : "\n\n") + s;
  });
  const pad = " ".repeat(marker.length);
  const lines = inner.split("\n");
  return lines.map((l, i) => i === 0 ? marker + l : l ? pad + l : "").join("\n");
}
function escapeParaStart(str) {
  return str.replace(/^(\s*)(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|`{3,}|~{3,})/, (_, sp, mk) => sp + "\\" + mk);
}
function serializeTable(tableNode) {
  const rows = tableNode.content || [];
  if (!rows.length) return "";
  const headerCells = rows[0].content || [];
  const renderRow = (row) => "| " + (row.content || []).map((cell) => cellText(cell)).join(" | ") + " |";
  const alignRow = "| " + headerCells.map((cell) => {
    const a = attr(cell, "align");
    if (a === "center") return ":-:";
    if (a === "right") return "--:";
    if (a === "left") return ":--";
    return "---";
  }).join(" | ") + " |";
  const out = [renderRow(rows[0]), alignRow];
  for (let i = 1; i < rows.length; i++) out.push(renderRow(rows[i]));
  return out.join("\n");
  function cellText(cell) {
    const blocks = cell.content || [];
    const txt = blocks.map((b) => b.content ? inline(b.content) : "").join(" ").trim();
    return txt.replace(/\|/g, "\\|").replace(/\n/g, " ");
  }
}
function serializeImage(n) {
  const src = attr(n, "src") || "";
  const alt = (attr(n, "alt") || "").replace(/\]/g, "\\]");
  const title = attr(n, "title");
  const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
  const attrs = imageAttrSuffix(n);
  return `![${alt}](${src}${titlePart})${attrs}`;
}
function imageAttrSuffix(n) {
  const parts = [];
  const w = attr(n, "width");
  const align = attr(n, "alignment");
  const wrap = attr(n, "textWrap");
  if (w) parts.push(`w=${w}`);
  if (align && align !== "center") parts.push(`align=${align}`);
  if (wrap) parts.push("wrap");
  return parts.length ? `{${parts.join(" ")}}` : "";
}
function prefixLines(str, prefix) {
  return str.split("\n").map((l) => l ? prefix + l : prefix.trimEnd()).join("\n");
}
function inline(nodes = []) {
  let out = "";
  for (const n of nodes) out += serializeInline(n);
  return out;
}
function serializeInline(n) {
  if (n.type === "hardBreak") return "\\\n";
  if (n.type === "mathInline") return `$${(n.attrs?.latex || "").trim()}$`;
  if (n.type === "formula") return n.attrs?.src || "";
  if (n.type === "image") return serializeImage(n);
  if (n.type !== "text") return "";
  const marks = n.marks || [];
  let s = escapeMdText(n.text);
  if (hasType(marks, "code")) return "`" + n.text.replace(/`/g, "\\`") + "`";
  if (hasType(marks, "strike")) s = `~~${s}~~`;
  if (hasType(marks, "italic")) s = `*${s}*`;
  if (hasType(marks, "bold")) s = `**${s}**`;
  s = wrapSpan(s, marks);
  const link = getMark(marks, "link");
  if (link) s = `[${s}](${link.attrs?.href || ""})`;
  return s;
}
function wrapSpan(inner, marks) {
  const hl = getMark(marks, "highlight");
  const ts = getMark(marks, "textStyle");
  const u = hasType(marks, "underline");
  const color = ts?.attrs?.color || null;
  const font = ts?.attrs?.fontFamily || null;
  const hlColor = hl?.attrs?.color || null;
  const onlyDefaultHighlight = hl && !color && !font && !u && !hlColor;
  if (onlyDefaultHighlight) return `==${inner}==`;
  if (!hl && !color && !font && !u) return inner;
  const parts = [];
  if (hl && !hlColor) parts.push("hl");
  if (hlColor) parts.push(`bg=${hlColor}`);
  if (color) parts.push(`color=${color}`);
  if (font) parts.push(`font=${font.replace(/\s/g, "_")}`);
  if (u) parts.push("u");
  return `[${inner}]{${parts.join(" ")}}`;
}
var hasType = (marks, t) => marks.some((m) => m.type === t);

// ../agent-hub/src/editor/engine/formula.js
function colToIndex(label) {
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseAnyRef(token) {
  const cell = /^([A-Za-z]+)(\d+)$/.exec(token);
  if (cell) return { r: parseInt(cell[2], 10) - 1, c: colToIndex(cell[1]), col: false };
  const col = /^([A-Za-z]+)$/.exec(token);
  if (col) return { c: colToIndex(col[1]), col: true };
  return null;
}
function isFormulaCell(cell) {
  const blocks = cell?.content || [];
  if (blocks.length !== 1) return false;
  const inl = blocks[0]?.content || [];
  return inl.length === 1 && inl[0]?.type === "formula";
}
function formulaSrc(cell) {
  return cell?.content?.[0]?.content?.[0]?.attrs?.src || "";
}
function cellPlainText(cell) {
  const parts = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === "text") parts.push(n.text || "");
    (n.content || []).forEach(walk);
  };
  (cell?.content || []).forEach(walk);
  return parts.join("");
}
var cellRaw = (cell) => isFormulaCell(cell) ? formulaSrc(cell) : cellPlainText(cell);
function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: "num", v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      toks.push({ t: "ident", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/(),:%".includes(c)) {
      toks.push({ t: c });
      i++;
      continue;
    }
    throw { e: "#ERR!" };
  }
  return toks;
}
var FUNCS = {
  SUM: (n) => n.reduce((a, b) => a + b, 0),
  AVERAGE: (n) => {
    if (!n.length) throw { e: "#DIV/0!" };
    return n.reduce((a, b) => a + b, 0) / n.length;
  },
  AVG: (n) => FUNCS.AVERAGE(n),
  MIN: (n) => n.length ? Math.min(...n) : 0,
  MAX: (n) => n.length ? Math.max(...n) : 0,
  COUNT: (n) => n.length,
  PRODUCT: (n) => n.length ? n.reduce((a, b) => a * b, 1) : 0
};
function evalExpr(toks, ctx) {
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t) => {
    if (!peek() || peek().t !== t) throw { e: "#ERR!" };
    return next();
  };
  function parseExpr() {
    let v = parseTerm();
    while (peek() && (peek().t === "+" || peek().t === "-")) {
      const op = next().t;
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseUnary();
    while (peek() && (peek().t === "*" || peek().t === "/")) {
      const op = next().t;
      const r = parseUnary();
      if (op === "/") {
        if (r === 0) throw { e: "#DIV/0!" };
        v /= r;
      } else v *= r;
    }
    return v;
  }
  function parseUnary() {
    if (peek() && peek().t === "-") {
      next();
      return -parseUnary();
    }
    if (peek() && peek().t === "+") {
      next();
      return parseUnary();
    }
    return parsePostfix();
  }
  function parsePostfix() {
    let v = parsePrimary();
    while (peek() && peek().t === "%") {
      next();
      v /= 100;
    }
    return v;
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw { e: "#ERR!" };
    if (tk.t === "num") {
      next();
      return tk.v;
    }
    if (tk.t === "(") {
      next();
      const v = parseExpr();
      expect(")");
      return v;
    }
    if (tk.t === "ident") {
      next();
      if (peek() && peek().t === "(") {
        next();
        const args = parseArgs();
        expect(")");
        return callFunc(tk.v.toUpperCase(), args);
      }
      const ref = parseAnyRef(tk.v);
      if (ref && !ref.col) return ctx.numberAt(ref.r, ref.c);
      throw { e: "#NAME?" };
    }
    throw { e: "#ERR!" };
  }
  function parseArgs() {
    const args = [];
    if (peek() && peek().t === ")") return args;
    args.push(parseArg());
    while (peek() && peek().t === ",") {
      next();
      args.push(parseArg());
    }
    return args;
  }
  function parseArg() {
    if (peek() && peek().t === "ident" && toks[pos + 1] && toks[pos + 1].t === ":") {
      const a = next().v;
      expect(":");
      if (!peek() || peek().t !== "ident") throw { e: "#ERR!" };
      const b = next().v;
      return { range: ctx.collectRange(a, b) };
    }
    return { scalar: parseExpr() };
  }
  function callFunc(name, args) {
    const f = FUNCS[name];
    if (!f) throw { e: "#NAME?" };
    const nums = [];
    for (const a of args) {
      if (a.range) nums.push(...a.range);
      else nums.push(a.scalar);
    }
    return f(nums);
  }
  const result = parseExpr();
  if (pos !== toks.length) throw { e: "#ERR!" };
  if (!Number.isFinite(result)) throw { e: "#NUM!" };
  return result;
}
function evaluateTable(table) {
  const rows = table?.content || [];
  const grid = rows.map((row) => (row.content || []).map(cellRaw));
  const memo = /* @__PURE__ */ new Map();
  const evaluating = /* @__PURE__ */ new Set();
  const rawIsFormula = (raw) => typeof raw === "string" && /^\s*=/.test(raw);
  function cellNumericValue(r, c) {
    if (r < 0 || c < 0 || r >= grid.length || c >= (grid[r] ? grid[r].length : 0)) return { isNumber: false };
    const raw = grid[r][c];
    if (rawIsFormula(raw)) {
      const res = formulaResult(r, c);
      if (res.error) throw { e: res.error };
      if (res.blank) return { isNumber: false };
      return { isNumber: true, num: res.value };
    }
    const t = (raw || "").trim();
    if (t === "") return { isNumber: false };
    const n = Number(t);
    return Number.isFinite(n) ? { isNumber: true, num: n } : { isNumber: false };
  }
  function numberAt(r, c) {
    const v = cellNumericValue(r, c);
    return v.isNumber ? v.num : 0;
  }
  function collectRange(aStr, bStr) {
    const a = parseAnyRef(aStr);
    const b = parseAnyRef(bStr);
    if (!a || !b || a.col !== b.col) throw { e: "#REF!" };
    let r1;
    let r2;
    let c1;
    let c2;
    if (a.col) {
      c1 = Math.min(a.c, b.c);
      c2 = Math.max(a.c, b.c);
      r1 = 0;
      r2 = grid.length - 1;
    } else {
      r1 = Math.min(a.r, b.r);
      r2 = Math.max(a.r, b.r);
      c1 = Math.min(a.c, b.c);
      c2 = Math.max(a.c, b.c);
    }
    const nums = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const v = cellNumericValue(r, c);
      if (v.isNumber) nums.push(v.num);
    }
    return nums;
  }
  function formulaResult(r, c) {
    const key = `${r},${c}`;
    if (memo.has(key)) return memo.get(key);
    if (evaluating.has(key)) {
      const res2 = { error: "#CIRC!" };
      memo.set(key, res2);
      return res2;
    }
    evaluating.add(key);
    let res;
    try {
      const expr = grid[r][c].trim().slice(1);
      if (!expr.trim()) res = { blank: true };
      else res = { value: evalExpr(tokenize(expr), { numberAt, collectRange }) };
    } catch (e) {
      res = { error: e && e.e || "#ERR!" };
    }
    evaluating.delete(key);
    memo.set(key, res);
    return res;
  }
  const out = /* @__PURE__ */ new Map();
  for (let r = 0; r < rows.length; r++) {
    const cols = rows[r].content || [];
    for (let c = 0; c < cols.length; c++) if (rawIsFormula(grid[r][c])) out.set(`${r},${c}`, formulaResult(r, c));
  }
  return out;
}
function formatNumber(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "#NUM!";
  return String(Math.round(n * 1e10) / 1e10);
}
function displayResult(res) {
  if (!res || res.blank) return "";
  return res.error ? res.error : formatNumber(res.value);
}

// ../agent-hub/src/editor/serialization/astToHtml.js
function astToHtml(docNode) {
  return (docNode?.content || []).map(renderBlock).join("");
}
function renderBlock(n) {
  switch (n.type) {
    case "paragraph":
      return `<p${alignStyle(n)}>${renderInline(n.content) || "<br>"}</p>`;
    case "heading": {
      const l = attr(n, "level");
      return `<h${l}${alignStyle(n)}>${renderInline(n.content)}</h${l}>`;
    }
    case "blockquote":
      return `<blockquote>${(n.content || []).map(renderBlock).join("")}</blockquote>`;
    case "bulletList":
      return `<ul>${renderItems(n)}</ul>`;
    case "orderedList": {
      const s = attr(n, "start");
      return `<ol${s && s !== 1 ? ` start="${s}"` : ""}>${renderItems(n)}</ol>`;
    }
    case "listItem":
      return `<li>${(n.content || []).map(renderBlock).join("")}</li>`;
    case "taskList":
      return `<ul data-type="taskList">${(n.content || []).map(renderTaskItem).join("")}</ul>`;
    case "codeBlock":
      return renderCodeBlock(n);
    case "horizontalRule":
      return "<hr>";
    case "table":
      return renderTable(n);
    case "image":
      return renderImage(n);
    case "mermaid":
      return `<div data-type="mermaid-diagram" data-code="${encodeForAttr(attr(n, "code") || "")}"></div>`;
    case "mathBlock":
      return `<div data-type="blockMath" data-latex="${escapeAttr(attr(n, "latex") || "")}">\\[${escapeHtml(attr(n, "latex") || "")}\\]</div>`;
    case "chart":
      return renderChart(n);
    default:
      return n.content ? n.content.map(renderBlock).join("") : "";
  }
}
function renderItems(listNode) {
  return (listNode.content || []).map(renderBlock).join("");
}
function renderTaskItem(item) {
  const checked = attr(item, "checked");
  return `<li data-type="taskItem" data-checked="${checked ? "true" : "false"}"><label><input type="checkbox"${checked ? " checked" : ""}></label><div>${(item.content || []).map(renderBlock).join("")}</div></li>`;
}
function renderCodeBlock(n) {
  const lang = attr(n, "language");
  const body = (n.content || []).map((c) => c.text || "").join("");
  const codeCls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
  return `<pre class="notebook-code-block"><code${codeCls}>${escapeHtml(body)}</code></pre>`;
}
function renderTable(n) {
  let results;
  try {
    results = evaluateTable(n);
  } catch (e) {
    results = /* @__PURE__ */ new Map();
  }
  const rows = (n.content || []).map((row, r) => {
    const cells = (row.content || []).map((cell, c) => {
      const tag = attr(cell, "header") ? "th" : "td";
      const a = attr(cell, "align");
      const cw = attr(cell, "colwidth");
      const styles = [];
      if (a) styles.push(`text-align:${a}`);
      if (cw) styles.push(`width:${cw}px`);
      const style = styles.length ? ` style="${styles.join(";")}"` : "";
      const cs = attr(cell, "colspan");
      const rs = attr(cell, "rowspan");
      const span = (cs && cs !== 1 ? ` colspan="${cs}"` : "") + (rs && rs !== 1 ? ` rowspan="${rs}"` : "");
      let body;
      if (isFormulaCell(cell)) {
        const src = cell.content[0].content[0].attrs?.src || "";
        const val = displayResult(results.get(`${r},${c}`));
        body = `<span data-type="formula" data-formula="${escapeAttr(src)}">${escapeHtml(val)}</span>`;
      } else {
        body = (cell.content || []).map(renderBlock).join("");
      }
      return `<${tag}${span}${style}>${body}</${tag}>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<table><tbody>${rows}</tbody></table>`;
}
function renderChart(n) {
  const specStr = attr(n, "spec") || "";
  const enc = encodeForAttr(specStr);
  let spec = null;
  try {
    spec = JSON.parse(specStr);
  } catch (e) {
    spec = null;
  }
  if (!spec || !Array.isArray(spec.labels)) return `<figure data-type="chart" data-spec="${enc}"></figure>`;
  const series = Array.isArray(spec.series) ? spec.series : [];
  const caption = spec.title ? `<figcaption>${escapeHtml(spec.title)}</figcaption>` : "";
  const head = `<tr><th></th>${series.map((s) => `<th>${escapeHtml(s.name || "")}</th>`).join("")}</tr>`;
  const body = spec.labels.map((lab, i) => `<tr><th>${escapeHtml(String(lab))}</th>${series.map((s) => `<td>${escapeHtml(String((s.data || [])[i] ?? ""))}</td>`).join("")}</tr>`).join("");
  return `<figure data-type="chart" data-spec="${enc}">${caption}<table><tbody>${head}${body}</tbody></table></figure>`;
}
function renderImage(n) {
  const src = safeUrl(attr(n, "src") || "") || "";
  const alt = attr(n, "alt") || "";
  const title = attr(n, "title") || "";
  const width = attr(n, "width");
  const alignment = attr(n, "alignment") || "center";
  const textWrap = attr(n, "textWrap");
  return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" title="${escapeAttr(title)}" data-width="${width || ""}" data-alignment="${alignment}" data-text-wrap="${textWrap ? "true" : "false"}" class="notebook-image"${width ? ` style="width: ${width}px"` : ""}>`;
}
function alignStyle(n) {
  const a = attr(n, "align");
  return a === "center" || a === "right" ? ` style="text-align:${a}"` : "";
}
function renderInline(nodes = []) {
  return nodes.map(renderInlineNode).join("");
}
function renderInlineNode(n) {
  if (n.type === "hardBreak") return "<br>";
  if (n.type === "mathInline") return `<span data-type="inlineMath" data-latex="${escapeAttr(n.attrs?.latex || "")}">\\(${escapeHtml(n.attrs?.latex || "")}\\)</span>`;
  if (n.type === "image") return renderImage(n);
  if (n.type !== "text") return "";
  let s = escapeHtml(n.text);
  const marks = n.marks || [];
  for (const m of [...marks].reverse()) s = wrapMark(s, m);
  return s;
}
function wrapMark(inner, m) {
  switch (m.type) {
    case "code":
      return `<code>${inner}</code>`;
    case "strike":
      return `<s>${inner}</s>`;
    case "italic":
      return `<em>${inner}</em>`;
    case "bold":
      return `<strong>${inner}</strong>`;
    case "underline":
      return `<u>${inner}</u>`;
    case "textStyle": {
      const parts = [];
      if (m.attrs?.color) parts.push(`color: ${m.attrs.color}`);
      if (m.attrs?.fontFamily) parts.push(`font-family: ${m.attrs.fontFamily}`);
      return parts.length ? `<span style="${parts.join("; ")}">${inner}</span>` : inner;
    }
    case "highlight":
      return m.attrs?.color ? `<mark style="background-color: ${m.attrs.color}">${inner}</mark>` : `<mark>${inner}</mark>`;
    case "link": {
      const d = markDefaults("link");
      const href = safeUrl(m.attrs?.href || "") || "";
      const target = m.attrs?.target ?? d.target;
      const rel = m.attrs?.rel ?? d.rel;
      return `<a href="${escapeAttr(href)}" target="${target}" rel="${rel}" class="notebook-link">${inner}</a>`;
    }
    default:
      return inner;
  }
}

// ../agent-hub/src/editor/serialization/htmlToAst.js
function htmlToAst(html, DOMParserImpl) {
  const Impl = DOMParserImpl || (typeof DOMParser !== "undefined" ? DOMParser : null);
  if (!Impl) throw new Error("[htmlToAst] No DOMParser available in this environment.");
  const parsed = new Impl().parseFromString(`<body>${html || ""}</body>`, "text/html");
  const blocks = parseBlockChildren(parsed.body);
  if (!blocks.length) blocks.push(emptyParagraph());
  return doc(blocks);
}
function parseBlockChildren(el) {
  const out = [];
  let inlineBuf = [];
  const flushInline = () => {
    if (inlineBuf.length) {
      const inline2 = mergeAdjacentText2(inlineBuf);
      if (inline2.length) out.push(node("paragraph", null, inline2));
      inlineBuf = [];
    }
  };
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      if (child.textContent.trim()) collectInline(child, [], inlineBuf);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (BLOCK_TAGS.has(tag) || isCustomBlock(child)) {
      flushInline();
      const b = parseBlock(child);
      if (b) out.push(...Array.isArray(b) ? b : [b]);
    } else {
      collectInline(child, [], inlineBuf);
    }
  }
  flushInline();
  return out;
}
var BLOCK_TAGS = /* @__PURE__ */ new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "hr",
  "table",
  "figure"
]);
function isCustomBlock(el) {
  const dt = el.getAttribute?.("data-type");
  return dt === "mermaid-diagram" || dt === "blockMath" || dt === "chart" || el.tagName === "IMG" || el.classList?.contains("resizable-image-wrapper");
}
function parseBlock(el) {
  const tag = el.tagName.toLowerCase();
  const dt = el.getAttribute("data-type");
  if (dt === "mermaid-diagram") return node("mermaid", { code: decodeFromAttr(el.getAttribute("data-code")) || el.textContent || "" });
  if (dt === "blockMath") return node("mathBlock", { latex: el.getAttribute("data-latex") || stripMathDelims(el.textContent) });
  if (dt === "chart") return node("chart", { spec: decodeFromAttr(el.getAttribute("data-spec")) || "" });
  switch (tag) {
    case "p":
      return paragraphFrom(el);
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return node("heading", { level: Math.min(3, +tag[1]), align: alignFrom(el) }, inlineOf(el));
    case "ul":
      return listFrom(el);
    case "ol":
      return node("orderedList", { start: +el.getAttribute("start") || 1 }, itemsFrom(el, false));
    case "blockquote":
      return node("blockquote", null, parseBlockChildren(el));
    case "pre":
      return codeBlockFrom(el);
    case "hr":
      return node("horizontalRule");
    case "table":
      return tableFrom(el);
    case "img":
      return imageFrom(el);
    case "figure":
      return parseBlockChildren(el);
    case "div":
      return divFrom(el);
    default:
      return null;
  }
}
function paragraphFrom(el) {
  const inline2 = inlineOf(el);
  if (inline2.length === 1 && inline2[0].type === "hardBreak") return emptyParagraph();
  return node("paragraph", { align: alignFrom(el) }, inline2);
}
function listFrom(el) {
  if (el.getAttribute("data-type") === "taskList") return node("taskList", null, itemsFrom(el, true));
  return node("bulletList", null, itemsFrom(el, false));
}
function itemsFrom(listEl, task) {
  const items = [];
  for (const li of Array.from(listEl.children)) {
    if (li.tagName.toLowerCase() !== "li") continue;
    if (task) {
      const checked = li.getAttribute("data-checked") === "true" || !!li.querySelector('input[type="checkbox"]:checked');
      const contentEl = li.querySelector(":scope > div") || li;
      const blocks = parseBlockChildren(contentEl);
      items.push(node("taskItem", { checked }, blocks.length ? blocks : [emptyParagraph()]));
    } else {
      const blocks = parseBlockChildren(li);
      items.push(node("listItem", null, blocks.length ? blocks : [emptyParagraph()]));
    }
  }
  return items;
}
function codeBlockFrom(el) {
  const code = el.querySelector("code");
  const cls = code?.getAttribute("class") || el.getAttribute("class") || "";
  const langMatch = cls.match(/language-([\w-]+)/);
  const text = (code || el).textContent || "";
  return node("codeBlock", langMatch ? { language: langMatch[1] } : null, [{ type: "text", text: text.replace(/\n$/, "") }]);
}
function tableFrom(el) {
  const rows = [];
  for (const tr of Array.from(el.querySelectorAll("tr"))) {
    const cells = [];
    for (const cell of Array.from(tr.children)) {
      const t = cell.tagName.toLowerCase();
      if (t !== "td" && t !== "th") continue;
      cells.push(node("tableCell", {
        header: t === "th",
        align: cellAlignFrom(cell),
        colspan: +cell.getAttribute("colspan") || 1,
        rowspan: +cell.getAttribute("rowspan") || 1,
        colwidth: cell.style && cell.style.width ? parseInt(cell.style.width, 10) || null : null
      }, parseBlockChildren(cell)));
    }
    if (cells.length) rows.push(node("tableRow", null, cells));
  }
  return node("table", null, rows);
}
function imageFrom(img) {
  const width = img.getAttribute("data-width") || (img.style?.width ? parseInt(img.style.width, 10) : null);
  return node("image", {
    src: safeUrl(img.getAttribute("src")),
    alt: img.getAttribute("alt") || null,
    title: img.getAttribute("title") || null,
    width: width ? parseInt(width, 10) || null : null,
    alignment: img.getAttribute("data-alignment") || "center",
    textWrap: img.getAttribute("data-text-wrap") === "true"
  });
}
function divFrom(el) {
  const img = el.querySelector("img");
  if (img && el.classList.contains("resizable-image-wrapper")) {
    const n = imageFrom(img);
    if (el.getAttribute("data-alignment")) n.attrs.alignment = el.getAttribute("data-alignment");
    if (el.getAttribute("data-text-wrap")) n.attrs.textWrap = el.getAttribute("data-text-wrap") === "true";
    return n;
  }
  const blocks = parseBlockChildren(el);
  return blocks.length ? blocks : null;
}
function inlineOf(el) {
  const buf = [];
  for (const child of Array.from(el.childNodes)) collectInline(child, [], buf);
  return mergeAdjacentText2(buf);
}
function collectInline(domNode, marks, out) {
  if (domNode.nodeType === 3) {
    const text = domNode.textContent.replace(/\s+/g, " ");
    if (text) out.push(makeText2(text, marks));
    return;
  }
  if (domNode.nodeType !== 1) return;
  const tag = domNode.tagName.toLowerCase();
  const dt = domNode.getAttribute("data-type");
  if (tag === "br") {
    out.push({ type: "hardBreak" });
    return;
  }
  if (tag === "img") {
    out.push(imageFrom(domNode));
    return;
  }
  if (dt === "inlineMath") {
    out.push({ type: "mathInline", attrs: { latex: domNode.getAttribute("data-latex") || stripMathDelims(domNode.textContent) } });
    return;
  }
  if (dt === "formula") {
    out.push({ type: "formula", attrs: { src: domNode.getAttribute("data-formula") || domNode.textContent || "" } });
    return;
  }
  const add = markForTag(tag, domNode);
  const nextMarks = add ? addMark(marks, add) : marks;
  if (tag === "code") {
    out.push(makeText2(domNode.textContent, nextMarks));
    return;
  }
  for (const child of Array.from(domNode.childNodes)) collectInline(child, nextMarks, out);
}
function markForTag(tag, el) {
  switch (tag) {
    case "strong":
    case "b":
      return mark("bold");
    case "em":
    case "i":
      return mark("italic");
    case "u":
      return mark("underline");
    case "s":
    case "del":
    case "strike":
      return mark("strike");
    case "code":
      return mark("code");
    case "mark":
      return mark("highlight", { color: cssValue(el, "background-color") || cssValue(el, "background") || null });
    case "a":
      return mark("link", { href: safeUrl(el.getAttribute("href") || ""), target: el.getAttribute("target") || void 0, rel: el.getAttribute("rel") || void 0 });
    case "span": {
      const color = cssValue(el, "color");
      const font = cssValue(el, "font-family");
      if (color || font) return mark("textStyle", { color: color || null, fontFamily: font ? font.replace(/['"]/g, "") : null });
      return null;
    }
    default:
      return null;
  }
}
function alignFrom(el) {
  const a = cellAlignFrom(el);
  return a === "left" ? null : a;
}
function cellAlignFrom(el) {
  const a = cssValue(el, "text-align") || el.getAttribute("align");
  return a === "center" || a === "right" || a === "left" ? a : null;
}
function cssValue(el, prop) {
  const style = el.getAttribute?.("style") || "";
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i"));
  return m ? m[1].trim() : null;
}
function stripMathDelims(s) {
  return String(s || "").replace(/^\s*\\?[([]\s*/, "").replace(/\s*\\?[)\]]\s*$/, "").replace(/^\$+|\$+$/g, "").trim();
}
function makeText2(str, marks) {
  return marks && marks.length ? { type: "text", text: str, marks: sortMarks(marks) } : { type: "text", text: str };
}
function mergeAdjacentText2(nodes) {
  const out = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.type === "text" && last && last.type === "text" && sameMarkSet(last.marks || [], n.marks || [])) {
      last.text += n.text;
    } else out.push(n);
  }
  return out.filter((n) => !(n.type === "text" && n.text === ""));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  astToHtml,
  astToMarkdown,
  decodeFromAttr,
  encodeForAttr,
  escapeAttr,
  escapeHtml,
  escapeMdText,
  htmlToAst,
  markdownToAst
});
