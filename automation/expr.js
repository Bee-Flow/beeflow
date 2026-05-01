/**
 * Restricted expression evaluator for automation conditions.
 *
 * Used by `condition` step `expr` and any computed binding. We deliberately
 * do NOT use `eval` / `new Function` — instead we tokenize and recursive-descent
 * parse a tiny grammar. This makes the surface auditable and impossible to
 * smuggle calls/lookups through.
 *
 * Grammar:
 *   expr     := ternary
 *   ternary  := logical_or ('?' ternary ':' ternary)?
 *   logical_or := logical_and ('||' logical_and)*
 *   logical_and := equality ('&&' equality)*
 *   equality := compare (('=='|'!='|'==='|'!==') compare)*
 *   compare  := additive (('<'|'<='|'>'|'>=') additive)*
 *   additive := multiplicative (('+'|'-') multiplicative)*
 *   multiplicative := unary (('*'|'/'|'%') unary)*
 *   unary    := ('!'|'-'|'+')? primary
 *   primary  := number | string | bool | null | identifier_path | '(' expr ')'
 *   identifier_path := ident ('.' ident | '[' expr ']')*
 *
 * No function calls, no assignment, no template strings. Identifiers walk
 * the runState passed to evaluate(); unknown paths return undefined and
 * propagate through comparisons safely.
 */

// ── Tokenizer ──────────────────────────────────────────

const TOKEN = {
    NUMBER: 'NUM', STRING: 'STR', IDENT: 'ID', BOOL: 'BOOL', NULL: 'NULL',
    LPAREN: '(', RPAREN: ')', LBRACK: '[', RBRACK: ']',
    DOT: '.', COMMA: ',', QMARK: '?', COLON: ':',
    OR: '||', AND: '&&', EQ: '==', NEQ: '!=', SEQ: '===', SNEQ: '!==',
    LT: '<', LTE: '<=', GT: '>', GTE: '>=',
    PLUS: '+', MINUS: '-', STAR: '*', SLASH: '/', PERCENT: '%',
    BANG: '!',
    EOF: 'EOF',
};

function tokenize(src) {
    if (typeof src !== 'string') throw new Error('Expression must be a string');
    const tokens = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        // numbers
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
            let j = i;
            while (j < src.length && /[0-9.]/.test(src[j])) j++;
            tokens.push({ t: TOKEN.NUMBER, v: parseFloat(src.slice(i, j)) });
            i = j; continue;
        }
        // strings — single or double quoted, no escapes beyond \\ \' \"
        if (c === '"' || c === "'") {
            const q = c; let j = i + 1; let out = '';
            while (j < src.length && src[j] !== q) {
                if (src[j] === '\\' && j + 1 < src.length) {
                    const n = src[j + 1];
                    out += (n === 'n' ? '\n' : n === 't' ? '\t' : n);
                    j += 2;
                } else { out += src[j]; j++; }
            }
            if (j >= src.length) throw new Error('Unterminated string in expression');
            tokens.push({ t: TOKEN.STRING, v: out });
            i = j + 1; continue;
        }
        // identifiers
        if (/[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
            const word = src.slice(i, j);
            if (word === 'true' || word === 'false') tokens.push({ t: TOKEN.BOOL, v: word === 'true' });
            else if (word === 'null') tokens.push({ t: TOKEN.NULL });
            else tokens.push({ t: TOKEN.IDENT, v: word });
            i = j; continue;
        }
        // multichar operators
        const two = src.slice(i, i + 2);
        const three = src.slice(i, i + 3);
        if (three === '===') { tokens.push({ t: TOKEN.SEQ }); i += 3; continue; }
        if (three === '!==') { tokens.push({ t: TOKEN.SNEQ }); i += 3; continue; }
        if (two === '||') { tokens.push({ t: TOKEN.OR }); i += 2; continue; }
        if (two === '&&') { tokens.push({ t: TOKEN.AND }); i += 2; continue; }
        if (two === '==') { tokens.push({ t: TOKEN.EQ }); i += 2; continue; }
        if (two === '!=') { tokens.push({ t: TOKEN.NEQ }); i += 2; continue; }
        if (two === '<=') { tokens.push({ t: TOKEN.LTE }); i += 2; continue; }
        if (two === '>=') { tokens.push({ t: TOKEN.GTE }); i += 2; continue; }
        // single char
        const single = {
            '(': TOKEN.LPAREN, ')': TOKEN.RPAREN,
            '[': TOKEN.LBRACK, ']': TOKEN.RBRACK,
            '.': TOKEN.DOT, ',': TOKEN.COMMA,
            '?': TOKEN.QMARK, ':': TOKEN.COLON,
            '<': TOKEN.LT, '>': TOKEN.GT,
            '+': TOKEN.PLUS, '-': TOKEN.MINUS,
            '*': TOKEN.STAR, '/': TOKEN.SLASH, '%': TOKEN.PERCENT,
            '!': TOKEN.BANG,
        };
        if (single[c]) { tokens.push({ t: single[c] }); i++; continue; }
        throw new Error(`Unexpected character in expression: ${c}`);
    }
    tokens.push({ t: TOKEN.EOF });
    return tokens;
}

// ── Parser (recursive descent) ─────────────────────────

function parse(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const eat = (t) => {
        if (tokens[pos].t !== t) throw new Error(`Expected ${t} but got ${tokens[pos].t}`);
        return tokens[pos++];
    };
    const accept = (t) => tokens[pos].t === t ? tokens[pos++] : null;

    function ternary() {
        const cond = logicalOr();
        if (accept(TOKEN.QMARK)) {
            const a = ternary();
            eat(TOKEN.COLON);
            const b = ternary();
            return { kind: 'ternary', cond, a, b };
        }
        return cond;
    }
    function logicalOr() {
        let n = logicalAnd();
        while (accept(TOKEN.OR)) n = { kind: 'binop', op: '||', a: n, b: logicalAnd() };
        return n;
    }
    function logicalAnd() {
        let n = equality();
        while (accept(TOKEN.AND)) n = { kind: 'binop', op: '&&', a: n, b: equality() };
        return n;
    }
    function equality() {
        let n = compare();
        while (true) {
            if (accept(TOKEN.SEQ)) n = { kind: 'binop', op: '===', a: n, b: compare() };
            else if (accept(TOKEN.SNEQ)) n = { kind: 'binop', op: '!==', a: n, b: compare() };
            else if (accept(TOKEN.EQ)) n = { kind: 'binop', op: '==', a: n, b: compare() };
            else if (accept(TOKEN.NEQ)) n = { kind: 'binop', op: '!=', a: n, b: compare() };
            else break;
        }
        return n;
    }
    function compare() {
        let n = additive();
        while (true) {
            if (accept(TOKEN.LTE)) n = { kind: 'binop', op: '<=', a: n, b: additive() };
            else if (accept(TOKEN.GTE)) n = { kind: 'binop', op: '>=', a: n, b: additive() };
            else if (accept(TOKEN.LT)) n = { kind: 'binop', op: '<', a: n, b: additive() };
            else if (accept(TOKEN.GT)) n = { kind: 'binop', op: '>', a: n, b: additive() };
            else break;
        }
        return n;
    }
    function additive() {
        let n = multiplicative();
        while (true) {
            if (accept(TOKEN.PLUS)) n = { kind: 'binop', op: '+', a: n, b: multiplicative() };
            else if (accept(TOKEN.MINUS)) n = { kind: 'binop', op: '-', a: n, b: multiplicative() };
            else break;
        }
        return n;
    }
    function multiplicative() {
        let n = unary();
        while (true) {
            if (accept(TOKEN.STAR)) n = { kind: 'binop', op: '*', a: n, b: unary() };
            else if (accept(TOKEN.SLASH)) n = { kind: 'binop', op: '/', a: n, b: unary() };
            else if (accept(TOKEN.PERCENT)) n = { kind: 'binop', op: '%', a: n, b: unary() };
            else break;
        }
        return n;
    }
    function unary() {
        if (accept(TOKEN.BANG)) return { kind: 'unop', op: '!', a: unary() };
        if (accept(TOKEN.MINUS)) return { kind: 'unop', op: '-', a: unary() };
        if (accept(TOKEN.PLUS)) return { kind: 'unop', op: '+', a: unary() };
        return primary();
    }
    function primary() {
        const tk = peek();
        if (tk.t === TOKEN.NUMBER) { pos++; return { kind: 'num', v: tk.v }; }
        if (tk.t === TOKEN.STRING) { pos++; return { kind: 'str', v: tk.v }; }
        if (tk.t === TOKEN.BOOL)   { pos++; return { kind: 'bool', v: tk.v }; }
        if (tk.t === TOKEN.NULL)   { pos++; return { kind: 'null' }; }
        if (tk.t === TOKEN.LPAREN) { pos++; const e = ternary(); eat(TOKEN.RPAREN); return e; }
        if (tk.t === TOKEN.IDENT) {
            pos++;
            const path = [{ kind: 'name', v: tk.v }];
            while (true) {
                if (accept(TOKEN.DOT)) {
                    const id = eat(TOKEN.IDENT);
                    path.push({ kind: 'name', v: id.v });
                } else if (accept(TOKEN.LBRACK)) {
                    const idx = ternary();
                    eat(TOKEN.RBRACK);
                    path.push({ kind: 'index', expr: idx });
                } else break;
            }
            return { kind: 'path', segments: path };
        }
        throw new Error(`Unexpected token: ${tk.t}`);
    }

    const ast = ternary();
    if (peek().t !== TOKEN.EOF) throw new Error('Trailing tokens in expression');
    return ast;
}

// ── Evaluator ──────────────────────────────────────────

function walkPath(segments, runState) {
    let cur = runState;
    for (let i = 0; i < segments.length; i++) {
        if (cur == null) return undefined;
        const s = segments[i];
        if (s.kind === 'name') {
            cur = (typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, s.v)) ? cur[s.v] : undefined;
        } else {
            const k = evalNode(s.expr, runState);
            if (cur == null) return undefined;
            cur = cur[k];
        }
    }
    return cur;
}

function evalNode(n, ctx) {
    switch (n.kind) {
        case 'num': return n.v;
        case 'str': return n.v;
        case 'bool': return n.v;
        case 'null': return null;
        case 'path': return walkPath(n.segments, ctx);
        case 'unop': {
            const v = evalNode(n.a, ctx);
            if (n.op === '!') return !v;
            if (n.op === '-') return -v;
            if (n.op === '+') return +v;
            return undefined;
        }
        case 'binop': {
            // Short-circuit for logical ops
            if (n.op === '&&') return evalNode(n.a, ctx) && evalNode(n.b, ctx);
            if (n.op === '||') return evalNode(n.a, ctx) || evalNode(n.b, ctx);
            const a = evalNode(n.a, ctx);
            const b = evalNode(n.b, ctx);
            switch (n.op) {
                case '+': return a + b;
                case '-': return a - b;
                case '*': return a * b;
                case '/': return a / b;
                case '%': return a % b;
                case '==': return a == b;       // eslint-disable-line eqeqeq
                case '!=': return a != b;       // eslint-disable-line eqeqeq
                case '===': return a === b;
                case '!==': return a !== b;
                case '<': return a < b;
                case '<=': return a <= b;
                case '>': return a > b;
                case '>=': return a >= b;
                default: throw new Error(`Unknown operator: ${n.op}`);
            }
        }
        case 'ternary': return evalNode(n.cond, ctx) ? evalNode(n.a, ctx) : evalNode(n.b, ctx);
        default: throw new Error(`Unknown node kind: ${n.kind}`);
    }
}

/**
 * Compile and evaluate an expression against a runState root object.
 * Caller can pre-compile via parseExpr(src) and pass the AST.
 */
function evaluate(src, runState) {
    const ast = typeof src === 'string' ? parse(tokenize(src)) : src;
    return evalNode(ast, runState || {});
}

function parseExpr(src) {
    return parse(tokenize(src));
}

module.exports = { evaluate, parseExpr };
